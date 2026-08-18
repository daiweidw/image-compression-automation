import type Database from "better-sqlite3";
import {
  TINYPNG_FREE_MONTHLY_LIMIT,
  type TinyPngQuotaStatus,
  type TinyPngUsage,
  type TinyPngUsageSource
} from "@ica/contracts";
import { AppError } from "../errors.js";
import type { SecretStore } from "../infrastructure/secret-store.js";
import type { TinyPngKeyValidation } from "../infrastructure/tinypng-adapter.js";

const USAGE_STALE_AFTER_MS = 10 * 60 * 1000;

interface UsageRow {
  key_id: string;
  name: string;
  compression_count: number | null;
  quota_limit: number;
  quota_state: TinyPngQuotaStatus;
  usage_source: TinyPngUsageSource;
  usage_period: string | null;
  exhausted_at: string | null;
  last_error_code: string | null;
  last_validation_status: "valid" | "invalid" | "unknown";
  last_validated_at: string | null;
  updated_at: string;
}

export interface TinyPngKeyValidator {
  validateKey(key: string): Promise<TinyPngKeyValidation>;
}

export function usagePeriod(date: Date): string {
  return date.toISOString().slice(0, 7);
}

export function quotaStatus(used: number | null, limit: number, exhausted = false): TinyPngQuotaStatus {
  if (exhausted || (used != null && used >= limit)) return "exhausted";
  if (used == null) return "unknown";
  if (used / limit >= 0.8) return "warning";
  return "available";
}

export function usageStale(used: number | null, updatedAt: string, period: string | null): boolean {
  if (used == null) return true;
  const timestamp = new Date(updatedAt).getTime();
  const age = Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : Date.now() - timestamp;
  return age > USAGE_STALE_AFTER_MS || period !== usagePeriod(new Date());
}

