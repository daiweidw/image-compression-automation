import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import { AppError } from "../errors.js";
import type { SettingsService } from "./settings-service.js";

export interface OutputRootAllocation {
  path: string;
  createdForSession: boolean;
}

function batchDirectoryName(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `图片压缩_${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}_${part(date.getHours())}-${part(date.getMinutes())}-${part(date.getSeconds())}`;
}

export class SessionOutputService {
  private sessionOutputRoot: string | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly db: Database.Database, private readonly settings: SettingsService) {}

  current(): string | null {
    return this.sessionOutputRoot;
  }

  async resolve(): Promise<OutputRootAllocation> {
    return this.serialized(async () => {
      const settings = await this.settings.load();
      if (!settings) throw new AppError("SETTINGS_REQUIRED", "应用尚未完成初始化", 409);
      const workspace = this.db.prepare(
        "SELECT output_real_path FROM workspaces WHERE active=1 LIMIT 1"
      ).get() as { output_real_path: string } | undefined;
      if (!workspace) throw new AppError("SETTINGS_REQUIRED", "应用尚未完成初始化", 409);

      if (settings.outputMode === "custom") {
        return { path: workspace.output_real_path, createdForSession: false };
      }
      if (this.sessionOutputRoot) {
        return { path: this.sessionOutputRoot, createdForSession: false };
      }

      await fs.mkdir(workspace.output_real_path, { recursive: true, mode: 0o700 });
      const baseName = batchDirectoryName(new Date());
      for (let index = 1; index <= 10_000; index += 1) {
        const candidate = path.join(workspace.output_real_path, index === 1 ? baseName : `${baseName}-${index}`);
        try {
          await fs.mkdir(candidate, { mode: 0o700 });
          this.sessionOutputRoot = candidate;
          return { path: candidate, createdForSession: true };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      throw new AppError("OUTPUT_DIRECTORY_CONFLICT", "无法创建本次会话的结果文件夹", 409);
    });
  }

  async releaseIfUnused(outputRoot: string): Promise<void> {
    await this.serialized(async () => {
      if (this.sessionOutputRoot !== outputRoot) return;
      const referenced = this.db.prepare(
        "SELECT 1 FROM compression_jobs WHERE output_root_path=? LIMIT 1"
      ).get(outputRoot);
      if (referenced) return;
      try {
        await fs.rmdir(outputRoot);
        this.sessionOutputRoot = null;
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") this.sessionOutputRoot = null;
      }
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
