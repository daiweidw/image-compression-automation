import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";

export interface ValidatedRoots {
  sourceDir: string;
  sourceRealPath: string;
  outputDir: string;
  outputRealPath: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class PathPolicy {
  async validateRoots(sourceDir: string, outputDir: string, createOutputDir: boolean): Promise<ValidatedRoots> {
    if (!path.isAbsolute(sourceDir) || !path.isAbsolute(outputDir)) {
      throw new AppError("ABSOLUTE_PATH_REQUIRED", "原图目录和结果目录必须使用绝对路径");
    }

    let sourceRealPath: string;
    try {
      const sourceStat = await fs.stat(sourceDir);
      if (!sourceStat.isDirectory()) throw new Error("not directory");
      await fs.access(sourceDir, fs.constants.R_OK);
      sourceRealPath = await fs.realpath(sourceDir);
    } catch {
      throw new AppError("INVALID_SOURCE_DIRECTORY", "原图目录不存在、不是文件夹或不可读取");
    }

    try {
      await fs.access(outputDir);
    } catch {
      if (!createOutputDir) {
        throw new AppError("OUTPUT_DIRECTORY_CREATION_REQUIRED", "结果目录不存在，需要确认后创建", 409);
      }
      await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    }

    let outputRealPath: string;
    try {
      const outputStat = await fs.stat(outputDir);
      if (!outputStat.isDirectory()) throw new Error("not directory");
      await fs.access(outputDir, fs.constants.R_OK | fs.constants.W_OK);
      outputRealPath = await fs.realpath(outputDir);
    } catch {
      throw new AppError("INVALID_OUTPUT_DIRECTORY", "结果目录不是文件夹或不可写入");
    }

    const normalizedSource = path.normalize(sourceRealPath);
    const normalizedOutput = path.normalize(outputRealPath);
    if (normalizedSource === normalizedOutput || isWithin(normalizedSource, normalizedOutput) || isWithin(normalizedOutput, normalizedSource)) {
      throw new AppError("OVERLAPPING_DIRECTORIES", "原图目录和结果目录不能相同或互相包含");
    }

    return { sourceDir, sourceRealPath, outputDir, outputRealPath };
  }

  resolveWithin(root: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
      throw new AppError("INVALID_RELATIVE_PATH", "文件路径无效");
    }
    const normalized = path.normalize(relativePath);
    const resolved = path.resolve(root, normalized);
    if (!isWithin(root, resolved) || resolved === root) {
      throw new AppError("PATH_OUTSIDE_ROOT", "文件路径超出允许目录", 403);
    }
    return resolved;
  }

  async assertNoSymlink(root: string, target: string): Promise<void> {
    const relative = path.relative(root, target);
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new AppError("SYMLINK_NOT_ALLOWED", "不允许访问符号链接");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }
}
