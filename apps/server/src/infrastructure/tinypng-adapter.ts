import fs from "node:fs";
import { Readable } from "node:stream";
import { TINYPNG_FREE_MONTHLY_LIMIT } from "@ica/contracts";
import { AppError } from "../errors.js";

export interface TinyPngResult {
  stream: Readable;
  mimeType: string;
  contentLength: number | null;
  compressionCount: number | null;
}

function authHeader(key: string): string {
  return `Basic ${Buffer.from(`api:${key}`).toString("base64")}`;
}

function compressionCount(response: Response): number | null {
  const value = Number.parseInt(response.headers.get("compression-count") ?? "", 10);
  return Number.isNaN(value) ? null : value;
}

function retryAfterSeconds(response: Response): number | null {
  const value = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return Number.isNaN(value) ? null : Math.max(0, value);
}

async function externalError(response: Response): Promise<AppError> {
  let message = "TinyPNG 请求失败";
  let remoteError = "";
  try {
    const data = (await response.json()) as { error?: string; message?: string };
    remoteError = data.error ?? "";
    if (data.message) message = data.message.slice(0, 300);
  } catch {
    message = "TinyPNG 请求失败";
  }
  const count = compressionCount(response);
  const details = { compressionCount: count, retryAfterSeconds: retryAfterSeconds(response) };
  if (response.status === 401 || response.status === 403) return new AppError("ACCOUNT_INVALID", "TinyPNG API Key 无效", 400);
  if (response.status === 429) {
    const description = `${remoteError} ${message}`.toLocaleLowerCase("en-US");
    const monthlyLimitMessage = /(monthly|month).*(limit|quota|exceed)|(limit|quota).*(monthly|month)|compression limit/.test(description);
    if (monthlyLimitMessage || (count != null && count >= TINYPNG_FREE_MONTHLY_LIMIT)) {
      return new AppError("QUOTA_EXHAUSTED", "TinyPNG 本月免费额度已用尽", 429, details);
    }
    return new AppError("RATE_LIMITED", "TinyPNG 请求过于频繁，请稍后重试", 429, details);
  }
  if (response.status >= 500) return new AppError("SERVER_TEMPORARY", "TinyPNG 服务暂时不可用", 503);
  return new AppError("CLIENT_INPUT", message, 400);
}

export interface TinyPngKeyValidation {
  valid: boolean;
  compressionCount: number | null;
  quotaExceeded: boolean;
}

export class TinyPngAdapter {
  constructor(private readonly baseUrl = "https://api.tinify.com") {}

  async validateKey(key: string): Promise<TinyPngKeyValidation> {
    try {
      const response = await fetch(`${this.baseUrl}/shrink`, {
        method: "POST",
        headers: { Authorization: authHeader(key), "Content-Type": "application/octet-stream" },
        body: new Uint8Array(0),
        signal: AbortSignal.timeout(15_000)
      });
      const count = compressionCount(response);
      if (response.status === 401 || response.status === 403) return { valid: false, compressionCount: count, quotaExceeded: false };
      if ([400, 415].includes(response.status)) return { valid: true, compressionCount: count, quotaExceeded: false };
      if (response.status === 429) {
        const error = await externalError(response);
        if (error.code === "QUOTA_EXHAUSTED") return { valid: true, compressionCount: count, quotaExceeded: true };
        throw error;
      }
      if (response.ok) return { valid: true, compressionCount: count, quotaExceeded: false };
      throw await externalError(response);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("CONNECTION", "无法连接 TinyPNG，请检查网络", 503);
    }
  }

  async compress(sourcePath: string, key: string, signal?: AbortSignal): Promise<TinyPngResult> {
    let upload: Response;
    try {
      upload = await fetch(`${this.baseUrl}/shrink`, {
        method: "POST",
        headers: { Authorization: authHeader(key), "Content-Type": "application/octet-stream" },
        body: fs.createReadStream(sourcePath) as any,
        duplex: "half",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      } as RequestInit & { duplex: string });
    } catch {
      if (signal?.aborted) throw new AppError("APP_SHUTDOWN", "应用退出，TinyPNG 请求已取消", 503);
      throw new AppError("REMOTE_RESULT_UNCERTAIN", "上传连接中断，远端结果不确定；为避免重复计费，请手动重试", 503);
    }
    if (!upload.ok) throw await externalError(upload);
    const location = upload.headers.get("location");
    if (!location) throw new AppError("INVALID_REMOTE_RESPONSE", "TinyPNG 未返回结果地址", 502);
    const outputUrl = new URL(location);
    const base = new URL(this.baseUrl);
    if (outputUrl.protocol !== base.protocol || outputUrl.host !== base.host) {
      throw new AppError("INVALID_REMOTE_RESPONSE", "TinyPNG 返回了不受信任的结果地址", 502);
    }

    let output: Response;
    try {
      output = await fetch(outputUrl, {
        headers: { Authorization: authHeader(key) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
      });
    } catch {
      if (signal?.aborted) throw new AppError("APP_SHUTDOWN", "应用退出，TinyPNG 请求已取消", 503);
      throw new AppError("DOWNLOAD_FAILED", "压缩已完成，但结果下载失败；请手动重试", 503);
    }
    if (!output.ok) throw await externalError(output);
    if (!output.body) throw new AppError("INVALID_REMOTE_RESPONSE", "TinyPNG 返回了空结果", 502);
    const count = Number.parseInt(output.headers.get("compression-count") ?? upload.headers.get("compression-count") ?? "", 10);
    const length = Number.parseInt(output.headers.get("content-length") ?? "", 10);
    return {
      stream: Readable.fromWeb(output.body as any),
      mimeType: output.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
      contentLength: Number.isNaN(length) ? null : length,
      compressionCount: Number.isNaN(count) ? null : count
    };
  }
}
