import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { TINYPNG_FREE_MONTHLY_LIMIT, type TinyPngKeyListResponse, type TinyPngKeyView } from "@ica/contracts";
import { ulid } from "ulid";
import { AppError } from "../errors.js";
import type { SecretStore } from "../infrastructure/secret-store.js";
import type { TinyPngKeyValidation } from "../infrastructure/tinypng-adapter.js";
import { quotaStatus, usagePeriod, usageStale } from "./tinypng-usage-service.js";

const LEGACY_KEY_ID = "00000000000000000000000001";

interface KeyRow {
  id: string;
  name: string;
  normalized_name: string;
  is_active: number;
  compression_count: number | null;
  quota_limit: number;
  quota_state: TinyPngKeyView["status"];
  usage_source: TinyPngKeyView["source"];
  usage_period: string | null;
  last_validation_status: TinyPngKeyView["lastValidationStatus"];
  last_validated_at: string | null;
  updated_at: string;
}

export interface TinyPngKeyValidator {
  validateKey(key: string): Promise<TinyPngKeyValidation>;
}

export class TinyPngKeyService {
  private writeLock: Promise<void> = Promise.resolve();
  private onChange: (keyId: string | null) => void = () => undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretStore,
    private readonly validator: TinyPngKeyValidator
  ) {}

  setOnChange(listener: (keyId: string | null) => void): void {
    this.onChange = listener;
  }

  async migrateLegacy(): Promise<void> {
    const existingLegacy = this.db.prepare("SELECT id FROM tinypng_api_keys WHERE id=?").get(LEGACY_KEY_ID) as { id: string } | undefined;
    if (existingLegacy) {
      await this.secrets.deleteLegacyTinyPngKey();
      return;
    }
    const count = (this.db.prepare("SELECT COUNT(*) count FROM tinypng_api_keys").get() as { count: number }).count;
    if (count > 0) return;
    const legacyKey = await this.secrets.getLegacyTinyPngKey();
    if (!legacyKey) return;

    await this.secrets.setTinyPngKey(LEGACY_KEY_ID, legacyKey);
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        this.db.prepare(
          `INSERT INTO tinypng_api_keys (id,name,normalized_name,is_active,created_at,updated_at)
           VALUES (?, '默认 Key', '默认 key', 1, ?, ?)`
        ).run(LEGACY_KEY_ID, now, now);
        this.db.prepare(
          `INSERT INTO tinypng_api_usage (
             key_id,compression_count,quota_limit,quota_state,usage_source,usage_period,exhausted_at,
             last_error_code,last_validation_status,last_validated_at,updated_at
           )
           SELECT ?,compression_count,quota_limit,quota_state,usage_source,usage_period,exhausted_at,
             last_error_code,last_validation_status,last_validated_at,updated_at
           FROM api_usage WHERE id=1`
        ).run(LEGACY_KEY_ID);
        const usage = this.db.prepare("SELECT key_id FROM tinypng_api_usage WHERE key_id=?").get(LEGACY_KEY_ID);
        if (!usage) {
          this.db.prepare(
            `INSERT INTO tinypng_api_usage (key_id,quota_limit,quota_state,last_validation_status,updated_at)
             VALUES (?, ?, 'unknown', 'unknown', ?)`
          ).run(LEGACY_KEY_ID, TINYPNG_FREE_MONTHLY_LIMIT, now);
        }
      })();
    } catch (error) {
      await this.secrets.deleteTinyPngKey(LEGACY_KEY_ID).catch(() => undefined);
      throw error;
    }
    await this.secrets.deleteLegacyTinyPngKey();
  }

  async list(): Promise<TinyPngKeyListResponse> {
    const rows = this.rows();
    const items = await Promise.all(rows.map((row) => this.view(row)));
    return { items, activeKeyId: rows.find((row) => row.is_active === 1)?.id ?? null };
  }

  async create(name: string, candidate: string): Promise<TinyPngKeyView> {
    return this.serializedWrite(async () => {
      const normalized = this.normalizeName(name);
      const key = candidate.trim();
      if (!key) throw new AppError("API_KEY_REQUIRED", "请输入 TinyPNG API Key");
      if (this.db.prepare("SELECT 1 FROM tinypng_api_keys WHERE normalized_name=?").get(normalized.key)) {
        throw new AppError("DUPLICATE_API_KEY_NAME", "API Key 名称已存在", 409);
      }
      const candidateHash = crypto.createHash("sha256").update(key).digest();
      for (const row of this.rows()) {
        const existing = await this.secrets.getTinyPngKey(row.id);
        if (!existing) continue;
        const existingHash = crypto.createHash("sha256").update(existing).digest();
        if (crypto.timingSafeEqual(candidateHash, existingHash)) {
          throw new AppError("DUPLICATE_API_KEY", "该 API Key 已经保存", 409);
        }
      }

      const validation = await this.validator.validateKey(key);
      if (!validation.valid) throw new AppError("INVALID_API_KEY", "TinyPNG API Key 无效");
      const id = ulid();
      const now = new Date();
      const active = this.rows().length === 0;
      await this.secrets.setTinyPngKey(id, key);
      try {
        this.db.transaction(() => {
          this.db.prepare(
            `INSERT INTO tinypng_api_keys (id,name,normalized_name,is_active,created_at,updated_at)
             VALUES (?,?,?,?,?,?)`
          ).run(id, normalized.name, normalized.key, Number(active), now.toISOString(), now.toISOString());
          const status = quotaStatus(validation.compressionCount, TINYPNG_FREE_MONTHLY_LIMIT, validation.quotaExceeded);
          this.db.prepare(
            `INSERT INTO tinypng_api_usage (
               key_id,compression_count,quota_limit,quota_state,usage_source,usage_period,exhausted_at,
               last_error_code,last_validation_status,last_validated_at,updated_at
             ) VALUES (?,?,?,?, 'validation', ?, ?, NULL, 'valid', ?, ?)`
          ).run(id, validation.compressionCount, TINYPNG_FREE_MONTHLY_LIMIT, status, usagePeriod(now),
            status === "exhausted" ? now.toISOString() : null, now.toISOString(), now.toISOString());
        })();
      } catch (error) {
        await this.secrets.deleteTinyPngKey(id).catch(() => undefined);
        throw error;
      }
      this.onChange(id);
      return this.view(this.row(id));
    });
  }

  async activate(keyId: string): Promise<TinyPngKeyView> {
    return this.serializedWrite(async () => {
      const row = this.row(keyId);
      if (!(await this.secrets.hasTinyPngKey(keyId))) throw new AppError("API_KEY_SECRET_MISSING", "API Key 密钥文件缺失", 409);
      this.db.transaction(() => {
        this.db.prepare("UPDATE tinypng_api_keys SET is_active=0 WHERE is_active=1").run();
        this.db.prepare("UPDATE tinypng_api_keys SET is_active=1,updated_at=? WHERE id=?").run(new Date().toISOString(), keyId);
      })();
      this.onChange(keyId);
      return this.view({ ...row, is_active: 1 });
    });
  }

  async rename(keyId: string, name: string): Promise<TinyPngKeyView> {
    return this.serializedWrite(async () => {
      this.row(keyId);
      const normalized = this.normalizeName(name);
      const duplicate = this.db.prepare("SELECT id FROM tinypng_api_keys WHERE normalized_name=? AND id<>?").get(normalized.key, keyId);
      if (duplicate) throw new AppError("DUPLICATE_API_KEY_NAME", "API Key 名称已存在", 409);
      this.db.prepare("UPDATE tinypng_api_keys SET name=?,normalized_name=?,updated_at=? WHERE id=?")
        .run(normalized.name, normalized.key, new Date().toISOString(), keyId);
      this.onChange(keyId);
      return this.view(this.row(keyId));
    });
  }

  async delete(keyId: string): Promise<{ deleted: true; lastKeyRemoved: boolean }> {
    return this.serializedWrite(async () => {
      const row = this.row(keyId);
      const total = (this.db.prepare("SELECT COUNT(*) count FROM tinypng_api_keys").get() as { count: number }).count;
      if (row.is_active === 1 && total > 1) throw new AppError("ACTIVE_API_KEY", "请先切换到其他 API Key 再删除", 409);
      const activeJobs = this.db.prepare(
        `SELECT COUNT(*) count FROM compression_jobs cj JOIN job_items ji ON ji.job_id=cj.id
         WHERE cj.tinypng_key_id=? AND ji.status IN ('queued','running')`
      ).get(keyId) as { count: number };
      if (activeJobs.count > 0) throw new AppError("API_KEY_IN_USE", "该 API Key 仍有压缩任务，完成或取消后再删除", 409);

      const secret = await this.secrets.getTinyPngKey(keyId);
      await this.secrets.deleteTinyPngKey(keyId);
      try {
        this.db.prepare("DELETE FROM tinypng_api_keys WHERE id=?").run(keyId);
      } catch (error) {
        if (secret) await this.secrets.setTinyPngKey(keyId, secret);
        throw error;
      }
      this.onChange(null);
      return { deleted: true, lastKeyRemoved: total === 1 };
    });
  }

  activeRow(): KeyRow | null {
    return this.db.prepare(
      `SELECT k.*,u.compression_count,u.quota_limit,u.quota_state,u.usage_source,u.usage_period,
       u.last_validation_status,u.last_validated_at,u.updated_at
       FROM tinypng_api_keys k JOIN tinypng_api_usage u ON u.key_id=k.id WHERE k.is_active=1`
    ).get() as KeyRow | undefined ?? null;
  }

  async activeForCompression(): Promise<KeyRow> {
    const row = this.activeRow();
    if (!row) throw new AppError("API_KEY_REQUIRED", "请先在设置中配置 TinyPNG API Key", 409);
    if (row.last_validation_status !== "valid") throw new AppError("ACCOUNT_INVALID", "当前 TinyPNG API Key 无效", 409);
    if (row.quota_state === "exhausted") throw new AppError("QUOTA_EXHAUSTED", "当前 TinyPNG API Key 本月额度已用尽", 409);
    if (!(await this.secrets.hasTinyPngKey(row.id))) throw new AppError("API_KEY_SECRET_MISSING", "当前 TinyPNG API Key 密钥文件缺失", 409);
    return row;
  }

  getSecret(keyId: string): Promise<string | null> {
    return this.secrets.getTinyPngKey(keyId);
  }

  async hasActiveKey(): Promise<boolean> {
    const row = this.activeRow();
    return Boolean(row && await this.secrets.hasTinyPngKey(row.id));
  }

  private rows(): KeyRow[] {
    return this.db.prepare(
      `SELECT k.*,u.compression_count,u.quota_limit,u.quota_state,u.usage_source,u.usage_period,
       u.last_validation_status,u.last_validated_at,u.updated_at
       FROM tinypng_api_keys k JOIN tinypng_api_usage u ON u.key_id=k.id
       ORDER BY k.is_active DESC,k.created_at,k.id`
    ).all() as KeyRow[];
  }

  private row(keyId: string): KeyRow {
    const row = this.db.prepare(
      `SELECT k.*,u.compression_count,u.quota_limit,u.quota_state,u.usage_source,u.usage_period,
       u.last_validation_status,u.last_validated_at,u.updated_at
       FROM tinypng_api_keys k JOIN tinypng_api_usage u ON u.key_id=k.id WHERE k.id=?`
    ).get(keyId) as KeyRow | undefined;
    if (!row) throw new AppError("API_KEY_NOT_FOUND", "API Key 不存在", 404);
    return row;
  }

  private async view(row: KeyRow): Promise<TinyPngKeyView> {
    const hasSecret = await this.secrets.hasTinyPngKey(row.id);
    const remaining = row.compression_count == null ? null : Math.max(0, row.quota_limit - row.compression_count);
    return {
      id: row.id, name: row.name, active: row.is_active === 1, used: row.compression_count,
      limit: row.quota_limit, remaining, status: row.quota_state,
      canCompress: hasSecret && row.last_validation_status === "valid" && row.quota_state !== "exhausted",
      stale: usageStale(row.compression_count, row.updated_at, row.usage_period), source: row.usage_source,
      lastValidationStatus: row.last_validation_status, lastValidatedAt: row.last_validated_at,
      updatedAt: row.compression_count == null ? null : row.updated_at
    };
  }

  private normalizeName(value: string): { name: string; key: string } {
    const name = value.trim().normalize("NFC");
    if (!name || [...name].length > 30) throw new AppError("INVALID_API_KEY_NAME", "API Key 名称应为 1 到 30 个字符");
    return { name, key: name.toLocaleLowerCase("zh-CN") };
  }

  private async serializedWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
