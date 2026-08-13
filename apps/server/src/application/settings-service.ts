import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { SettingsResponse, UpdateSettingsRequest } from "@ica/contracts";
import { AppError } from "../errors.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";

interface StoredSettings {
  sourceDir: string;
  outputDir: string;
  recursive: boolean;
  compressionConcurrency: number;
}

export interface KeyValidator {
  validateKey(key: string): Promise<{ valid: boolean; compressionCount: number | null }>;
}

export class SettingsService {
  private readonly settingsPath: string;
  private cache: StoredSettings | null = null;

  constructor(
    private readonly appDataDir: string,
    private readonly db: Database.Database,
    private readonly secrets: FileSecretStore,
    private readonly pathPolicy: PathPolicy,
    private readonly keyValidator: KeyValidator
  ) {
    this.settingsPath = path.join(appDataDir, "settings.json");
  }

  async load(): Promise<StoredSettings | null> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.settingsPath, "utf8")) as StoredSettings;
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getResponse(): Promise<SettingsResponse> {
    const settings = await this.load();
    const usage = this.db.prepare("SELECT * FROM api_usage WHERE id = 1").get() as any;
    return {
      configured: settings !== null,
      sourceDir: settings?.sourceDir ?? "",
      outputDir: settings?.outputDir ?? "",
      recursive: settings?.recursive ?? true,
      compressionConcurrency: settings?.compressionConcurrency ?? 2,
      apiKey: {
        configured: await this.secrets.hasTinyPngKey(),
        lastValidationStatus: usage.last_validation_status,
        lastValidatedAt: usage.last_validated_at,
        compressionCount: usage.compression_count
      }
    };
  }

  async testKey(candidate?: string): Promise<{ valid: boolean; compressionCount: number | null }> {
    const key = candidate?.trim() || (await this.secrets.getTinyPngKey());
    if (!key) throw new AppError("API_KEY_REQUIRED", "请先填写 TinyPNG API Key");
    const result = await this.keyValidator.validateKey(key);
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE api_usage SET compression_count = ?, last_validation_status = ?,
       last_validated_at = ?, updated_at = ? WHERE id = 1`
    ).run(result.compressionCount, result.valid ? "valid" : "invalid", now, now);
    return result;
  }

  async update(input: UpdateSettingsRequest): Promise<SettingsResponse> {
    if (input.compressionConcurrency < 1 || input.compressionConcurrency > 5) {
      throw new AppError("INVALID_CONCURRENCY", "同时压缩数量必须在 1 到 5 之间");
    }
    const roots = await this.pathPolicy.validateRoots(input.sourceDir, input.outputDir, input.createOutputDir);
    const currentSettings = await this.load();
    const currentWorkspace = this.db.prepare(
      "SELECT source_real_path, output_real_path FROM workspaces WHERE active=1 LIMIT 1"
    ).get() as { source_real_path: string; output_real_path: string } | undefined;
    const rootsChanged = Boolean(
      currentWorkspace &&
        (currentWorkspace.source_real_path !== roots.sourceRealPath || currentWorkspace.output_real_path !== roots.outputRealPath)
    );
    if (rootsChanged) {
      const activeJobs = this.db.prepare(
        "SELECT COUNT(*) AS count FROM job_items WHERE status IN ('queued','running')"
      ).get() as { count: number };
      if (activeJobs.count > 0) {
        throw new AppError("ACTIVE_JOBS", "仍有压缩任务活动，完成或取消后再切换目录", 409);
      }
    }

    if (input.apiKeyAction === "replace") {
      if (!input.apiKey?.trim()) throw new AppError("API_KEY_REQUIRED", "请输入新的 TinyPNG API Key");
      const result = await this.testKey(input.apiKey);
      if (!result.valid) throw new AppError("INVALID_API_KEY", "TinyPNG API Key 无效");
    }

    const next: StoredSettings = {
      sourceDir: roots.sourceDir,
      outputDir: roots.outputDir,
      recursive: input.recursive,
      compressionConcurrency: input.compressionConcurrency
    };
    const previousKey = input.apiKeyAction === "replace" ? await this.secrets.getTinyPngKey() : null;
    await fs.mkdir(this.appDataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsPath}.${ulid()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (input.apiKeyAction === "replace" && input.apiKey) await this.secrets.setTinyPngKey(input.apiKey);
      await fs.rename(temporary, this.settingsPath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if (input.apiKeyAction === "replace") {
        if (previousKey) await this.secrets.setTinyPngKey(previousKey);
        else await this.secrets.deleteTinyPngKey();
      }
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
    const sameRoots = existing?.source_real_path === roots.sourceRealPath && existing.output_real_path === roots.outputRealPath;
    if (existing && sameRoots) {
      this.db.prepare(
        `UPDATE workspaces SET source_dir=?, source_real_path=?, output_dir=?, output_real_path=?,
         recursive=?, compression_concurrency=?, updated_at=? WHERE id=?`
      ).run(next.sourceDir, roots.sourceRealPath, next.outputDir, roots.outputRealPath, Number(next.recursive), next.compressionConcurrency, now, existing.id);
    } else {
      const changeWorkspace = this.db.transaction(() => {
        this.db.prepare("UPDATE workspaces SET active=0, updated_at=? WHERE active=1").run(now);
        this.db.prepare(
          `INSERT INTO workspaces (id, source_dir, source_real_path, output_dir, output_real_path,
           recursive, compression_concurrency, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(ulid(), next.sourceDir, roots.sourceRealPath, next.outputDir, roots.outputRealPath, Number(next.recursive), next.compressionConcurrency, now, now);
      });
      changeWorkspace();
    }
    return this.getResponse();
  }

  async deleteKey(): Promise<void> {
    const running = this.db.prepare("SELECT COUNT(*) AS count FROM job_items WHERE status = 'running'").get() as { count: number };
    if (running.count > 0) throw new AppError("ACTIVE_JOBS", "仍有压缩任务运行，完成后再删除 API Key", 409);
    await this.secrets.deleteTinyPngKey();
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE api_usage SET last_validation_status='unknown', last_validated_at=NULL,
       compression_count=NULL, updated_at=? WHERE id=1`
    ).run(now);
  }
}
