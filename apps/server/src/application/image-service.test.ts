import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { ScannerService } from "./scanner-service.js";
import { ImageService } from "./image-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createWorkspace(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const data = path.join(root, "data");
  await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
  const db = await openDatabase(data);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at)
     VALUES ('w',?,?,?,?,1,2,1,?,?)`
  ).run(source, source, output, output, now, now);
  return { db, source, output };
}

async function writeImage(filePath: string, width: number): Promise<void> {
  await sharp({ create: { width, height: 10, channels: 3, background: "#226644" } }).png().toFile(filePath);
}

describe("ImageService list management", () => {
  it("lists newer import batches first while keeping batch order stable", async () => {
    const { db, source } = await createWorkspace("ica-image-order-test-");
    const paths = ["one.png", "two.png", "three.png", "four.png"].map((name) => path.join(source, name));
    await Promise.all(paths.map((filePath, index) => writeImage(filePath, 10 + index)));
    const scanner = new ScannerService(db);
    const images = new ImageService(db, new PathPolicy());

    scanner.start({ paths: paths.slice(0, 2) });
    await scanner.waitForIdle();
    scanner.start({ paths: paths.slice(2) });
    await scanner.waitForIdle();

    const listNewestFirst = async () => images.list({ page: 1, pageSize: 50, sort: "addedAt", order: "desc" });
    expect((await listNewestFirst()).items.map((item) => item.filename)).toEqual([
      "three.png", "four.png", "one.png", "two.png"
    ]);

    scanner.start({ paths: [paths[0]!] });
    await scanner.waitForIdle();
    expect((await listNewestFirst()).items.map((item) => item.filename)).toEqual([
      "three.png", "four.png", "one.png", "two.png"
    ]);

    const first = db.prepare("SELECT id FROM image_entries WHERE filename='one.png'").get() as { id: string };
    expect(images.remove([first.id])).toBe(1);
    scanner.start({ paths: [paths[0]!] });
    await scanner.waitForIdle();
    expect((await listNewestFirst()).items.map((item) => item.filename)).toEqual([
      "one.png", "three.png", "four.png", "two.png"
    ]);
    db.close();
  });

  it("clears only records whose current derived status is compressed", async () => {
    const { db, source, output } = await createWorkspace("ica-image-clear-test-");
    const names = ["done.png", "missing.png", "changed.png", "active.png", "pending.png"];
    const paths = names.map((name) => path.join(source, name));
    await Promise.all(paths.map((filePath, index) => writeImage(filePath, 20 + index)));
    const scanner = new ScannerService(db);
    scanner.start({ paths });
    await scanner.waitForIdle();

    const outputBuffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#113355" } }).png().toBuffer();
    const outputPath = path.join(output, "shared.png");
    await fs.writeFile(outputPath, outputBuffer);
    const outputStat = await fs.stat(outputPath, { bigint: true });
    const outputHash = crypto.createHash("sha256").update(outputBuffer).digest("hex");
    const rows = db.prepare("SELECT id,filename,source_hash,source_size FROM image_entries").all() as Array<{
      id: string;
      filename: string;
      source_hash: string;
      source_size: number;
    }>;
    const byName = new Map(rows.map((row) => [row.filename, row]));
    const now = new Date().toISOString();
    const insertRecord = db.prepare(
      `INSERT INTO compression_records (
         image_id,source_hash,source_size,output_relative_path,output_root_path,output_size,
         output_hash,output_mtime_ns,output_mime_type,compressed_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    for (const name of ["done.png", "active.png"]) {
      const row = byName.get(name)!;
      insertRecord.run(row.id, row.source_hash, row.source_size, "shared.png", output, outputBuffer.length,
        outputHash, outputStat.mtimeNs.toString(), "image/png", now);
    }
    const missing = byName.get("missing.png")!;
    insertRecord.run(missing.id, missing.source_hash, missing.source_size, "missing.png", output, outputBuffer.length,
      outputHash, outputStat.mtimeNs.toString(), "image/png", now);
    const changed = byName.get("changed.png")!;
    insertRecord.run(changed.id, "old-source-hash", changed.source_size, "shared.png", output, outputBuffer.length,
      outputHash, outputStat.mtimeNs.toString(), "image/png", now);

    db.prepare(
      `INSERT INTO compression_jobs (id,workspace_id,client_request_id,status,total,created_at)
       VALUES ('active-job','w','active-request','queued',1,?)`
    ).run(now);
    db.prepare(
      `INSERT INTO job_items (id,job_id,image_id,status,submitted_source_hash,queued_at)
       VALUES ('active-item','active-job',?,'queued',?,?)`
    ).run(byName.get("active.png")!.id, byName.get("active.png")!.source_hash, now);

    const images = new ImageService(db, new PathPolicy());
    await expect(images.clearCompleted()).resolves.toBe(1);
    const visibility = db.prepare("SELECT filename,present FROM image_entries ORDER BY filename").all();
    expect(visibility).toEqual([
      { filename: "active.png", present: 1 },
      { filename: "changed.png", present: 1 },
      { filename: "done.png", present: 0 },
      { filename: "missing.png", present: 1 },
      { filename: "pending.png", present: 1 }
    ]);
    await expect(fs.readFile(paths[0]!)).resolves.toBeTruthy();
    await expect(fs.readFile(outputPath)).resolves.toEqual(outputBuffer);
    expect(db.prepare("SELECT status FROM compression_jobs WHERE id='active-job'").get()).toEqual({ status: "queued" });
    await expect(images.clearCompleted()).resolves.toBe(0);
    db.close();
  });

  it("clears more than the client selection limit without a SQLite placeholder limit", async () => {
    const { db, output } = await createWorkspace("ica-image-clear-large-test-");
    const outputBuffer = Buffer.from("compressed-output");
    const outputPath = path.join(output, "shared.png");
    await fs.writeFile(outputPath, outputBuffer);
    const outputStat = await fs.stat(outputPath, { bigint: true });
    const outputHash = crypto.createHash("sha256").update(outputBuffer).digest("hex");
    const now = new Date().toISOString();
    const insertImage = db.prepare(
      `INSERT INTO image_entries (
         id,workspace_id,relative_path,relative_path_key,filename,extension,source_size,source_mtime_ns,
         source_hash,supported,present,added_batch_order,added_order,created_at,updated_at
       ) VALUES (?,'w',?,?,?,'png',1,'1',?,1,1,1,?,?,?)`
    );
    const insertRecord = db.prepare(
      `INSERT INTO compression_records (
         image_id,source_hash,source_size,output_relative_path,output_root_path,output_size,
         output_hash,output_mtime_ns,output_mime_type,compressed_at
       ) VALUES (?,?,1,'shared.png',?,?,?,?, 'image/png',?)`
    );
    db.transaction(() => {
      for (let index = 0; index < 5_001; index += 1) {
        const id = `image-${index}`;
        const filename = `${index}.png`;
        const sourceHash = `source-${index}`;
        insertImage.run(id, filename, filename, filename, sourceHash, index, now, now);
        insertRecord.run(id, sourceHash, output, outputBuffer.length, outputHash, outputStat.mtimeNs.toString(), now);
      }
    })();

    const images = new ImageService(db, new PathPolicy());
    await expect(images.clearCompleted()).resolves.toBe(5_001);
    expect(db.prepare("SELECT COUNT(*) AS count FROM image_entries WHERE present=1").get()).toEqual({ count: 0 });
    db.close();
  });
});
