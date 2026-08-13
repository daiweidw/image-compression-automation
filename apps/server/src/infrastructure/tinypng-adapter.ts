import fs from "node:fs";
import { Readable } from "node:stream";
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

async function externalError(response: Response): Promise<AppError> {
  let message = "TinyPNG 请求失败";
  try {
    const data = (await response.json()) as { error?: string; message?: string };
    if (data.message) message = data.message.slice(0, 300);
  } catch {
    message = "TinyPNG 请求失败";
  }
  if (response.status === 401 || response.status === 403) return new AppError("ACCOUNT_INVALID", "TinyPNG API Key 无效", 400);
  if (response.status === 429) return new AppError("RATE_LIMITED", "TinyPNG 请求受限或本月额度已用尽", 429);
  if (response.status >= 500) return new AppError("SERVER_TEMPORARY", "TinyPNG 服务暂时不可用", 503);
  return new AppError("CLIENT_INPUT", message, 400);
}

export class TinyPngAdapter {
  constructor(private readonly baseUrl = "https://api.tinify.com") {}

  async validateKey(key: string): Promise<{ valid: boolean; compressionCount: number | null }> {
    try {
      const response = await fetch(`${this.baseUrl}/shrink`, {
        method: "POST",
        headers: { Authorization: authHeader(key), "Content-Type": "application/octet-stream" },
        body: new Uint8Array(0),
        signal: AbortSignal.timeout(15_000)
      });
      const count = Number.parseInt(response.headers.get("compression-count") ?? "", 10);
      if (response.status === 401 || response.status === 403) return { valid: false, compressionCount: Number.isNaN(count) ? null : count };
      if ([400, 415, 429].includes(response.status)) return { valid: true, compressionCount: Number.isNaN(count) ? null : count };
      if (response.ok) return { valid: true, compressionCount: Number.isNaN(count) ? null : count };
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

    let output: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const candidate = await fetch(outputUrl, {
          headers: { Authorization: authHeader(key) },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
        });
        if (candidate.ok) {
          output = candidate;
          break;
        }
        if (candidate.status < 500 && candidate.status !== 429) throw await externalError(candidate);
        if (attempt === 3) throw await externalError(candidate);
      } catch (error) {
        if (signal?.aborted) throw new AppError("APP_SHUTDOWN", "应用退出，TinyPNG 请求已取消", 503);
        if (error instanceof AppError && !["RATE_LIMITED", "SERVER_TEMPORARY"].includes(error.code)) throw error;
        if (attempt === 3) throw new AppError("DOWNLOAD_FAILED", "压缩已完成，但结果下载失败；请手动重试", 503);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 500 : 1500));
    }
    if (!output) throw new AppError("DOWNLOAD_FAILED", "压缩已完成，但结果下载失败；请手动重试", 503);
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
