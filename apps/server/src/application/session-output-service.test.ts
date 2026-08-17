import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { SessionOutputService } from "./session-output-service.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

async function fixture(outputMode: "automatic" | "custom") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-session-output-test-"));
  directories.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "output");
  const data = path.join(root, "data");
  await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
  const db = await openDatabase(data);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,2,1,?,?)`).run(source, source, output, output, now, now);
  const service = new SessionOutputService(db, { load: async () => ({ outputMode }) } as any);
  return { db, output, service };
}

describe("SessionOutputService", () => {
  it("reuses one lazily-created directory for the current automatic session", async () => {
    const { db, output, service } = await fixture("automatic");
    const [first, second] = await Promise.all([service.resolve(), service.resolve()]);

    expect(first.path).toBe(second.path);
    expect(path.dirname(first.path)).toBe(output);
    expect(path.basename(first.path)).toMatch(/^图片压缩_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/);
    expect(await fs.readdir(output)).toHaveLength(1);
    db.close();
  });

  it("uses a custom directory directly", async () => {
    const { db, output, service } = await fixture("custom");
    await expect(service.resolve()).resolves.toEqual({ path: output, createdForSession: false });
    expect(await fs.readdir(output)).toEqual([]);
    db.close();
  });

  it("removes an unreferenced empty session directory after task creation fails", async () => {
    const { db, output, service } = await fixture("automatic");
    const allocation = await service.resolve();
    await service.releaseIfUnused(allocation.path);
    expect(service.current()).toBeNull();
    expect(await fs.readdir(output)).toEqual([]);
    db.close();
  });
});
