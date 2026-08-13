import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const schema = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  source_dir TEXT NOT NULL,
  source_real_path TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  output_real_path TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 1,
  compression_concurrency INTEGER NOT NULL DEFAULT 2,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS image_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  relative_path_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  source_size INTEGER NOT NULL,
  source_mtime_ns TEXT NOT NULL,
  source_hash TEXT,
  supported INTEGER NOT NULL DEFAULT 1,
  present INTEGER NOT NULL DEFAULT 1,
  last_seen_scan_id TEXT,
  scan_error_code TEXT,
  scan_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, relative_path_key)
);

CREATE TABLE IF NOT EXISTS compression_records (
  image_id TEXT PRIMARY KEY REFERENCES image_entries(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  output_relative_path TEXT NOT NULL,
  output_size INTEGER NOT NULL,
  output_hash TEXT NOT NULL,
  output_mtime_ns TEXT NOT NULL,
  output_mime_type TEXT NOT NULL,
  compression_count INTEGER,
  compressed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compression_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  status TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  succeeded INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(workspace_id, client_request_id)
);

CREATE TABLE IF NOT EXISTS job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES compression_jobs(id) ON DELETE CASCADE,
  image_id TEXT NOT NULL REFERENCES image_entries(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  submitted_source_hash TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  input_size INTEGER,
  output_size INTEGER,
  saved_bytes INTEGER,
  error_code TEXT,
  error_message TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  compression_count INTEGER,
  last_validation_status TEXT NOT NULL DEFAULT 'unknown',
  last_validated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_workspace_path ON image_entries(workspace_id, relative_path_key);
CREATE INDEX IF NOT EXISTS idx_images_workspace_present ON image_entries(workspace_id, present);
CREATE INDEX IF NOT EXISTS idx_job_items_status ON job_items(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_job_items_image ON job_items(image_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_image_job
ON job_items(image_id) WHERE status IN ('queued', 'running');
`;

export async function openDatabase(appDataDir: string): Promise<Database.Database> {
  await fs.mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(appDataDir, "app.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(schema);
  db.prepare(
    `INSERT INTO api_usage (id, compression_count, last_validation_status, updated_at)
     VALUES (1, NULL, 'unknown', ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(new Date().toISOString());
  return db;
}

export function recoverInterruptedJobs(db: Database.Database): void {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare(
      `UPDATE job_items SET status = 'failed', error_code = 'APP_RESTARTED',
       error_message = '本地服务重启，任务已中断', finished_at = ? WHERE status = 'running'`
    ).run(now);
    db.prepare(
      `UPDATE job_items SET status = 'cancelled', error_code = 'APP_RESTARTED',
       error_message = '本地服务重启，排队任务已取消', finished_at = ? WHERE status = 'queued'`
    ).run(now);
    db.prepare(
      `UPDATE compression_jobs SET status = 'completed_with_errors', finished_at = ?
       WHERE status IN ('queued', 'running')`
    ).run(now);
  });
  transaction();
}
