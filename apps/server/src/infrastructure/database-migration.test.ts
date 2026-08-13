import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, recoverInterruptedJobs } from "./database.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("database migrations", () => {
  it("adds P1 workspace fields without losing existing workspaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-migration-test-"));
    directories.push(root);
    const legacy = new Database(path.join(root, "app.db"));
    legacy.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE workspaces (id TEXT PRIMARY KEY,source_dir TEXT NOT NULL,source_real_path TEXT NOT NULL,output_dir TEXT NOT NULL,output_real_path TEXT NOT NULL,recursive INTEGER NOT NULL DEFAULT 1,compression_concurrency INTEGER NOT NULL DEFAULT 2,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); INSERT INTO workspaces VALUES ('legacy','/source','/source','/output','/output',1,2,1,'now','now');`);
    legacy.close();
    const db = await openDatabase(root);
    expect(db.prepare("SELECT id,watch_enabled,auto_compress,conflict_strategy FROM workspaces").get()).toEqual({ id: "legacy", watch_enabled: 1, auto_compress: 0, conflict_strategy: "overwrite" });
    expect(db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()).toEqual({ value: "2" });
    db.close();
  });

  it("keeps queued work awaiting explicit resume after restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-recovery-test-"));
    directories.push(root);
    const db = await openDatabase(root);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (id,source_dir,source_real_path,output_dir,output_real_path,active,created_at,updated_at) VALUES ('w','/s','/s','/o','/o',1,?,?)`).run(now, now);
    db.prepare(`INSERT INTO image_entries (id,workspace_id,relative_path,relative_path_key,filename,extension,source_size,source_mtime_ns,source_hash,supported,present,created_at,updated_at) VALUES ('i','w','a.png','a.png','a.png','png',1,'1','hash',1,1,?,?)`).run(now, now);
    db.prepare(`INSERT INTO compression_jobs (id,workspace_id,client_request_id,status,total,created_at) VALUES ('j','w','r','queued',1,?)`).run(now);
    db.prepare(`INSERT INTO job_items (id,job_id,image_id,status,submitted_source_hash,queued_at) VALUES ('ji','j','i','queued','hash',?)`).run(now);
    recoverInterruptedJobs(db);
    expect(db.prepare("SELECT status FROM job_items WHERE id='ji'").get()).toEqual({ status: "awaiting_resume" });
    expect(db.prepare("SELECT status FROM compression_jobs WHERE id='j'").get()).toEqual({ status: "awaiting_resume" });
    db.close();
  });
});
