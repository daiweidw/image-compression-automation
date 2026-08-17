import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { JobView } from "@ica/contracts";
import { AppError, errorMessage } from "../errors.js";
import type { SecretStore } from "../infrastructure/secret-store.js";
import type { TinyPngResult } from "../infrastructure/tinypng-adapter.js";
import { OutputWriter } from "../infrastructure/output-writer.js";
import { ImageService } from "./image-service.js";
import { TinyPngUsageService } from "./tinypng-usage-service.js";
import type { SessionOutputService } from "./session-output-service.js";

async function fileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function uniqueOutputPaths(images: Array<{ relativePath: string; filename: string }>): string[] {
  const used = new Set<string>();
  return images.map((image) => {
    const normalized = path.normalize(image.relativePath);
    const safePath = path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)
      ? image.filename
      : normalized;
    const directory = path.dirname(safePath);
    const extension = path.extname(safePath);
    const stem = path.basename(safePath, extension);
    for (let index = 1; index <= 10_000; index += 1) {
      const filename = index === 1 ? `${stem}${extension}` : `${stem}-${index}${extension}`;
      const candidate = directory === "." ? filename : path.join(directory, filename);
      const key = process.platform === "darwin" || process.platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
      if (!used.has(key)) {
        used.add(key);
        return candidate;
      }
    }
    throw new AppError("OUTPUT_NAME_CONFLICT", `无法为 ${image.filename} 分配输出文件名`, 409);
  });
}

export interface CompressionAdapter {
  compress(sourcePath: string, key: string, signal?: AbortSignal): Promise<TinyPngResult>;
}