export class TinyPngUsageService {
  private readonly refreshPromises = new Map<string, Promise<{ validation: TinyPngKeyValidation; usage: TinyPngUsage }>>();
  private onChange: (keyId: string) => void = () => undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretStore,
    private readonly validator: TinyPngKeyValidator
  ) {}

  setOnChange(listener: (keyId: string) => void): void {
    this.onChange = listener;
  }

  async getUsage(keyId?: string): Promise<TinyPngUsage> {
    const row = this.row(keyId);
    if (!row) return this.emptyUsage();
    const hasSecret = await this.secrets.hasTinyPngKey(row.key_id);
    const remaining = row.compression_count == null ? null : Math.max(0, row.quota_limit - row.compression_count);
    return {
      keyId: row.key_id,
      keyName: row.name,
      configured: true,
      used: row.compression_count,
      limit: row.quota_limit || TINYPNG_FREE_MONTHLY_LIMIT,
      remaining,
      status: row.quota_state,
      canCompress: hasSecret && row.last_validation_status === "valid" && row.quota_state !== "exhausted",
      lastValidationStatus: row.last_validation_status,
      updatedAt: row.compression_count == null ? null : row.updated_at,
      stale: usageStale(row.compression_count, row.updated_at, row.usage_period),
      source: row.usage_source
    };
  }

  isExhausted(keyId: string): boolean {
    return this.row(keyId)?.quota_state === "exhausted";
  }

  remaining(keyId: string): number | null {
    const row = this.row(keyId);
    return !row || row.compression_count == null ? null : Math.max(0, row.quota_limit - row.compression_count);
  }

  validateCandidate(key: string): Promise<TinyPngKeyValidation> {
    return this.validator.validateKey(key);
  }

  async refresh(keyId?: string): Promise<{ validation: TinyPngKeyValidation; usage: TinyPngUsage }> {
    const row = this.row(keyId);
    if (!row) throw new AppError("API_KEY_REQUIRED", "请先填写 TinyPNG API Key");
    const existing = this.refreshPromises.get(row.key_id);
    if (existing) return existing;
    const promise = this.performRefresh(row.key_id).finally(() => this.refreshPromises.delete(row.key_id));
    this.refreshPromises.set(row.key_id, promise);
    return promise;
  }

  async refreshIfStale(keyId?: string): Promise<TinyPngUsage> {
    const cached = await this.getUsage(keyId);
    if (!cached.configured || !cached.stale || !cached.keyId) return cached;
    try {
      return (await this.refresh(cached.keyId)).usage;
    } catch (error) {
      this.recordError(cached.keyId, error instanceof AppError ? error.code : "CONNECTION");
      return this.getUsage(cached.keyId);
    }
  }

  private async performRefresh(keyId: string): Promise<{ validation: TinyPngKeyValidation; usage: TinyPngUsage }> {
    const key = await this.secrets.getTinyPngKey(keyId);
    if (!key) throw new AppError("API_KEY_SECRET_MISSING", "TinyPNG API Key 密钥文件缺失");
    const validation = await this.validator.validateKey(key);
    this.recordValidation(keyId, validation);
    return { validation, usage: await this.getUsage(keyId) };
  }

  recordValidation(keyId: string, result: TinyPngKeyValidation): void {
    const now = new Date();
    if (!result.valid) {
      this.db.prepare(
        `UPDATE tinypng_api_usage SET last_validation_status='invalid',last_validated_at=?,
         last_error_code='ACCOUNT_INVALID' WHERE key_id=?`
      ).run(now.toISOString(), keyId);
      this.onChange(keyId);
      return;
    }
    const row = this.requiredRow(keyId);
    const status = quotaStatus(result.compressionCount, row.quota_limit, result.quotaExceeded);
    this.db.prepare(
      `UPDATE tinypng_api_usage SET compression_count=?,quota_state=?,usage_source='validation',usage_period=?,
       exhausted_at=?,last_error_code=NULL,last_validation_status='valid',last_validated_at=?,updated_at=? WHERE key_id=?`
    ).run(result.compressionCount, status, usagePeriod(now), status === "exhausted" ? now.toISOString() : null,
      now.toISOString(), now.toISOString(), keyId);
    this.onChange(keyId);
  }

  recordCompression(keyId: string, count: number): void {
    const now = new Date();
    const row = this.requiredRow(keyId);
    const currentPeriod = usagePeriod(now);
    const effectiveCount = row.usage_period === currentPeriod && row.compression_count != null
      ? Math.max(row.compression_count, count)
      : count;
    const status = quotaStatus(effectiveCount, row.quota_limit);
    this.db.prepare(
      `UPDATE tinypng_api_usage SET compression_count=?,quota_state=?,usage_source='compression',usage_period=?,
       exhausted_at=?,last_error_code=NULL,updated_at=? WHERE key_id=?`
    ).run(effectiveCount, status, currentPeriod, status === "exhausted" ? now.toISOString() : null, now.toISOString(), keyId);
    this.onChange(keyId);
  }

  recordQuotaExhausted(keyId: string, count: number | null): void {
    const now = new Date();
    this.db.prepare(
      `UPDATE tinypng_api_usage SET compression_count=COALESCE(?,quota_limit),quota_state='exhausted',
       usage_source='compression',usage_period=?,exhausted_at=COALESCE(exhausted_at,?),
       last_error_code='QUOTA_EXHAUSTED',updated_at=? WHERE key_id=?`
    ).run(count, usagePeriod(now), now.toISOString(), now.toISOString(), keyId);
    this.onChange(keyId);
  }

  recordError(keyId: string, code: string): void {
    this.db.prepare("UPDATE tinypng_api_usage SET last_error_code=? WHERE key_id=?").run(code, keyId);
    this.onChange(keyId);
  }

  private row(keyId?: string): UsageRow | null {
    const sql = `SELECT u.*,k.name FROM tinypng_api_usage u JOIN tinypng_api_keys k ON k.id=u.key_id`;
    const row = keyId
      ? this.db.prepare(`${sql} WHERE u.key_id=?`).get(keyId)
      : this.db.prepare(`${sql} WHERE k.is_active=1`).get();
    return row as UsageRow | undefined ?? null;
  }

  private requiredRow(keyId: string): UsageRow {
    const row = this.row(keyId);
    if (!row) throw new AppError("API_KEY_NOT_FOUND", "API Key 不存在", 404);
    return row;
  }

  private emptyUsage(): TinyPngUsage {
    return {
      keyId: null, keyName: null, configured: false, used: null, limit: TINYPNG_FREE_MONTHLY_LIMIT,
      remaining: null, status: "unknown", canCompress: false, lastValidationStatus: "unknown", updatedAt: null, stale: false, source: null
    };
  }
}
