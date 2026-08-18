import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";
import { TinyPngKeyService } from "./tinypng-key-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("TinyPngKeyService", () => {
  it("adds, activates, renames and protects distinct keys", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-key-service-test-"));
    directories.push(root);
    const db = await openDatabase(root);
    const secrets = new FileSecretStore(root);
    const validateKey = vi.fn(async () => ({ valid: true, compressionCount: 25, quotaExceeded: false }));
    const keys = new TinyPngKeyService(db, secrets, { validateKey });

    const first = await keys.create("工作账号", "first-secret");
    const second = await keys.create("备用账号", "second-secret");
    expect(await keys.list()).toMatchObject({ activeKeyId: first.id, items: [{ id: first.id, active: true }, { id: second.id, active: false }] });
    await expect(keys.create("重复密钥", "first-secret")).rejects.toMatchObject({ code: "DUPLICATE_API_KEY" });
    await expect(keys.create("工作账号", "third-secret")).rejects.toMatchObject({ code: "DUPLICATE_API_KEY_NAME" });

    await keys.activate(second.id);
    await keys.rename(second.id, "备用账号 2");
    await expect(keys.delete(second.id)).rejects.toMatchObject({ code: "ACTIVE_API_KEY" });
    await keys.activate(first.id);
    await expect(keys.delete(second.id)).resolves.toMatchObject({ deleted: true, lastKeyRemoved: false });
    expect((await keys.list()).items.map((item) => item.name)).toEqual(["工作账号"]);
    db.close();
  });

  it("migrates the legacy singleton key and usage exactly once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-key-migration-test-"));
    directories.push(root);
    const secretsDirectory = path.join(root, "secrets");
    await fs.mkdir(secretsDirectory, { recursive: true });
    await fs.writeFile(path.join(secretsDirectory, "tinypng.key"), "legacy-secret", { mode: 0o600 });
    const db = await openDatabase(root);
    db.prepare(
      `UPDATE api_usage SET compression_count=420,quota_state='warning',usage_source='cache',usage_period='2026-08',
       last_validation_status='valid',last_validated_at='2026-08-14T00:00:00.000Z',updated_at='2026-08-14T00:00:00.000Z' WHERE id=1`
    ).run();
    const secrets = new FileSecretStore(root);
    const keys = new TinyPngKeyService(db, secrets, { validateKey: vi.fn() });

    await keys.migrateLegacy();
    await keys.migrateLegacy();

    const list = await keys.list();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: "默认 Key", active: true, used: 420, status: "warning" });
    await expect(keys.getSecret(list.items[0]!.id)).resolves.toBe("legacy-secret");
    await expect(fs.access(path.join(secretsDirectory, "tinypng.key"))).rejects.toMatchObject({ code: "ENOENT" });
    db.close();
  });
});
