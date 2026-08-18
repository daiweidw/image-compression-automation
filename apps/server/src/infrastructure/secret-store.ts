import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";

export interface SecretStore {
  hasTinyPngKey(keyId: string): Promise<boolean>;
  getTinyPngKey(keyId: string): Promise<string | null>;
  setTinyPngKey(keyId: string, value: string): Promise<void>;
  deleteTinyPngKey(keyId: string): Promise<void>;
  getLegacyTinyPngKey(): Promise<string | null>;
  deleteLegacyTinyPngKey(): Promise<void>;
}

export class FileSecretStore implements SecretStore {
  private readonly directory: string;
  private readonly legacyKeyPath: string;

  constructor(appDataDir: string) {
    this.directory = path.join(appDataDir, "secrets", "tinypng");
    this.legacyKeyPath = path.join(appDataDir, "secrets", "tinypng.key");
  }

  async hasTinyPngKey(keyId: string): Promise<boolean> {
    try {
      await fs.access(this.keyPath(keyId));
      return true;
    } catch {
      return false;
    }
  }

  async getTinyPngKey(keyId: string): Promise<string | null> {
    try {
      const keyPath = this.keyPath(keyId);
      const stat = await fs.stat(keyPath);
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new Error("API Key 文件权限不安全，请删除后重新保存");
      }
      return (await fs.readFile(keyPath, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async setTinyPngKey(keyId: string, value: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
    const keyPath = this.keyPath(keyId);
    const temporary = path.join(this.directory, `.tinypng-${ulid()}.tmp`);
    await fs.writeFile(temporary, value.trim(), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, keyPath);
    if (process.platform !== "win32") await fs.chmod(keyPath, 0o600);
  }

  async deleteTinyPngKey(keyId: string): Promise<void> {
    await fs.rm(this.keyPath(keyId), { force: true });
  }

  async getLegacyTinyPngKey(): Promise<string | null> {
    try {
      return (await fs.readFile(this.legacyKeyPath, "utf8")).trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async deleteLegacyTinyPngKey(): Promise<void> {
    await fs.rm(this.legacyKeyPath, { force: true });
  }

  private keyPath(keyId: string): string {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId)) throw new Error("API Key ID 无效");
    return path.join(this.directory, `${keyId}.key`);
  }
}
