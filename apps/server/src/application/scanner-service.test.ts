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

  it("appends files from different locations to the current queue", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-scan-append-test-"));
    directories.push(root);
    const sessionSource = path.join(root, "session-source");
    const output = path.join(root, "output");
    const firstDirectory = path.join(root, "first");
    const secondDirectory = path.join(root, "second");
    const data = path.join(root, "data");
    await Promise.all([sessionSource, output, firstDirectory, secondDirectory].map((directory) => fs.mkdir(directory)));
    const firstPath = path.join(firstDirectory, "one.png");
    const secondPath = path.join(secondDirectory, "two.png");
    await Promise.all([
      sharp({ create: { width: 12, height: 12, channels: 3, background: "#226644" } }).png().toFile(firstPath),
      sharp({ create: { width: 14, height: 10, channels: 3, background: "#446622" } }).png().toFile(secondPath)
    ]);
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,2,1,?,?)`).run(sessionSource, sessionSource, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start({ paths: [firstPath], sourceLabel: "one.png" });
    await scanner.waitForIdle();
    scanner.start({ paths: [secondDirectory], sourceLabel: "second" });
    await scanner.waitForIdle();

    const images = db.prepare("SELECT filename,source_absolute_path,present FROM image_entries ORDER BY filename").all();
    expect(images).toEqual([
      { filename: "one.png", source_absolute_path: await fs.realpath(firstPath), present: 1 },
      { filename: "two.png", source_absolute_path: await fs.realpath(secondPath), present: 1 }
    ]);
    db.close();
  });

  it("reports whether a supported image is newly added to the current list", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-scan-event-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    const imagePath = path.join(source, "image.png");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#225544" } }).png().toFile(imagePath);
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,2,1,?,?)`).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    const events: Array<{ scanId: string; imageId: string; newlyAdded: boolean }> = [];
    const scanStatuses: string[] = [];
    scanner.setOnImage(async (event) => {
      events.push(event);
      scanStatuses.push(scanner.getCurrent().status);
    });

    scanner.start({ paths: [imagePath] });
    await scanner.waitForIdle();
    scanner.start({ paths: [imagePath] });
    await scanner.waitForIdle();

    expect(events.map((event) => event.newlyAdded)).toEqual([true, false]);
    expect(events[0]!.imageId).toBe(events[1]!.imageId);
    expect(scanStatuses).toEqual(["running", "running"]);
    db.close();
  });

  it("stops a scan without disabling later scans", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-scan-stop-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    const data = path.join(root, "data");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    await sharp({ create: { width: 20, height: 20, channels: 3, background: "#225544" } }).png().toFile(path.join(source, "image.png"));
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,2,1,?,?)`).run(source, source, output, output, now, now);
    const scanner = new ScannerService(db);
    scanner.start({ paths: [source] });
    expect(await scanner.cancel()).toMatchObject({ status: "stopped" });
    scanner.start({ paths: [source] });
    expect(await scanner.waitForIdle()).toMatchObject({ status: "succeeded", processedCount: 1 });
    db.close();
  });
});
