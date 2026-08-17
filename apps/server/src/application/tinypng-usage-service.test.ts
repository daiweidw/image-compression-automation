import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../infrastructure/database.js";
import { FileSecretStore } from "../infrastructure/secret-store.js";
import { TinyPngUsageService } from "./tinypng-usage-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("TinyPngUsageService", () => {
  it("persists refreshed usage and derives warning and exhausted states", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-usage-test-"));
    directories.push(root);
    const db = await openDatabase(root);
    const secrets = new FileSecretStore(root);
    await secrets.setTinyPngKey("test-key");
    const validateKey = vi.fn(async () => ({ valid: true, compressionCount: 420, quotaExceeded: false }));
    const usage = new TinyPngUsageService(db, secrets, { validateKey });

    const refreshed = await usage.refresh();
    expect(refreshed.usage).toMatchObject({ used: 420, limit: 500, remaining: 80, status: "warning", stale: false, source: "validation" });
    db.prepare("UPDATE api_usage SET usage_period='2026-07', updated_at='2026-07-31T23:00:00.000Z' WHERE id=1").run();
    await expect(usage.getUsage()).resolves.toMatchObject({ used: 420, stale: true });
    usage.recordQuotaExhausted(null);
    await expect(usage.getUsage()).resolves.toMatchObject({ used: 500, remaining: 0, status: "exhausted", source: "compression" });
    expect(validateKey).toHaveBeenCalledTimes(1);
    db.close();
  });
});
