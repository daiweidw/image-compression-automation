import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";
import { SettingsService } from "./settings-service.js";
import { TinyPngKeyService } from "./tinypng-key-service.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

function keyService(db: Awaited<ReturnType<typeof openDatabase>>, data: string): TinyPngKeyService {
  return new TinyPngKeyService(db, new FileSecretStore(data), {
    validateKey: vi.fn(async () => ({ valid: true, compressionCount: 0, quotaExceeded: false }))
  });
}

describe("SettingsService import automation settings", () => {
  it("defaults to automatic Downloads output with import automation off", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-settings-test-"));
    directories.push(root);
    const data = path.join(root, "data");
    const downloads = path.join(root, "Downloads");
    await fs.mkdir(downloads);
    const db = await openDatabase(data);
    const keys = keyService(db, data);
    const settings = new SettingsService(data, db, keys, new PathPolicy());

    await settings.ensureDefaults(downloads);

    await expect(settings.getResponse()).resolves.toMatchObject({
      outputMode: "automatic",
      outputDir: downloads,
      sessionOutputDir: null,
      autoCompressOnImport: false
    });
    await expect(settings.setAutoCompressOnImport(true)).rejects.toMatchObject({ code: "API_KEY_REQUIRED" });
    db.close();
  });

  it("persists the switch and turns it off after the last API key is deleted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-settings-key-test-"));
    directories.push(root);
    const data = path.join(root, "data");
    const downloads = path.join(root, "Downloads");
    await fs.mkdir(downloads);
    const db = await openDatabase(data);
    const keys = keyService(db, data);
    const settings = new SettingsService(data, db, keys, new PathPolicy());
    await settings.ensureDefaults(downloads);
    const savedKey = await keys.create("测试账号", "test-key");

    await expect(settings.setAutoCompressOnImport(true)).resolves.toMatchObject({ autoCompressOnImport: true });
    expect(JSON.parse(await fs.readFile(path.join(data, "settings.json"), "utf8"))).toMatchObject({ autoCompressOnImport: true });
    const reloaded = new SettingsService(data, db, keys, new PathPolicy());
    await reloaded.ensureDefaults(downloads);
    await expect(reloaded.getResponse()).resolves.toMatchObject({ autoCompressOnImport: true });
    await keys.delete(savedKey.id);
    await reloaded.setAutoCompressOnImport(false);
    await expect(reloaded.getResponse()).resolves.toMatchObject({ autoCompressOnImport: false });
    db.close();
  });

  it("migrates a legacy Downloads setting without reusing the old database flag", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-settings-migration-test-"));
    directories.push(root);
    const data = path.join(root, "data");
    const downloads = path.join(root, "Downloads");
    const source = path.join(data, "session-source");
    await Promise.all([fs.mkdir(downloads), fs.mkdir(source, { recursive: true })]);
    await fs.writeFile(path.join(data, "settings.json"), JSON.stringify({
      sourceDir: source,
      outputDir: downloads,
      recursive: true,
      compressionConcurrency: 2,
      conflictStrategy: "suffix"
    }));
    const db = await openDatabase(data);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,recursive,compression_concurrency,watch_enabled,auto_compress,conflict_strategy,active,created_at,updated_at) VALUES ('w',?,?,?,?,1,2,0,0,'suffix',1,?,?)`).run(source, source, downloads, downloads, now, now);
    const settings = new SettingsService(data, db, keyService(db, data), new PathPolicy());

    await settings.ensureDefaults(downloads);

    await expect(settings.getResponse()).resolves.toMatchObject({ outputMode: "automatic", autoCompressOnImport: false });
    expect(JSON.parse(await fs.readFile(path.join(data, "settings.json"), "utf8"))).toMatchObject({ outputMode: "automatic", autoCompressOnImport: false });
    expect(db.prepare("SELECT auto_compress FROM workspaces WHERE id='w'").get()).toEqual({ auto_compress: 0 });
    db.close();
  });
});
