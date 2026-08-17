import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { PathPolicy } from "../infrastructure/path-policy.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";
import { SettingsService } from "./settings-service.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("SettingsService import automation settings", () => {
  it("defaults to automatic Downloads output with import automation off", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-settings-test-"));
    directories.push(root);
    const data = path.join(root, "data");
    const downloads = path.join(root, "Downloads");
    await fs.mkdir(downloads);
    const db = await openDatabase(data);
    const secrets = new FileSecretStore(data);
    const settings = new SettingsService(data, db, secrets, new PathPolicy(), { clear: vi.fn() } as any);

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

  it("persists the switch and turns it off when the API key is deleted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-settings-key-test-"));
    directories.push(root);
    const data = path.join(root, "data");
    const downloads = path.join(root, "Downloads");
    await fs.mkdir(downloads);
    const db = await openDatabase(data);
    const secrets = new FileSecretStore(data);
    const settings = new SettingsService(data, db, secrets, new PathPolicy(), { clear: vi.fn() } as any);
    await settings.ensureDefaults(downloads);
    await secrets.setTinyPngKey("test-key");

    await expect(settings.setAutoCompressOnImport(true)).resolves.toMatchObject({ autoCompressOnImport: true });
    expect(JSON.parse(await fs.readFile(path.join(data, "settings.json"), "utf8"))).toMatchObject({ autoCompressOnImport: true });
    const reloaded = new SettingsService(data, db, secrets, new PathPolicy(), { clear: vi.fn() } as any);
    await reloaded.ensureDefaults(downloads);
    await expect(reloaded.getResponse()).resolves.toMatchObject({ autoCompressOnImport: true });
    await reloaded.deleteKey();
    await expect(reloaded.getResponse()).resolves.toMatchObject({ autoCompressOnImport: false });
    db.close();
  });

  it("migrates a legacy Downloads setting without reusing the old database flag", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-settings-migration-test-"));
    directories.push(root);
    const data = path.join(root, "data");
    const downloads = path.join(root, "Downloads");
    const source = path.join(data, "session-source");
    await Promise.all([fs.mkdir(data), fs.mkdir(downloads), fs.mkdir(source)]);
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
    const settings = new SettingsService(data, db, new FileSecretStore(data), new PathPolicy(), { clear: vi.fn() } as any);

    await settings.ensureDefaults(downloads);

    await expect(settings.getResponse()).resolves.toMatchObject({ outputMode: "automatic", autoCompressOnImport: false });
    expect(JSON.parse(await fs.readFile(path.join(data, "settings.json"), "utf8"))).toMatchObject({ outputMode: "automatic", autoCompressOnImport: false });
    expect(db.prepare("SELECT auto_compress FROM workspaces WHERE id='w'").get()).toEqual({ auto_compress: 0 });
    db.close();
  });
});
