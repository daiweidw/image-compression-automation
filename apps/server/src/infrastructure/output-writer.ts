import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { ulid } from "ulid";
import { AppError } from "../errors.js";
import { PathPolicy } from "./path-policy.js";
import type { TinyPngResult } from "./tinypng-adapter.js";

export interface WrittenOutput {
  relativePath: string;
  size: number;
  hash: string;
  mtimeNs: string;
  mimeType: string;
}

export class OutputWriter {
  constructor(private readonly pathPolicy: PathPolicy) {}

  async write(root: string, relativePath: string, result: TinyPngResult, allowOverwrite: boolean): Promise<WrittenOutput> {
    const target = this.pathPolicy.resolveWithin(root, relativePath);
    const directory = path.dirname(target);
    await this.pathPolicy.assertNoSymlink(root, directory);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.pathPolicy.assertNoSymlink(root, directory);
    try {
      const existing = await fsp.lstat(target);
      if (existing.isSymbolicLink() || !allowOverwrite) throw new AppError("OUTPUT_CONFLICT", "结果路径已有非本工具文件", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = path.join(directory, `.${path.basename(target)}.${ulid()}.tmp`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      }
    });
    try {
      await pipeline(result.stream, meter, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (size <= 0 || (result.contentLength != null && size !== result.contentLength)) {
        throw new AppError("INVALID_REMOTE_RESPONSE", "压缩结果不完整", 502);
      }
      const metadata = await sharp(temporary, { failOn: "error" }).metadata();
      const actualMime = metadata.format === "jpg" ? "image/jpeg" : `image/${metadata.format}`;
      if (!metadata.format || actualMime !== result.mimeType) throw new AppError("OUTPUT_FORMAT_MISMATCH", "压缩结果格式异常", 502);
      const handle = await fsp.open(temporary, "r");
      await handle.sync();
      await handle.close();
      await fsp.rename(temporary, target);
      const stat = await fsp.stat(target, { bigint: true });
      return { relativePath, size, hash: hash.digest("hex"), mtimeNs: stat.mtimeNs.toString(), mimeType: actualMime };
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
