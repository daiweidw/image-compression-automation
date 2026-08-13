import fs from "node:fs/promises";
import crypto from "node:crypto";
import fileSystem from "node:fs";
import type Database from "better-sqlite3";
import type { ImageItem, ImageListResponse, ImageStatus } from "@ica/contracts";
import { AppError } from "../errors.js";
import { deriveImageStatus } from "../domain/image-status.js";
import { PathPolicy } from "../infrastructure/path-policy.js";

export interface ImageListOptions {
  page: number;
  pageSize: number;
  query?: string;
  statuses?: ImageStatus[];
  formats?: string[];
  sort: "filename" | "sourceSize" | "sourceMtime" | "compressedAt" | "savedRatio";
  order: "asc" | "desc";
}

export class ImageService {
  constructor(private readonly db: Database.Database, private readonly pathPolicy: PathPolicy) {}

  private workspace(): any {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE active=1 LIMIT 1").get();
    if (!row) throw new AppError("SETTINGS_REQUIRED", "请先完成目录设置", 409);
    return row;
  }

  private async outputValid(workspace: any, row: any): Promise<boolean> {
    if (!row.output_relative_path) return false;
    try {
      const output = this.pathPolicy.resolveWithin(workspace.output_real_path, row.output_relative_path);
      await this.pathPolicy.assertNoSymlink(workspace.output_real_path, output);
      const stat = await fs.lstat(output, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || Number(stat.size) !== row.output_size || stat.size <= 0n) return false;
      if (row.output_mtime_ns === stat.mtimeNs.toString()) return true;
      const hash = crypto.createHash("sha256");
      for await (const chunk of fileSystem.createReadStream(output)) hash.update(chunk as Buffer);
      return hash.digest("hex") === row.output_hash;
    } catch {
      return false;
    }
  }

  async getById(id: string): Promise<any> {
    const workspace = this.workspace();
    const row = this.db.prepare(
      `SELECT i.*, r.source_hash AS record_source_hash, r.output_relative_path, r.output_size,
       r.output_hash, r.output_mtime_ns, r.compressed_at, r.output_mime_type,
       EXISTS(SELECT 1 FROM job_items ji WHERE ji.image_id=i.id AND ji.status='queued') AS queued,
       EXISTS(SELECT 1 FROM job_items ji WHERE ji.image_id=i.id AND ji.status='running') AS running,
       (SELECT status FROM job_items ji WHERE ji.image_id=i.id ORDER BY ji.queued_at DESC LIMIT 1) AS last_job_status,
       (SELECT error_code FROM job_items ji WHERE ji.image_id=i.id ORDER BY ji.queued_at DESC LIMIT 1) AS error_code,
       (SELECT error_message FROM job_items ji WHERE ji.image_id=i.id ORDER BY ji.queued_at DESC LIMIT 1) AS error_message
       FROM image_entries i LEFT JOIN compression_records r ON r.image_id=i.id
       WHERE i.id=? AND i.workspace_id=? AND i.present=1`
    ).get(id, workspace.id) as any;
    if (!row) throw new AppError("IMAGE_NOT_FOUND", "图片不存在或已被移出原图目录", 404);
    const outputValid = await this.outputValid(workspace, row);
    const status = deriveImageStatus({
      queued: Boolean(row.queued),
      running: Boolean(row.running),
      supported: Boolean(row.supported),
      sourceHash: row.source_hash,
      recordSourceHash: row.record_source_hash,
      outputValid,
      lastJobFailed: row.last_job_status === "failed"
    });
    return { ...row, status, outputValid, workspace };
  }

  async list(options: ImageListOptions): Promise<ImageListResponse> {
    const { items, summary } = await this.filtered(options);
    const total = items.length;
    const start = (options.page - 1) * options.pageSize;
    return { items: items.slice(start, start + options.pageSize), page: options.page, pageSize: options.pageSize, total, summary };
  }

  async selectableIds(options: Omit<ImageListOptions, "page" | "pageSize">): Promise<string[]> {
    const { items } = await this.filtered({ ...options, page: 1, pageSize: 1000 });
    return items
      .filter((item) => ["pending", "source_changed", "output_missing", "failed", "compressed"].includes(item.status))
      .slice(0, 1000)
      .map((item) => item.id);
  }

