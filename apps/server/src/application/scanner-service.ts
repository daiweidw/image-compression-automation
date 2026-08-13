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

async function sha256(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    signal.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function relativePathKey(relativePath: string): string {
  const normalized = relativePath.normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function* walk(root: string, recursive: boolean, signal: AbortSignal): AsyncGenerator<string> {
  signal.throwIfAborted();
  const directory = await fsp.opendir(root);
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && recursive) yield* walk(absolute, recursive, signal);
    else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) yield absolute;
  }
}

export class ScannerService {
  private current: Promise<ScanState> | null = null;
  private controller: AbortController | null = null;
  private active = true;

  constructor(private readonly db: Database.Database) {}

  start(mode: "incremental" | "force_hash" = "incremental"): ScanState {
    if (!this.active) throw new AppError("APP_SHUTTING_DOWN", "应用正在退出，不能开始扫描", 503);
    const workspace = this.getWorkspace();
    if (!workspace) throw new AppError("SETTINGS_REQUIRED", "请先配置原图目录和结果目录", 409);
    if (this.current) return this.getCurrent();

    const id = ulid();
    const startedAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO scan_runs (id, workspace_id, mode, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`
    ).run(id, workspace.id, mode, startedAt);
    const controller = new AbortController();
    this.controller = controller;
    this.current = this.run(id, workspace, mode, controller.signal).finally(() => {
      this.current = null;
      this.controller = null;
    });
    return this.getCurrent();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.controller?.abort();
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

  private async run(id: string, workspace: WorkspaceRow, mode: "incremental" | "force_hash", signal: AbortSignal): Promise<ScanState> {
    let discovered = 0;
    let processed = 0;
    let warnings = 0;
    try {
      this.db.prepare("UPDATE image_entries SET present = 0 WHERE workspace_id = ?").run(workspace.id);
      for await (const absolute of walk(workspace.source_real_path, Boolean(workspace.recursive), signal)) {
        signal.throwIfAborted();
        discovered += 1;
        const relative = path.relative(workspace.source_real_path, absolute);
        const now = new Date().toISOString();
        const existing = this.db.prepare(
          "SELECT id, source_size, source_mtime_ns, source_hash FROM image_entries WHERE workspace_id=? AND relative_path_key=?"
        ).get(workspace.id, relativePathKey(relative)) as any;

        try {
          const stat = await fsp.lstat(absolute, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const size = Number(stat.size);
          const mtimeNs = stat.mtimeNs.toString();
          const metadata = await sharp(absolute, { failOn: "error" }).metadata();
          const format = metadata.format ?? "";
          const supported = supportedFormats.has(format);
          const hash =
            mode === "incremental" && existing?.source_size === size && existing?.source_mtime_ns === mtimeNs && existing.source_hash
              ? existing.source_hash
              : await sha256(absolute, signal);
          const imageId = existing?.id ?? ulid();
          this.db.prepare(
            `INSERT INTO image_entries (
              id, workspace_id, relative_path, relative_path_key, filename, extension, mime_type,
              width, height, source_size, source_mtime_ns, source_hash, supported, present,
              last_seen_scan_id, scan_error_code, scan_error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)
            ON CONFLICT(workspace_id, relative_path_key) DO UPDATE SET
              relative_path=excluded.relative_path, filename=excluded.filename, extension=excluded.extension,
              mime_type=excluded.mime_type, width=excluded.width, height=excluded.height,
              source_size=excluded.source_size, source_mtime_ns=excluded.source_mtime_ns,
              source_hash=excluded.source_hash, supported=excluded.supported, present=1,
              last_seen_scan_id=excluded.last_seen_scan_id, scan_error_code=NULL,
              scan_error_message=NULL, updated_at=excluded.updated_at`
          ).run(
            imageId,
            workspace.id,
            relative,
            relativePathKey(relative),
            path.basename(relative),
            path.extname(relative).slice(1).toLowerCase(),
            format ? `image/${format === "jpeg" ? "jpeg" : format}` : null,
            metadata.width ?? null,
            metadata.height ?? null,
            size,
            mtimeNs,
            hash,
            Number(supported),
            id,
            now,
            now
          );
        } catch (error) {
          warnings += 1;
          const imageId = existing?.id ?? ulid();
          this.db.prepare(
            `INSERT INTO image_entries (
              id, workspace_id, relative_path, relative_path_key, filename, extension, mime_type,
              width, height, source_size, source_mtime_ns, source_hash, supported, present,
              last_seen_scan_id, scan_error_code, scan_error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, '0', NULL, 0, 1, ?, 'SCAN_ERROR', ?, ?, ?)
            ON CONFLICT(workspace_id, relative_path_key) DO UPDATE SET present=1, supported=0,
              last_seen_scan_id=excluded.last_seen_scan_id, scan_error_code='SCAN_ERROR',
              scan_error_message=excluded.scan_error_message, updated_at=excluded.updated_at`
          ).run(imageId, workspace.id, relative, relativePathKey(relative), path.basename(relative), path.extname(relative).slice(1).toLowerCase(), id, errorMessage(error), now, now);
        }
        processed += 1;
        if (processed % 10 === 0) {
          this.db.prepare(
            "UPDATE scan_runs SET discovered_count=?, processed_count=?, warning_count=? WHERE id=?"
          ).run(discovered, processed, warnings, id);
        }
      }
      const finishedAt = new Date().toISOString();
      this.db.prepare(
        `UPDATE scan_runs SET status='succeeded', discovered_count=?, processed_count=?,
         warning_count=?, finished_at=? WHERE id=?`
      ).run(discovered, processed, warnings, finishedAt, id);
    } catch (error) {
      const shuttingDown = signal.aborted;
      this.db.prepare(
        `UPDATE scan_runs SET status='failed', discovered_count=?, processed_count=?, warning_count=?,
         error_code=?, error_message=?, finished_at=? WHERE id=?`
      ).run(
        discovered,
        processed,
        warnings,
        shuttingDown ? "APP_SHUTDOWN" : "SCAN_FAILED",
        shuttingDown ? "应用退出，扫描已中断" : errorMessage(error),
        new Date().toISOString(),
        id
      );
    }
    return this.getCurrent();
  }
}
