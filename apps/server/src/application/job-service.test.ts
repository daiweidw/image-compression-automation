import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { OutputWriter } from "../infrastructure/output-writer.js";
import type { TinyPngResult } from "../infrastructure/tinypng-adapter.js";
import { ScannerService } from "./scanner-service.js";
import { ImageService } from "./image-service.js";
import { JobService } from "./job-service.js";
import { TinyPngUsageService } from "./tinypng-usage-service.js";
import { TinyPngKeyService } from "./tinypng-key-service.js";
import { AppError } from "../errors.js";
import { SessionOutputService } from "./session-output-service.js";

const directories: string[] = [];

function sessionOutputs(db: Awaited<ReturnType<typeof openDatabase>>, outputMode: "automatic" | "custom" = "automatic"): SessionOutputService {
  return new SessionOutputService(db, { load: async () => ({ outputMode }) } as any);
}

async function keyServices(
  db: Awaited<ReturnType<typeof openDatabase>>,
  data: string,
  validator: { validateKey(key: string): Promise<{ valid: boolean; compressionCount: number | null; quotaExceeded: boolean }> } = {
    async validateKey() { return { valid: true, compressionCount: 0, quotaExceeded: false }; }
  }
) {
  const secrets = new FileSecretStore(data);
  const keys = new TinyPngKeyService(db, secrets, validator);
  const savedKey = await keys.create("测试账号", "test-key");
  const usage = new TinyPngUsageService(db, secrets, validator);
  return { keys, savedKey, usage };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("JobService", () => {
  it("moves an image from queued through atomic output to compressed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-job-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    await sharp({ create: { width: 80, height: 50, channels: 3, background: "#13705e" } })
      .png()
      .toFile(path.join(source, "image.png"));
    const compressed = await sharp({ create: { width: 80, height: 50, channels: 3, background: "#13705e" } })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at)
       VALUES ('w',?,?,?,?,1,1,1,?,?)`
    ).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start();
    for (let count = 0; count < 100 && scanner.getCurrent().status === "running"; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const image = db.prepare("SELECT id FROM image_entries LIMIT 1").get() as { id: string };
    const { keys, usage } = await keyServices(db, data);
    const fakeTinyPng = {
      async compress(): Promise<TinyPngResult> {
        return {
          stream: Readable.from(compressed),
          mimeType: "image/png",
          contentLength: compressed.length,
          compressionCount: 3
        };
      }
    };
    const imageService = new ImageService(db, new PathPolicy());
    const jobs = new JobService(db, imageService, keys, fakeTinyPng, new OutputWriter(new PathPolicy()), sessionOutputs(db), usage);
    jobs.start();
    const job = await jobs.create("request-1", [image.id], false);
    let result = jobs.get(job.id);
    for (let count = 0; count < 200 && ["queued", "running"].includes(result.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = jobs.get(job.id);
    }
    jobs.stop();

    expect(result).toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    await expect(fs.readFile(path.join(result.outputDir, "image.png"))).resolves.toEqual(compressed);
    expect(path.dirname(result.outputDir)).toBe(output);
    expect(path.basename(result.outputDir)).toMatch(/^图片压缩_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/);
    expect((await imageService.getById(image.id)).status).toBe("compressed");
    expect(db.prepare("SELECT compression_count FROM tinypng_api_usage").get()).toEqual({ compression_count: 3 });
    db.close();
  });

  it("fails only the exhausted key queue while another key continues", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-job-quota-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    await Promise.all(["one.png", "two.png", "three.png"].map((name) => sharp({ create: { width: 20, height: 20, channels: 3, background: "#336655" } }).png().toFile(path.join(source, name))));
    const compressed = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#336655" } }).png().toBuffer();
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,1,1,?,?)`).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start();
    await scanner.waitForIdle();
    const imageIds = (db.prepare("SELECT id FROM image_entries ORDER BY filename").all() as Array<{ id: string }>).map((item) => item.id);
    const calls: string[] = [];
    const fakeTinyPng = {
      async compress(_sourcePath: string, key: string): Promise<TinyPngResult> {
        calls.push(key);
        if (key === "test-key") throw new AppError("QUOTA_EXHAUSTED", "TinyPNG 本月免费额度已用尽", 429, { compressionCount: 500 });
        return { stream: Readable.from(compressed), mimeType: "image/png", contentLength: compressed.length, compressionCount: 1 };
      },
      async validateKey() {
        return { valid: true, compressionCount: 0, quotaExceeded: false };
      }
    };
    const { keys, savedKey, usage } = await keyServices(db, data, fakeTinyPng);
    const backupKey = await keys.create("备用账号", "second-key");
    const jobs = new JobService(db, new ImageService(db, new PathPolicy()), keys, fakeTinyPng, new OutputWriter(new PathPolicy()), sessionOutputs(db), usage);
    jobs.start();
    const exhaustedJob = await jobs.create("quota-request", imageIds.slice(0, 2), false);
    await keys.activate(backupKey.id);
    const backupJob = await jobs.create("backup-request", [imageIds[2]!], false);
    for (let count = 0; count < 200 && [exhaustedJob.id, backupJob.id].some((id) => ["queued", "running"].includes(jobs.get(id).status)); count += 1) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(jobs.get(exhaustedJob.id)).toMatchObject({ status: "completed_with_errors", failed: 2, apiKeyId: savedKey.id });
    expect(jobs.get(exhaustedJob.id).items.map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(jobs.get(backupJob.id)).toMatchObject({ status: "completed", succeeded: 1, apiKeyId: backupKey.id });
    expect([...calls].sort()).toEqual(["second-key", "test-key"]);
    expect(usage.isExhausted(savedKey.id)).toBe(true);
    expect(usage.isExhausted(backupKey.id)).toBe(false);
    await keys.activate(savedKey.id);
    await expect(jobs.create("blocked-request", [imageIds[1]!], false)).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    jobs.stop();
    db.close();
  });

  it("removes a newly-created batch directory when job persistence fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-job-directory-cleanup-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    await sharp({ create: { width: 12, height: 12, channels: 3, background: "#225544" } }).png().toFile(path.join(source, "image.png"));
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,1,1,?,?)`).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start();
    await scanner.waitForIdle();
    const image = db.prepare("SELECT id FROM image_entries LIMIT 1").get() as { id: string };
    const { keys, usage } = await keyServices(db, data);
    const jobs = new JobService(db, new ImageService(db, new PathPolicy()), keys, {} as any, new OutputWriter(new PathPolicy()), sessionOutputs(db), usage);
    jobs.start();
    const transaction = vi.spyOn(db, "transaction").mockImplementation((() => () => {
      throw new Error("forced persistence failure");
    }) as any);

    await expect(jobs.create("failing-request", [image.id], false)).rejects.toThrow("forced persistence failure");
    expect(await fs.readdir(output)).toEqual([]);
    transaction.mockRestore();
    jobs.stop();
    db.close();
  });

  it("waits for an explicit item retry after a compression failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-job-manual-retry-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    await sharp({ create: { width: 20, height: 20, channels: 3, background: "#336655" } }).png().toFile(path.join(source, "retry.png"));
    const compressed = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#336655" } }).png().toBuffer();
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,1,1,?,?)`).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start();
    await scanner.waitForIdle();
    const image = db.prepare("SELECT id FROM image_entries LIMIT 1").get() as { id: string };
    const { keys, usage } = await keyServices(db, data);
    let calls = 0;
    const fakeTinyPng = {
      async compress(): Promise<TinyPngResult> {
        calls += 1;
        if (calls === 1) throw new AppError("CONNECTION", "网络连接失败", 503);
        return { stream: Readable.from(compressed), mimeType: "image/png", contentLength: compressed.length, compressionCount: calls };
      }
    };
    const jobs = new JobService(db, new ImageService(db, new PathPolicy()), keys, fakeTinyPng, new OutputWriter(new PathPolicy()), sessionOutputs(db), usage);
    jobs.start();
    const first = await jobs.create("manual-retry", [image.id], false);
    for (let count = 0; count < 200 && ["queued", "running"].includes(jobs.get(first.id).status); count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const failed = jobs.get(first.id);
    expect(failed).toMatchObject({ status: "completed_with_errors", failed: 1 });
    expect(failed.items[0]).toMatchObject({ status: "failed", attemptCount: 1 });
    expect(calls).toBe(1);

    const retried = await jobs.retryItem(failed.items[0]!.id);
    for (let count = 0; count < 200 && ["queued", "running"].includes(jobs.get(retried.id).status); count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(jobs.get(retried.id)).toMatchObject({ status: "completed", succeeded: 1, outputDir: failed.outputDir });
    expect(calls).toBe(2);
    jobs.stop();
    db.close();
  });
});
