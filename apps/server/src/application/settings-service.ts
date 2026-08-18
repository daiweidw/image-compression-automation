import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { OutputConflictStrategy, SettingsResponse, UpdateSettingsRequest } from "@ica/contracts";
import { AppError } from "../errors.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { TinyPngKeyService } from "./tinypng-key-service.js";

export interface StoredSettings {
  sourceDir: string;
  outputMode: "automatic" | "custom";
  outputDir: string;
  autoCompressOnImport: boolean;
  recursive: boolean;
  compressionConcurrency: number;
  conflictStrategy: OutputConflictStrategy;
}

export class SettingsService {
  private readonly settingsPath: string;
  private cache: StoredSettings | null = null;
  private defaultOutputDir = "";
  private sessionOutputDirectory: () => string | null = () => null;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly appDataDir: string,
    private readonly db: Database.Database,
    private readonly keys: TinyPngKeyService,
    private readonly pathPolicy: PathPolicy
  ) {
    this.settingsPath = path.join(appDataDir, "settings.json");
  }

  async load(): Promise<StoredSettings | null> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.settingsPath, "utf8")) as Partial<StoredSettings>;
      if (!parsed.sourceDir || !parsed.outputDir) throw new AppError("INVALID_SETTINGS", "本地设置文件内容无效", 500);
      const outputMode = parsed.outputMode ?? (this.samePath(parsed.outputDir, this.defaultOutputDir) ? "automatic" : "custom");
      const normalized: StoredSettings = {
        sourceDir: parsed.sourceDir,
        outputMode,
        outputDir: parsed.outputDir,
        autoCompressOnImport: parsed.autoCompressOnImport ?? false,
        recursive: parsed.recursive ?? true,
        compressionConcurrency: parsed.compressionConcurrency ?? 2,
        conflictStrategy: parsed.conflictStrategy ?? "suffix"
      };
      this.cache = normalized;
      if (parsed.outputMode === undefined || parsed.autoCompressOnImport === undefined) {
        try {
          await this.writeSettingsFile(normalized);
        } catch (error) {
          this.cache = null;
          throw error;
        }
      }
      return normalized;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async ensureDefaults(defaultOutputDir: string): Promise<void> {
    this.defaultOutputDir = path.resolve(defaultOutputDir);
    const existing = await this.load();
    if (existing) {
      if (existing.autoCompressOnImport && !(await this.keys.hasActiveKey())) {
        await this.setAutoCompressOnImport(false);
      }
      return;
    }
    const sessionSourceDir = path.join(this.appDataDir, "session-source");
    await fs.mkdir(sessionSourceDir, { recursive: true, mode: 0o700 });
    await this.update({
      outputMode: "automatic",
      outputDir: defaultOutputDir,
      recursive: true,
      compressionConcurrency: 2,
      conflictStrategy: "suffix",
      createOutputDir: true
    });
  }

  async getResponse(): Promise<SettingsResponse> {
    const settings = await this.load();
    const active = this.keys.activeRow();
    const hasActiveKey = await this.keys.hasActiveKey();
    return {
      configured: settings !== null,
      outputMode: settings?.outputMode ?? "automatic",
      outputDir: settings?.outputDir ?? "",
      sessionOutputDir: settings?.outputMode === "automatic" ? this.sessionOutputDirectory() : null,
      autoCompressOnImport: settings?.autoCompressOnImport ?? false,
      recursive: settings?.recursive ?? true,
      compressionConcurrency: settings?.compressionConcurrency ?? 2,
      conflictStrategy: settings?.conflictStrategy ?? "suffix",
      apiKey: {
        configured: hasActiveKey,
        activeKeyId: active?.id ?? null,
        activeKeyName: active?.name ?? null,
        canCompress: Boolean(hasActiveKey && active?.last_validation_status === "valid" && active.quota_state !== "exhausted"),
        lastValidationStatus: active?.last_validation_status ?? "unknown",
        lastValidatedAt: active?.last_validated_at ?? null,
        compressionCount: active?.compression_count ?? null
      }
    };
  }

  async update(input: UpdateSettingsRequest): Promise<SettingsResponse> {
    return this.serializedWrite(() => this.updateLocked(input));
  }

  private async updateLocked(input: UpdateSettingsRequest): Promise<SettingsResponse> {
    if (input.compressionConcurrency < 1 || input.compressionConcurrency > 5) {
      throw new AppError("INVALID_CONCURRENCY", "同时压缩数量必须在 1 到 5 之间");
    }
    const currentSettings = await this.load();
    const sessionSourceDir = currentSettings?.sourceDir ?? path.join(this.appDataDir, "session-source");
    await fs.mkdir(sessionSourceDir, { recursive: true, mode: 0o700 });
    const requestedOutputDir = input.outputMode === "automatic" ? this.defaultOutputDir : input.outputDir;
    if (!requestedOutputDir) throw new AppError("OUTPUT_REQUIRED", "请选择结果保存目录");
    const roots = await this.pathPolicy.validateRoots(sessionSourceDir, requestedOutputDir, input.createOutputDir);
    const currentWorkspace = this.db.prepare(
      "SELECT source_real_path, output_real_path FROM workspaces WHERE active=1 LIMIT 1"
    ).get() as { source_real_path: string; output_real_path: string } | undefined;
    const rootsChanged = Boolean(
      currentWorkspace &&
        (currentWorkspace.source_real_path !== roots.sourceRealPath || currentWorkspace.output_real_path !== roots.outputRealPath)
    );
    const outputModeChanged = Boolean(currentSettings && currentSettings.outputMode !== input.outputMode);
    if (rootsChanged || outputModeChanged) {
      const activeJobs = this.db.prepare(
        "SELECT COUNT(*) AS count FROM job_items WHERE status IN ('queued','running')"
      ).get() as { count: number };
      if (activeJobs.count > 0) {
        throw new AppError("ACTIVE_JOBS", "仍有压缩任务活动，完成或取消后再切换目录", 409);
      }
    }

    const next: StoredSettings = {
      sourceDir: roots.sourceDir,
      outputMode: input.outputMode,
      outputDir: roots.outputDir,
      autoCompressOnImport: currentSettings?.autoCompressOnImport ?? false,
      recursive: input.recursive,
      compressionConcurrency: input.compressionConcurrency,
      conflictStrategy: input.conflictStrategy
    };
    await fs.mkdir(this.appDataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsPath}.${ulid()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.settingsPath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if (currentSettings) {
        await fs.writeFile(this.settingsPath, JSON.stringify(currentSettings, null, 2), { encoding: "utf8", mode: 0o600 });
      } else {
        await fs.rm(this.settingsPath, { force: true });
      }
      throw error;
    }

    this.cache = next;
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      "SELECT id, source_real_path, output_real_path FROM workspaces WHERE active = 1 LIMIT 1"
    ).get() as { id: string; source_real_path: string; output_real_path: string } | undefined;
    if (existing) {
      this.db.prepare(
        `UPDATE workspaces SET source_dir=?, source_real_path=?, output_dir=?, output_real_path=?,
         recursive=?, compression_concurrency=?, watch_enabled=?, auto_compress=?, conflict_strategy=?, updated_at=? WHERE id=?`
      ).run(next.sourceDir, roots.sourceRealPath, next.outputDir, roots.outputRealPath, Number(next.recursive), next.compressionConcurrency, 0, 0, next.conflictStrategy, now, existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO workspaces (id, source_dir, source_real_path, output_dir, output_real_path,
         recursive, compression_concurrency, watch_enabled, auto_compress, conflict_strategy, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(ulid(), next.sourceDir, roots.sourceRealPath, next.outputDir, roots.outputRealPath, Number(next.recursive), next.compressionConcurrency, 0, 0, next.conflictStrategy, now, now);
    }
    return this.getResponse();
  }

  setSessionOutputDirectoryProvider(provider: () => string | null): void {
    this.sessionOutputDirectory = provider;
  }

  async setAutoCompressOnImport(enabled: boolean): Promise<SettingsResponse> {
    return this.serializedWrite(() => this.setAutoCompressOnImportLocked(enabled));
  }

  private async setAutoCompressOnImportLocked(enabled: boolean): Promise<SettingsResponse> {
    const current = await this.load();
    if (!current) throw new AppError("SETTINGS_REQUIRED", "应用尚未完成初始化", 409);
    if (enabled && !(await this.keys.hasActiveKey())) {
      throw new AppError("API_KEY_REQUIRED", "请先在设置中配置 TinyPNG API Key", 409);
    }
    if (current.autoCompressOnImport === enabled) return this.getResponse();
    const next = { ...current, autoCompressOnImport: enabled };
    await this.writeSettingsFile(next);
    this.cache = next;
    return this.getResponse();
  }

  private samePath(left: string, right: string): boolean {
    if (!right) return false;
    const normalize = (candidate: string) => {
      const resolved = path.resolve(candidate).normalize("NFC");
      return process.platform === "darwin" || process.platform === "win32"
        ? resolved.toLocaleLowerCase("en-US")
        : resolved;
    };
    return normalize(left) === normalize(right);
  }

  private async writeSettingsFile(settings: StoredSettings): Promise<void> {
    await fs.mkdir(this.appDataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsPath}.${ulid()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.settingsPath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
