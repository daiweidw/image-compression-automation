import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import sharp from "sharp";
import { ulid } from "ulid";
import type { ScanState } from "@ica/contracts";
import { AppError, errorMessage } from "../errors.js";

const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
const supportedFormats = new Set(["png", "jpeg", "webp", "avif"]);

interface WorkspaceRow {
  id: string;
  source_real_path: string;
  recursive: number;
}

export interface ScanInput {
  paths: string[];
  recursive?: boolean;
  sourceLabel?: string;
}

export interface ScanImageEvent {
  scanId: string;
  imageId: string;
  newlyAdded: boolean;
}

interface DiscoveredFile {
  absolutePath: string;
  displayPath: string;
}

async function sha256(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    signal.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function pathKey(candidate: string): string {
  const normalized = path.resolve(candidate).normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function* walkDirectory(root: string, current: string, recursive: boolean, signal: AbortSignal): AsyncGenerator<DiscoveredFile> {
  signal.throwIfAborted();
  const directory = await fsp.opendir(current);
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && recursive) {
      yield* walkDirectory(root, absolutePath, recursive, signal);
    } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
      yield { absolutePath, displayPath: path.relative(root, absolutePath) };
    }
  }
}

async function* discover(inputs: string[], recursive: boolean, signal: AbortSignal): AsyncGenerator<DiscoveredFile> {
  for (const candidate of inputs) {
    signal.throwIfAborted();
    const absolutePath = await fsp.realpath(path.resolve(candidate));
    const stat = await fsp.lstat(absolutePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      yield* walkDirectory(absolutePath, absolutePath, recursive, signal);
    } else if (stat.isFile()) {
      yield { absolutePath, displayPath: path.basename(absolutePath) };
    }
  }
}

export class ScannerService {
  private current: Promise<ScanState> | null = null;
  private controller: AbortController | null = null;
  private active = true;
  private onImage: (event: ScanImageEvent) => Promise<void> = async () => undefined;

  constructor(private readonly db: Database.Database) {}

  setOnImage(listener: (event: ScanImageEvent) => Promise<void>): void {
    this.onImage = listener;
  }

  start(inputOrMode: ScanInput | "incremental" | "force_hash" = "incremental", requestedMode: "incremental" | "force_hash" = "incremental"): ScanState {
    if (!this.active) throw new AppError("APP_SHUTTING_DOWN", "应用正在退出，不能开始扫描", 503);
    const workspace = this.getWorkspace();
    if (!workspace) throw new AppError("SETTINGS_REQUIRED", "应用尚未完成初始化", 409);
    if (this.current) return this.getCurrent();

    const input = typeof inputOrMode === "string"
      ? { paths: [workspace.source_real_path], recursive: Boolean(workspace.recursive), sourceLabel: path.basename(workspace.source_real_path) }
      : inputOrMode;
    const mode = typeof inputOrMode === "string" ? inputOrMode : requestedMode;
    const paths = [...new Set(input.paths.map((candidate) => path.resolve(candidate)))];
    if (paths.length === 0 || paths.length > 1_000) throw new AppError("INVALID_SCAN_PATHS", "请选择要导入的图片或文件夹");

    const id = ulid();
    const startedAt = new Date().toISOString();
    const sourceLabel = input.sourceLabel?.trim() || (paths.length === 1 ? path.basename(paths[0]!) : `${paths.length} 个项目`);
    this.db.prepare(
      `INSERT INTO scan_runs (id, workspace_id, mode, source_label, status, started_at)
       VALUES (?, ?, ?, ?, 'running', ?)`
    ).run(id, workspace.id, mode, sourceLabel, startedAt);
    const controller = new AbortController();
    this.controller = controller;
    this.current = this.run(id, workspace, paths, input.recursive ?? true, mode, controller.signal).finally(() => {
      this.current = null;
      this.controller = null;
    });
    return this.getCurrent();
  }

  async cancel(): Promise<ScanState> {
    if (!this.current || !this.controller) return this.getCurrent();
    this.controller.abort("USER_STOPPED");
    return await this.current;
  }

  async stop(): Promise<void> {
    this.active = false;
    this.controller?.abort("APP_SHUTDOWN");
    if (this.current) await this.current;
  }

  async waitForIdle(): Promise<ScanState> {
    return this.current ? await this.current : this.getCurrent();
  }

  getCurrent(): ScanState {
    const row = this.db.prepare("SELECT * FROM scan_runs ORDER BY started_at DESC LIMIT 1").get() as any;
    if (!row) {
      return {
        id: null,
        status: "idle",
        sourceLabel: null,
        discoveredCount: 0,
        processedCount: 0,
        warningCount: 0,
        errorMessage: null,
        startedAt: null,
        finishedAt: null
      };
    }
    return {
      id: row.id,
      status: row.status,
      sourceLabel: row.source_label,
      discoveredCount: row.discovered_count,
      processedCount: row.processed_count,
      warningCount: row.warning_count,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      finishedAt: row.finished_at
    };
  }

  private getWorkspace(): WorkspaceRow | undefined {
    return this.db.prepare("SELECT id, source_real_path, recursive FROM workspaces WHERE active = 1 LIMIT 1").get() as WorkspaceRow | undefined;
  }

