import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";

export interface SecretStore {
  hasTinyPngKey(): Promise<boolean>;
  getTinyPngKey(): Promise<string | null>;
  setTinyPngKey(value: string): Promise<void>;
  deleteTinyPngKey(): Promise<void>;
}

export class FileSecretStore implements SecretStore {
  private readonly directory: string;
  private readonly keyPath: string;

  constructor(appDataDir: string) {
    this.directory = path.join(appDataDir, "secrets");
    this.keyPath = path.join(this.directory, "tinypng.key");
  }

  async hasTinyPngKey(): Promise<boolean> {
    try {
      await fs.access(this.keyPath);
      return true;
    } catch {
      return false;
    }
  }

  async getTinyPngKey(): Promise<string | null> {
    try {
      const stat = await fs.stat(this.keyPath);
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new Error("API Key 文件权限不安全，请删除后重新保存");
      }
      return (await fs.readFile(this.keyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async setTinyPngKey(value: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
    const temporary = path.join(this.directory, `.tinypng-${ulid()}.tmp`);
    await fs.writeFile(temporary, value.trim(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, this.keyPath);
    if (process.platform !== "win32") await fs.chmod(this.keyPath, 0o600);
  }

  async deleteTinyPngKey(): Promise<void> {
    await fs.rm(this.keyPath, { force: true });
  }
}
