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

function usagePeriod(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function quotaStatus(used: number | null, limit: number, exhausted = false): TinyPngQuotaStatus {
  if (exhausted || (used != null && used >= limit)) return "exhausted";
  if (used == null) return "unknown";
  if (used / limit >= 0.8) return "warning";
  return "available";
}

export class TinyPngUsageService {
  private refreshPromise: Promise<{ validation: TinyPngKeyValidation; usage: TinyPngUsage }> | null = null;
  private onChange: () => void = () => undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly secrets: SecretStore,
    private readonly validator: TinyPngKeyValidator
  ) {}

  setOnChange(listener: () => void): void {
    this.onChange = listener;
  }

  private row(): UsageRow {
    return this.db.prepare("SELECT * FROM api_usage WHERE id=1").get() as UsageRow;
  }

  async getUsage(): Promise<TinyPngUsage> {
    const configured = await this.secrets.hasTinyPngKey();
    const row = this.row();
    const updatedAt = row.compression_count == null ? null : row.updated_at;
    const updatedTimestamp = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
    const age = Number.isNaN(updatedTimestamp) ? Number.POSITIVE_INFINITY : Date.now() - updatedTimestamp;
    const stale = configured && (age > USAGE_STALE_AFTER_MS || row.usage_period !== usagePeriod(new Date()));
    const remaining = row.compression_count == null ? null : Math.max(0, row.quota_limit - row.compression_count);
    return {
      configured,
      used: configured ? row.compression_count : null,
      limit: row.quota_limit || TINYPNG_FREE_MONTHLY_LIMIT,
      remaining: configured ? remaining : null,
      status: configured ? row.quota_state : "unknown",
      updatedAt,
      stale,
      source: configured ? row.usage_source : null
    };
  }

  isExhausted(): boolean {
    return this.row().quota_state === "exhausted";
  }

  remaining(): number | null {
    const row = this.row();
    return row.compression_count == null ? null : Math.max(0, row.quota_limit - row.compression_count);
  }

  async validateCandidate(key: string): Promise<TinyPngKeyValidation> {
    return this.validator.validateKey(key);
  }

  async refresh(): Promise<{ validation: TinyPngKeyValidation; usage: TinyPngUsage }> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async refreshIfStale(): Promise<TinyPngUsage> {
    const cached = await this.getUsage();
    if (!cached.configured || !cached.stale) return cached;
    try {
      return (await this.refresh()).usage;
    } catch (error) {
      this.recordError(error instanceof AppError ? error.code : "CONNECTION");
      return this.getUsage();
    }
  }

  private async performRefresh(): Promise<{ validation: TinyPngKeyValidation; usage: TinyPngUsage }> {
    const key = await this.secrets.getTinyPngKey();
    if (!key) throw new AppError("API_KEY_REQUIRED", "请先填写 TinyPNG API Key");
    const validation = await this.validator.validateKey(key);
    this.recordValidation(validation);
    return { validation, usage: await this.getUsage() };
  }

  recordValidation(result: TinyPngKeyValidation): void {
    const now = new Date();
    if (!result.valid) {
      this.db.prepare(
        `UPDATE api_usage SET last_validation_status='invalid', last_validated_at=?,
         last_error_code='ACCOUNT_INVALID' WHERE id=1`
      ).run(now.toISOString());
      this.onChange();
      return;
    }
    const row = this.row();
    const status = quotaStatus(result.compressionCount, row.quota_limit, result.quotaExceeded);
    this.db.prepare(
      `UPDATE api_usage SET compression_count=?, quota_state=?, usage_source='validation', usage_period=?,
       exhausted_at=?, last_error_code=NULL, last_validation_status='valid', last_validated_at=?, updated_at=? WHERE id=1`
    ).run(
      result.compressionCount,
      status,
      usagePeriod(now),
      status === "exhausted" ? now.toISOString() : null,
      now.toISOString(),
      now.toISOString()
    );
    this.onChange();
  }

  recordCompression(count: number): void {
    const now = new Date();
    const row = this.row();
    const status = quotaStatus(count, row.quota_limit);
    this.db.prepare(
      `UPDATE api_usage SET compression_count=?, quota_state=?, usage_source='compression', usage_period=?,
       exhausted_at=?, last_error_code=NULL, updated_at=? WHERE id=1`
    ).run(count, status, usagePeriod(now), status === "exhausted" ? now.toISOString() : null, now.toISOString());
    this.onChange();
  }

  recordQuotaExhausted(count: number | null): void {
    const now = new Date();
    this.db.prepare(
      `UPDATE api_usage SET compression_count=COALESCE(?, quota_limit), quota_state='exhausted',
       usage_source='compression', usage_period=?, exhausted_at=COALESCE(exhausted_at, ?),
       last_error_code='QUOTA_EXHAUSTED', updated_at=? WHERE id=1`
    ).run(count, usagePeriod(now), now.toISOString(), now.toISOString());
    this.onChange();
  }

  recordError(code: string): void {
    this.db.prepare("UPDATE api_usage SET last_error_code=? WHERE id=1").run(code);
    this.onChange();
  }

  clear(): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE api_usage SET compression_count=NULL, quota_state='unknown', usage_source=NULL,
       usage_period=NULL, exhausted_at=NULL, last_error_code=NULL, last_validation_status='unknown',
       last_validated_at=NULL, updated_at=? WHERE id=1`
    ).run(now);
    this.onChange();
  }
}