  private async run(id: string, workspace: WorkspaceRow, inputs: string[], recursive: boolean, mode: "incremental" | "force_hash", signal: AbortSignal): Promise<ScanState> {
    let discoveredCount = 0;
    let processedCount = 0;
    let warningCount = 0;
    const seen = new Set<string>();
    const updateProgress = () => {
      this.db.prepare("UPDATE scan_runs SET discovered_count=?, processed_count=?, warning_count=? WHERE id=?")
        .run(discoveredCount, processedCount, warningCount, id);
    };

    try {
      for await (const discovered of discover(inputs, recursive, signal)) {
        signal.throwIfAborted();
        const absoluteKey = pathKey(discovered.absolutePath);
        if (seen.has(absoluteKey)) continue;
        seen.add(absoluteKey);
        discoveredCount += 1;

        if (!supportedExtensions.has(path.extname(discovered.absolutePath).toLowerCase())) {
          warningCount += 1;
          processedCount += 1;
          updateProgress();
          continue;
        }

        const now = new Date().toISOString();
        const existing = this.db.prepare(
          "SELECT id, source_size, source_mtime_ns, source_hash, present FROM image_entries WHERE workspace_id=? AND relative_path_key=?"
        ).get(workspace.id, absoluteKey) as any;

        let imageEvent: ScanImageEvent | null = null;
        try {
          const stat = await fsp.lstat(discovered.absolutePath, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const size = Number(stat.size);
          const mtimeNs = stat.mtimeNs.toString();
          const metadata = await sharp(discovered.absolutePath, { failOn: "error" }).metadata();
          const format = metadata.format ?? "";
          const supported = supportedFormats.has(format);
          const hash = mode === "incremental" && existing?.source_size === size && existing?.source_mtime_ns === mtimeNs && existing.source_hash
            ? existing.source_hash
            : await sha256(discovered.absolutePath, signal);
          const imageId = existing?.id ?? ulid();
          this.db.prepare(
            `INSERT INTO image_entries (
              id, workspace_id, relative_path, relative_path_key, source_absolute_path, filename, extension, mime_type,
              width, height, source_size, source_mtime_ns, source_hash, supported, present,
              last_seen_scan_id, scan_error_code, scan_error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)
            ON CONFLICT(workspace_id, relative_path_key) DO UPDATE SET
              relative_path=excluded.relative_path, source_absolute_path=excluded.source_absolute_path,
              filename=excluded.filename, extension=excluded.extension, mime_type=excluded.mime_type,
              width=excluded.width, height=excluded.height, source_size=excluded.source_size,
              source_mtime_ns=excluded.source_mtime_ns, source_hash=excluded.source_hash,
              supported=excluded.supported, present=1, last_seen_scan_id=excluded.last_seen_scan_id,
              scan_error_code=NULL, scan_error_message=NULL, updated_at=excluded.updated_at`
          ).run(imageId, workspace.id, discovered.displayPath, absoluteKey, discovered.absolutePath,
            path.basename(discovered.absolutePath), path.extname(discovered.absolutePath).slice(1).toLowerCase(),
            format ? `image/${format === "jpeg" ? "jpeg" : format}` : null, metadata.width ?? null,
            metadata.height ?? null, size, mtimeNs, hash, Number(supported), id, now, now);
          if (supported) imageEvent = { scanId: id, imageId, newlyAdded: existing?.present !== 1 };
        } catch (error) {
          if (signal.aborted) throw error;
          warningCount += 1;
          const imageId = existing?.id ?? ulid();
          this.db.prepare(
            `INSERT INTO image_entries (
              id, workspace_id, relative_path, relative_path_key, source_absolute_path, filename, extension, mime_type,
              width, height, source_size, source_mtime_ns, source_hash, supported, present,
              last_seen_scan_id, scan_error_code, scan_error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, '0', NULL, 0, 1, ?, 'SCAN_ERROR', ?, ?, ?)
            ON CONFLICT(workspace_id, relative_path_key) DO UPDATE SET present=1,
              source_absolute_path=excluded.source_absolute_path, supported=0,
              last_seen_scan_id=excluded.last_seen_scan_id, scan_error_code='SCAN_ERROR',
              scan_error_message=excluded.scan_error_message, updated_at=excluded.updated_at`
          ).run(imageId, workspace.id, discovered.displayPath, absoluteKey, discovered.absolutePath,
            path.basename(discovered.absolutePath), path.extname(discovered.absolutePath).slice(1).toLowerCase(),
            id, errorMessage(error), now, now);
        }
        if (imageEvent) await this.onImage(imageEvent).catch(() => undefined);
        processedCount += 1;
        updateProgress();
      }
      this.db.prepare(
        `UPDATE scan_runs SET status='succeeded', discovered_count=?, processed_count=?,
         warning_count=?, finished_at=? WHERE id=?`
      ).run(discoveredCount, processedCount, warningCount, new Date().toISOString(), id);
    } catch (error) {
      const userStopped = signal.aborted && signal.reason === "USER_STOPPED";
      const status = userStopped ? "stopped" : "failed";
      const code = userStopped ? "USER_STOPPED" : signal.aborted ? "APP_SHUTDOWN" : "SCAN_FAILED";
      const message = userStopped ? "已停止扫描，已发现的图片已保留" : signal.aborted ? "应用退出，扫描已中断" : errorMessage(error);
      this.db.prepare(
        `UPDATE scan_runs SET status=?, discovered_count=?, processed_count=?, warning_count=?,
         error_code=?, error_message=?, finished_at=? WHERE id=?`
      ).run(status, discoveredCount, processedCount, warningCount, code, message, new Date().toISOString(), id);
    }
    return this.getCurrent();
  }
}
