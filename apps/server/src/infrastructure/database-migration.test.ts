import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSessionState, openDatabase } from "./database.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("database migrations", () => {
  it("keeps existing settings while disabling removed automatic behaviors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-migration-test-"));
    directories.push(root);
    const legacy = new Database(path.join(root, "app.db"));
    legacy.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE workspaces (id TEXT PRIMARY KEY,source_dir TEXT NOT NULL,source_real_path TEXT NOT NULL,output_dir TEXT NOT NULL,output_real_path TEXT NOT NULL,recursive INTEGER NOT NULL DEFAULT 1,compression_concurrency INTEGER NOT NULL DEFAULT 2,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); INSERT INTO workspaces VALUES ('legacy','/source','/source','/output','/output',1,2,1,'now','now');`);
    legacy.close();
    const db = await openDatabase(root);
    expect(db.prepare("SELECT id,watch_enabled,auto_compress,conflict_strategy FROM workspaces").get()).toEqual({ id: "legacy", watch_enabled: 0, auto_compress: 0, conflict_strategy: "overwrite" });
    expect(db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()).toEqual({ value: "5" });
    db.close();
  });

  it("starts a new session without queued work or cached images", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-recovery-test-"));
    directories.push(root);
    const db = await openDatabase(root);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,active,created_at,updated_at) VALUES ('w','/s','/s','/o','/o',1,?,?)`).run(now, now);
    db.prepare(`INSERT INTO image_entries (id,workspace_id,relative_path,relative_path_key,filename,extension,source_size,source_mtime_ns,source_hash,supported,present,created_at,updated_at) VALUES ('i','w','a.png','a.png','a.png','png',1,'1','hash',1,1,?,?)`).run(now, now);
    db.prepare(`INSERT INTO compression_jobs (id,workspace_id,client_request_id,status,total,created_at) VALUES ('j','w','r','queued',1,?)`).run(now);
    db.prepare(`INSERT INTO job_items (id,job_id,image_id,status,submitted_source_hash,queued_at) VALUES ('ji','j','i','queued','hash',?)`).run(now);
    initializeSessionState(db);
    expect(db.prepare("SELECT status FROM job_items WHERE id='ji'").get()).toBeUndefined();
    expect(db.prepare("SELECT status FROM compression_jobs WHERE id='j'").get()).toBeUndefined();
    expect(db.prepare("SELECT present FROM image_entries WHERE id='i'").get()).toEqual({ present: 0 });
    db.close();
  });

  it("derives quota state for cached usage from the previous schema", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-usage-migration-test-"));
    directories.push(root);
    const legacy = new Database(path.join(root, "app.db"));
    legacy.exec(`CREATE TABLE api_usage (id INTEGER PRIMARY KEY,compression_count INTEGER,last_validation_status TEXT NOT NULL,last_validated_at TEXT,updated_at TEXT NOT NULL); INSERT INTO api_usage VALUES (1,420,'valid','2026-08-14T00:00:00.000Z','2026-08-14T00:00:00.000Z');`);
    legacy.close();
    const db = await openDatabase(root);
    expect(db.prepare("SELECT compression_count,quota_limit,quota_state,usage_source,usage_period FROM api_usage WHERE id=1").get()).toEqual({
      compression_count: 420,
      quota_limit: 500,
      quota_state: "warning",
      usage_source: "cache",
      usage_period: "2026-08"
    });
    db.close();
  });
});
