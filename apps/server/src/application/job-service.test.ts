import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { OutputWriter } from "../infrastructure/output-writer.js";
import type { TinyPngResult } from "../infrastructure/tinypng-adapter.js";
import { ScannerService } from "./scanner-service.js";
import { ImageService } from "./image-service.js";
import { JobService } from "./job-service.js";

const directories: string[] = [];

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
    const secrets = new FileSecretStore(data);
    await secrets.setTinyPngKey("test-key");
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
    const jobs = new JobService(db, imageService, secrets, fakeTinyPng, new OutputWriter(new PathPolicy()));
    jobs.start();
    const job = await jobs.create("request-1", [image.id], false);
    let result = jobs.get(job.id);
    for (let count = 0; count < 200 && ["queued", "running"].includes(result.status); count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = jobs.get(job.id);
    }
    jobs.stop();

    expect(result).toMatchObject({ status: "completed", succeeded: 1, failed: 0 });
    await expect(fs.readFile(path.join(output, "image.png"))).resolves.toEqual(compressed);
    expect((await imageService.getById(image.id)).status).toBe("compressed");
    expect(db.prepare("SELECT compression_count FROM api_usage WHERE id=1").get()).toEqual({ compression_count: 3 });
    db.close();
  });
});
