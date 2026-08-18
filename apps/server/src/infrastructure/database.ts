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
  source_label TEXT,
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
  source_absolute_path TEXT,
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
  output_root_path TEXT,
  output_size INTEGER NOT NULL,
  output_hash TEXT NOT NULL,
  output_mtime_ns TEXT NOT NULL,
  output_mime_type TEXT NOT NULL,
  compression_count INTEGER,
  compressed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinypng_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tinypng_api_usage (
  key_id TEXT PRIMARY KEY REFERENCES tinypng_api_keys(id) ON DELETE CASCADE,
  compression_count INTEGER,
  quota_limit INTEGER NOT NULL DEFAULT 500,
  quota_state TEXT NOT NULL DEFAULT 'unknown',
  usage_source TEXT,
  usage_period TEXT,
  exhausted_at TEXT,
  last_error_code TEXT,
  last_validation_status TEXT NOT NULL DEFAULT 'unknown',
  last_validated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS compression_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  output_root_path TEXT,
  tinypng_key_id TEXT REFERENCES tinypng_api_keys(id) ON DELETE SET NULL,
  tinypng_key_name TEXT,
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
  output_relative_path TEXT,
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
  quota_limit INTEGER NOT NULL DEFAULT 500,
  quota_state TEXT NOT NULL DEFAULT 'unknown',
  usage_source TEXT,
  usage_period TEXT,
  exhausted_at TEXT,
  last_error_code TEXT,
  last_validation_status TEXT NOT NULL DEFAULT 'unknown',
  last_validated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_workspace_path ON image_entries(workspace_id, relative_path_key);
CREATE INDEX IF NOT EXISTS idx_images_workspace_present ON image_entries(workspace_id, present);
CREATE INDEX IF NOT EXISTS idx_job_items_status ON job_items(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_job_items_image ON job_items(image_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_tinypng_key
ON tinypng_api_keys(is_active) WHERE is_active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_image_job
ON job_items(image_id) WHERE status IN ('queued', 'running');
`;

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrate(db: Database.Database): void {
  const transaction = db.transaction(() => {
    ensureColumn(db, "workspaces", "watch_enabled", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "workspaces", "auto_compress", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "workspaces", "conflict_strategy", "TEXT NOT NULL DEFAULT 'overwrite'");
    ensureColumn(db, "scan_runs", "source_label", "TEXT");
    ensureColumn(db, "image_entries", "source_absolute_path", "TEXT");
    ensureColumn(db, "compression_records", "output_root_path", "TEXT");
    ensureColumn(db, "compression_jobs", "output_root_path", "TEXT");
    ensureColumn(db, "compression_jobs", "tinypng_key_id", "TEXT REFERENCES tinypng_api_keys(id) ON DELETE SET NULL");
    ensureColumn(db, "compression_jobs", "tinypng_key_name", "TEXT");
    ensureColumn(db, "job_items", "output_relative_path", "TEXT");
    ensureColumn(db, "api_usage", "quota_limit", "INTEGER NOT NULL DEFAULT 500");
    ensureColumn(db, "api_usage", "quota_state", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn(db, "api_usage", "usage_source", "TEXT");
    ensureColumn(db, "api_usage", "usage_period", "TEXT");
    ensureColumn(db, "api_usage", "exhausted_at", "TEXT");
    ensureColumn(db, "api_usage", "last_error_code", "TEXT");
    db.prepare("UPDATE workspaces SET watch_enabled=0, auto_compress=0").run();
    db.prepare(
      `UPDATE api_usage SET quota_state=CASE
         WHEN compression_count >= quota_limit THEN 'exhausted'
         WHEN compression_count * 1.0 / quota_limit >= 0.8 THEN 'warning'
         ELSE 'available'
       END,
       usage_source=COALESCE(usage_source, 'cache'),
       usage_period=COALESCE(usage_period, substr(updated_at, 1, 7))
       WHERE compression_count IS NOT NULL AND quota_state='unknown'`
    ).run();
    db.exec("DROP INDEX IF EXISTS idx_one_active_image_job");
    db.exec(`CREATE UNIQUE INDEX idx_one_active_image_job
      ON job_items(image_id) WHERE status IN ('queued', 'running')`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_tinypng_key
      ON compression_jobs(tinypng_key_id, status)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_tinypng_key
      ON tinypng_api_keys(is_active) WHERE is_active = 1`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS prevent_active_tinypng_key_delete
      BEFORE DELETE ON tinypng_api_keys
      WHEN EXISTS (
        SELECT 1 FROM compression_jobs cj
        JOIN job_items ji ON ji.job_id=cj.id
        WHERE cj.tinypng_key_id=OLD.id AND ji.status IN ('queued','running')
      )
      BEGIN
        SELECT RAISE(ABORT, 'TINyPNG_KEY_IN_USE');
      END`);
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES ('schema_version', '6')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    ).run();
  });
  transaction();
}

export async function openDatabase(appDataDir: string): Promise<Database.Database> {
  await fs.mkdir(appDataDir, { recursive: true, mode: 0o700 });
  let db: Database.Database | null = null;
  try {
    db = new Database(path.join(appDataDir, "app.db"));
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(schema);
    migrate(db);
    db.prepare(
      `INSERT INTO api_usage (id, compression_count, quota_limit, quota_state, last_validation_status, updated_at)
       VALUES (1, NULL, 500, 'unknown', 'unknown', ?)
       ON CONFLICT(id) DO NOTHING`
    ).run(new Date().toISOString());
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the initialization error that explains why startup failed.
    }
    throw error;
  }
}

export function initializeSessionState(db: Database.Database): void {
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM compression_jobs").run();
    db.prepare("DELETE FROM scan_runs").run();
    db.prepare("UPDATE image_entries SET present=0, last_seen_scan_id=NULL").run();
  });
  transaction();
}