export class JobService {
  private active = false;
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private onChange: (jobId: string) => void = () => undefined;
  private createLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database.Database,
    private readonly images: ImageService,
    private readonly secrets: SecretStore,
    private readonly tinypng: CompressionAdapter,
    private readonly writer: OutputWriter,
    private readonly outputs: SessionOutputService,
    private readonly usage?: TinyPngUsageService
  ) {}

  setOnChange(listener: (jobId: string) => void): void {
    this.onChange = listener;
  }

  start(): void {
    this.active = true;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getActiveCounts(): { queued: number; running: number } {
    const counts = this.db.prepare(
      `SELECT
       SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running
       FROM job_items`
    ).get() as { queued: number | null; running: number | null };
    return { queued: Number(counts.queued ?? 0), running: Number(counts.running ?? 0) };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.stop();
    const queuedJobs = this.db.prepare(
      "SELECT DISTINCT job_id FROM job_items WHERE status='queued'"
    ).all() as Array<{ job_id: string }>;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE job_items SET status='cancelled', error_code='APP_SHUTDOWN',
       error_message='应用退出，排队任务已取消', finished_at=? WHERE status='queued'`
    ).run(now);
    for (const { job_id: jobId } of queuedJobs) this.refreshJob(jobId);
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }

  async create(clientRequestId: string, imageIds: string[], confirmRecompress: boolean, outputRootOverride?: string): Promise<JobView> {
    const previous = this.createLock;
    let release!: () => void;
    this.createLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.createLocked(clientRequestId, imageIds, confirmRecompress, outputRootOverride);
    } finally {
      release();
    }
  }

  private async createLocked(clientRequestId: string, imageIds: string[], confirmRecompress: boolean, outputRootOverride?: string): Promise<JobView> {
    if (!this.active || this.shutdownPromise) throw new AppError("APP_SHUTTING_DOWN", "应用正在退出，不能创建新任务", 503);
    if (!clientRequestId || imageIds.length === 0 || imageIds.length > 1000) {
      throw new AppError("INVALID_JOB", "请选择 1 至 1000 张图片");
    }
    if (!(await this.secrets.hasTinyPngKey())) throw new AppError("API_KEY_REQUIRED", "请先在设置中配置 TinyPNG API Key", 409);
    if (this.usage?.isExhausted()) throw new AppError("QUOTA_EXHAUSTED", "TinyPNG 本月免费额度已用尽", 409);
    const workspace = this.db.prepare("SELECT * FROM workspaces WHERE active=1 LIMIT 1").get() as any;
    if (!workspace) throw new AppError("SETTINGS_REQUIRED", "请先完成设置", 409);

    const existing = this.db.prepare(
      "SELECT id FROM compression_jobs WHERE workspace_id=? AND client_request_id=?"
    ).get(workspace.id, clientRequestId) as { id: string } | undefined;
    if (existing) return this.get(existing.id);

    const uniqueIds = [...new Set(imageIds)];
    const accepted: Array<{ id: string; hash: string; status: string; relativePath: string; filename: string }> = [];
    const needsConfirmation: string[] = [];
    for (const imageId of uniqueIds) {
      const image = await this.images.getById(imageId);
      if (["queued", "compressing", "unsupported"].includes(image.status)) continue;
      if (image.status === "compressed" && !confirmRecompress) {
        needsConfirmation.push(imageId);
        continue;
      }
      if (!image.source_hash) continue;
      accepted.push({ id: imageId, hash: image.source_hash, status: image.status, relativePath: image.relative_path, filename: image.filename });
    }
    if (needsConfirmation.length) {
      throw new AppError("RECOMPRESS_CONFIRMATION_REQUIRED", "选择中包含已压缩图片，请确认后重新提交", 409, { imageIds: needsConfirmation });
    }
    if (!accepted.length) throw new AppError("NO_COMPRESSIBLE_IMAGES", "所选图片当前无法压缩", 409);

    const jobId = ulid();
    const now = new Date().toISOString();
    const allocation = outputRootOverride === undefined
      ? await this.outputs.resolve()
      : { path: outputRootOverride, createdForSession: false };
    const outputRoot = allocation.path;
    const outputPaths = uniqueOutputPaths(accepted);
    const create = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO compression_jobs (id, workspace_id, client_request_id, output_root_path, status, total, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`
      ).run(jobId, workspace.id, clientRequestId, outputRoot, accepted.length, now);
      const insert = this.db.prepare(
        `INSERT INTO job_items (id, job_id, image_id, status, submitted_source_hash, output_relative_path, queued_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)`
      );
      for (const [index, image] of accepted.entries()) insert.run(ulid(), jobId, image.id, image.hash, outputPaths[index], now);
    });
    try {
      create();
    } catch (error) {
      if (allocation.createdForSession) await this.outputs.releaseIfUnused(outputRoot);
      if ((error as Error).message.includes("idx_one_active_image_job")) {
        throw new AppError("IMAGE_ALREADY_QUEUED", "部分图片已经在压缩队列中", 409);
      }
      throw error;
    }
    this.schedule(0);
    this.onChange(jobId);
    return this.get(jobId);
  }

  list(page = 1, pageSize = 20, status?: string, query?: string): { items: JobView[]; page: number; pageSize: number; total: number } {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (status) {
      conditions.push("cj.status=?");
      parameters.push(status);
    }
    if (query) {
      conditions.push("EXISTS(SELECT 1 FROM job_items ji JOIN image_entries i ON i.id=ji.image_id WHERE ji.job_id=cj.id AND i.relative_path LIKE ? ESCAPE '\\')");
      parameters.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) count FROM compression_jobs cj ${where}`).get(...parameters) as { count: number }).count;
    const rows = this.db.prepare(
      `SELECT cj.id FROM compression_jobs cj ${where} ORDER BY cj.created_at DESC LIMIT ? OFFSET ?`
    ).all(...parameters, pageSize, (page - 1) * pageSize) as Array<{ id: string }>;
    return { items: rows.map((row) => this.get(row.id)), page, pageSize, total };
  }

  get(id: string): JobView {
    const job = this.db.prepare("SELECT * FROM compression_jobs WHERE id=?").get(id) as any;
    if (!job) throw new AppError("JOB_NOT_FOUND", "压缩任务不存在", 404);
    const items = this.db.prepare(
      `SELECT ji.*, i.filename, i.relative_path FROM job_items ji
       JOIN image_entries i ON i.id=ji.image_id WHERE ji.job_id=? ORDER BY ji.queued_at`
    ).all(id) as any[];
    return {
      id: job.id,
      status: job.status,
      outputDir: job.output_root_path ?? "",
      total: job.total,
      succeeded: job.succeeded,
      failed: job.failed,
      cancelled: job.cancelled,
      skipped: job.skipped,
      inputBytes: job.input_bytes,
      outputBytes: job.output_bytes,
      createdAt: job.created_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      items: items.map((item) => ({
        id: item.id,
        imageId: item.image_id,
        filename: item.filename,
        relativePath: item.relative_path,
        status: item.status,
        inputSize: item.input_size,
        outputSize: item.output_size,
        savedBytes: item.saved_bytes,
        errorCode: item.error_code,
        errorMessage: item.error_message,
        attemptCount: item.attempt_count,
        startedAt: item.started_at,
        finishedAt: item.finished_at
      }))
    };
  }

  cancel(id: string): JobView {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE job_items SET status='cancelled', error_code='USER_CANCELLED',
       error_message='用户取消排队任务', finished_at=? WHERE job_id=? AND status='queued'`
    ).run(now, id);
    this.refreshJob(id);
    this.onChange(id);
    return this.get(id);
  }

  async retryItem(itemId: string): Promise<JobView> {
    const item = this.db.prepare(
      `SELECT ji.image_id, cj.output_root_path FROM job_items ji
       JOIN compression_jobs cj ON cj.id=ji.job_id WHERE ji.id=? AND ji.status='failed'`
    ).get(itemId) as { image_id: string; output_root_path: string | null } | undefined;
    if (!item) throw new AppError("ITEM_NOT_RETRYABLE", "该任务项不能重试", 409);
    return this.create(ulid(), [item.image_id], true, item.output_root_path ?? undefined);
  }

  private schedule(delay = 100): void {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delay);
  }

  private async pump(): Promise<void> {
    if (!this.active) return;
    if (this.usage?.isExhausted()) {
      this.failQueuedItems("QUOTA_EXHAUSTED", "TinyPNG 本月免费额度已用尽，请在额度恢复后手动重新压缩");
      return;
    }
    const workspace = this.db.prepare("SELECT compression_concurrency FROM workspaces WHERE active=1 LIMIT 1").get() as { compression_concurrency: number } | undefined;
    const configuredConcurrency = workspace?.compression_concurrency ?? 2;
    const remaining = this.usage?.remaining() ?? null;
    const concurrency = remaining == null ? configuredConcurrency : Math.min(configuredConcurrency, remaining);
    if (concurrency === 0) {
      this.failQueuedItems("QUOTA_EXHAUSTED", "TinyPNG 本月免费额度已用尽，请在额度恢复后手动重新压缩");
      return;
    }
    while (this.running < concurrency) {
      const item = this.claimNext();
      if (!item) break;
      this.running += 1;
      const controller = new AbortController();
      this.controllers.set(item.id, controller);
      const task = this.execute(item, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          this.tasks.delete(task);
          this.controllers.delete(item.id);
          this.running -= 1;
          this.schedule(0);
        });
      this.tasks.add(task);
    }
    if (this.running > 0 || this.db.prepare("SELECT 1 FROM job_items WHERE status='queued' LIMIT 1").get()) this.schedule(250);
  }

  private claimNext(): any | null {
    const row = this.db.prepare(
      `SELECT ji.*, cj.workspace_id, cj.output_root_path FROM job_items ji JOIN compression_jobs cj ON cj.id=ji.job_id
       WHERE ji.status='queued' ORDER BY ji.queued_at LIMIT 1`
    ).get() as any;
    if (!row) return null;
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE job_items SET status='running', started_at=? WHERE id=? AND status='queued'"
    ).run(now, row.id);
    if (result.changes !== 1) return null;
    this.db.prepare(
      "UPDATE compression_jobs SET status='running', started_at=COALESCE(started_at, ?) WHERE id=?"
    ).run(now, row.job_id);
    return row;
  }

  private async execute(item: any, signal: AbortSignal): Promise<void> {
    let affectedJobIds: string[] = [];
    try {
      signal.throwIfAborted();
      const { path: sourcePath, row } = await this.images.sourcePath(item.image_id);
      const beforeStat = await fsp.stat(sourcePath, { bigint: true });
      const beforeHash = await fileHash(sourcePath);
      signal.throwIfAborted();
      if (beforeHash !== item.submitted_source_hash) throw new AppError("SOURCE_CHANGED", "原图已变化，请重新扫描后再压缩");
      const key = await this.secrets.getTinyPngKey();
      if (!key) throw new AppError("API_KEY_REQUIRED", "TinyPNG API Key 已删除");

      this.db.prepare("UPDATE job_items SET attempt_count=1 WHERE id=?").run(item.id);
      const result = await this.tinypng.compress(sourcePath, key, signal);
      signal.throwIfAborted();

      const afterStat = await fsp.stat(sourcePath, { bigint: true });
      if (beforeStat.size !== afterStat.size || beforeStat.mtimeNs !== afterStat.mtimeNs) {
        throw new AppError("SOURCE_CHANGED_DURING_UPLOAD", "上传期间原图发生变化，结果未保存");
      }
      const outputRoot = item.output_root_path ?? row.workspace.output_real_path;
      const outputRelativePath = item.output_relative_path ?? row.relative_path;
      const written = await this.writer.write(outputRoot, outputRelativePath, result, false, "suffix");
      const now = new Date().toISOString();
      const finish = this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO compression_records (
            image_id, source_hash, source_size, output_relative_path, output_root_path, output_size, output_hash,
            output_mtime_ns, output_mime_type, compression_count, compressed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(image_id) DO UPDATE SET source_hash=excluded.source_hash,
            source_size=excluded.source_size, output_relative_path=excluded.output_relative_path,
            output_root_path=excluded.output_root_path,
            output_size=excluded.output_size, output_hash=excluded.output_hash,
            output_mtime_ns=excluded.output_mtime_ns, output_mime_type=excluded.output_mime_type,
            compression_count=excluded.compression_count, compressed_at=excluded.compressed_at`
        ).run(item.image_id, beforeHash, Number(beforeStat.size), written.relativePath, outputRoot, written.size, written.hash, written.mtimeNs, written.mimeType, result.compressionCount, now);
        this.db.prepare(
          `UPDATE job_items SET status='succeeded', input_size=?, output_size=?, saved_bytes=?,
           finished_at=?, error_code=NULL, error_message=NULL WHERE id=?`
        ).run(Number(beforeStat.size), written.size, Math.max(0, Number(beforeStat.size) - written.size), now, item.id);
      });
      finish();
      if (result.compressionCount != null) {
        if (this.usage) this.usage.recordCompression(result.compressionCount);
        else this.db.prepare("UPDATE api_usage SET compression_count=?, updated_at=? WHERE id=1").run(result.compressionCount, now);
      }
    } catch (error) {
      const now = new Date().toISOString();
      const code = signal.aborted ? "APP_SHUTDOWN" : error instanceof AppError ? error.code : "UNKNOWN";
      const message = signal.aborted ? "应用退出，压缩任务已中断" : errorMessage(error).slice(0, 400);
      if (code === "QUOTA_EXHAUSTED") {
        const count = error instanceof AppError && typeof (error.details as any)?.compressionCount === "number"
          ? Number((error.details as any).compressionCount)
          : null;
        this.usage?.recordQuotaExhausted(count);
        affectedJobIds = this.failQueuedItems(code, "TinyPNG 本月免费额度已用尽，请在额度恢复后手动重新压缩");
      } else if (code === "ACCOUNT_INVALID") {
        this.usage?.recordError(code);
        affectedJobIds = this.failQueuedItems(code, "TinyPNG API Key 无效，请更新 Key 后手动重新压缩");
      }
      const status = code === "OUTPUT_SKIPPED" ? "skipped" : "failed";
      this.db.prepare(
        `UPDATE job_items SET status=?, error_code=?, error_message=?, finished_at=? WHERE id=?`
      ).run(status, code, message, now, item.id);
    } finally {
      this.refreshJob(item.job_id);
      for (const jobId of affectedJobIds) {
        if (jobId !== item.job_id) this.refreshJob(jobId);
      }
    }
  }

  private failQueuedItems(code: string, message: string): string[] {
    const jobs = this.db.prepare(
      "SELECT DISTINCT job_id FROM job_items WHERE status='queued'"
    ).all() as Array<{ job_id: string }>;
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE job_items SET status='failed', error_code=?, error_message=?, finished_at=? WHERE status='queued'`
    ).run(code, message, now);
    const jobIds = jobs.map(({ job_id: jobId }) => jobId);
    for (const jobId of jobIds) this.refreshJob(jobId);
    return jobIds;
  }

  private refreshJob(jobId: string): void {
    const stats = this.db.prepare(
      `SELECT COUNT(*) total,
       SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) succeeded,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
       SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled,
       SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) skipped,
       SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
       SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running,
       COALESCE(SUM(input_size),0) input_bytes, COALESCE(SUM(output_size),0) output_bytes
       FROM job_items WHERE job_id=?`
    ).get(jobId) as any;
    const active = Number(stats.queued) + Number(stats.running);
    const finalStatus = active > 0 ? "running" : Number(stats.failed) + Number(stats.skipped) > 0 ? "completed_with_errors" : Number(stats.cancelled) === Number(stats.total) ? "cancelled" : "completed";
    const finishedAt = active === 0 ? new Date().toISOString() : null;
    this.db.prepare(
      `UPDATE compression_jobs SET status=?, total=?, succeeded=?, failed=?, cancelled=?, skipped=?,
       input_bytes=?, output_bytes=?, finished_at=? WHERE id=?`
    ).run(finalStatus, stats.total, stats.succeeded, stats.failed, stats.cancelled, stats.skipped, stats.input_bytes, stats.output_bytes, finishedAt, jobId);
    this.onChange(jobId);
  }
}