  private async filtered(options: ImageListOptions): Promise<{ items: ImageItem[]; summary: ImageListResponse["summary"] }> {
    const workspace = this.workspace();
    const rows = this.db.prepare(
      `SELECT i.*, r.source_hash AS record_source_hash, r.output_relative_path, r.output_size,
       r.output_hash, r.output_mtime_ns, r.compressed_at,
       EXISTS(SELECT 1 FROM job_items ji WHERE ji.image_id=i.id AND ji.status='queued') AS queued,
       EXISTS(SELECT 1 FROM job_items ji WHERE ji.image_id=i.id AND ji.status='running') AS running,
       (SELECT status FROM job_items ji WHERE ji.image_id=i.id ORDER BY ji.queued_at DESC LIMIT 1) AS last_job_status,
       (SELECT error_code FROM job_items ji WHERE ji.image_id=i.id ORDER BY ji.queued_at DESC LIMIT 1) AS error_code,
       (SELECT error_message FROM job_items ji WHERE ji.image_id=i.id ORDER BY ji.queued_at DESC LIMIT 1) AS error_message
       FROM image_entries i LEFT JOIN compression_records r ON r.image_id=i.id
       WHERE i.workspace_id=? AND i.present=1`
    ).all(workspace.id) as any[];

    const items: ImageItem[] = [];
    for (const row of rows) {
      const outputValid = await this.outputValid(workspace, row);
      const status = deriveImageStatus({
        queued: Boolean(row.queued),
        running: Boolean(row.running),
        supported: Boolean(row.supported),
        sourceHash: row.source_hash,
        recordSourceHash: row.record_source_hash,
        outputValid,
        lastJobFailed: row.last_job_status === "failed"
      });
      const savedBytes = row.output_size == null ? null : Math.max(0, row.source_size - row.output_size);
      items.push({
        id: row.id,
        filename: row.filename,
        relativePath: row.relative_path,
        extension: row.extension,
        mimeType: row.mime_type,
        width: row.width,
        height: row.height,
        sourceSize: row.source_size,
        sourceMtime: new Date(Number(BigInt(row.source_mtime_ns) / 1_000_000n)).toISOString(),
        status,
        compressedAt: row.compressed_at,
        outputSize: row.output_size,
        savedBytes,
        savedRatio: savedBytes == null || row.source_size === 0 ? null : savedBytes / row.source_size,
        errorCode: row.scan_error_code ?? row.error_code,
        errorMessage: row.scan_error_message ?? row.error_message
      });
    }

    const summary = {
      pending: 0,
      queued: 0,
      compressing: 0,
      compressed: 0,
      source_changed: 0,
      output_missing: 0,
      failed: 0,
      unsupported: 0,
      sourceBytes: 0,
      outputBytes: 0,
      savedBytes: 0
    };
    for (const item of items) {
      summary[item.status] += 1;
      summary.sourceBytes += item.sourceSize;
      if (item.outputSize != null) summary.outputBytes += item.outputSize;
      if (item.savedBytes != null) summary.savedBytes += item.savedBytes;
    }

    let filtered = items;
    if (options.query) {
      const query = options.query.toLocaleLowerCase();
      filtered = filtered.filter((item) => item.relativePath.toLocaleLowerCase().includes(query));
    }
    if (options.statuses?.length) filtered = filtered.filter((item) => options.statuses!.includes(item.status));
    if (options.formats?.length) filtered = filtered.filter((item) => options.formats!.includes(item.extension));

    const direction = options.order === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const values: Record<typeof options.sort, [string | number | null, string | number | null]> = {
        filename: [a.filename, b.filename],
        sourceSize: [a.sourceSize, b.sourceSize],
        sourceMtime: [a.sourceMtime, b.sourceMtime],
        compressedAt: [a.compressedAt, b.compressedAt],
        savedRatio: [a.savedRatio, b.savedRatio]
      };
      const [left, right] = values[options.sort];
      if (left == null) return 1;
      if (right == null) return -1;
      return (typeof left === "string" ? left.localeCompare(String(right), "zh-CN") : left - Number(right)) * direction;
    });
    return { items: filtered, summary };
  }

  async sourcePath(id: string): Promise<{ path: string; row: any }> {
    const row = await this.getById(id);
    const source = this.pathPolicy.resolveWithin(row.workspace.source_real_path, row.relative_path);
    await this.pathPolicy.assertNoSymlink(row.workspace.source_real_path, source);
    return { path: source, row };
  }

  async previewPath(id: string, variant: "source" | "output"): Promise<{ path: string; mimeType: string }> {
    const { path: source, row } = await this.sourcePath(id);
    if (variant === "source") return { path: source, mimeType: row.mime_type ?? "application/octet-stream" };
    if (!row.output_relative_path || !row.outputValid) throw new AppError("OUTPUT_NOT_FOUND", "压缩结果不存在", 404);
    const output = this.pathPolicy.resolveWithin(row.workspace.output_real_path, row.output_relative_path);
    return { path: output, mimeType: row.output_mime_type ?? row.mime_type };
  }
}
