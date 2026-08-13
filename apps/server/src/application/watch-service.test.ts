import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { WatchService } from "./watch-service.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("WatchService", () => {
  it("debounces a new file and submits only the matching image when auto compression is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-watch-test-"));
    directories.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await Promise.all([fs.mkdir(source), fs.mkdir(output)]);
    const db = await openDatabase(path.join(root, "data"));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,watch_enabled,auto_compress,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,1,1,1,1,?,?)`).run(source, source, output, output, now, now);
    const scanner = { start: vi.fn(), waitForIdle: vi.fn(async () => ({ status: "succeeded" })) };
    const images = { idsForSourcePaths: vi.fn(async (paths: string[]) => paths.map((candidate) => path.basename(candidate) === "new.png" ? "new-id" : "").filter(Boolean)) };
    const jobs = { create: vi.fn(async () => ({ id: "job" })) };
    const onChange = vi.fn();
    const service = new WatchService(db, scanner as any, images as any, jobs as any, onChange);
    await service.sync();
    await fs.writeFile(path.join(source, "new.png"), "image-data");
    for (let count = 0; count < 80 && jobs.create.mock.calls.length === 0; count += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(images.idsForSourcePaths).toHaveBeenCalledWith([path.join(source, "new.png")]);
    expect(jobs.create).toHaveBeenCalledWith(expect.any(String), ["new-id"], false);
    expect(service.getState()).toMatchObject({ enabled: true, watching: true, autoCompress: true, pendingChanges: 0, lastError: null });
    await service.stop();
    db.close();
  });
});
