import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { ScannerService } from "./scanner-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("ScannerService", () => {
  it("scans supported images and skips hidden files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-scan-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    await sharp({ create: { width: 20, height: 10, channels: 3, background: "#22aa66" } }).png().toFile(path.join(source, "visible.png"));
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000000" } }).png().toFile(path.join(source, ".hidden.png"));
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at)
       VALUES ('w',?,?,?,?,1,2,1,?,?)`
    ).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start();
    for (let count = 0; count < 100 && scanner.getCurrent().status === "running"; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scanner.getCurrent()).toMatchObject({ status: "succeeded", processedCount: 1 });
    const images = db.prepare("SELECT filename,width,height,source_hash FROM image_entries").all() as any[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ filename: "visible.png", width: 20, height: 10 });
    expect(images[0].source_hash).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });
});
