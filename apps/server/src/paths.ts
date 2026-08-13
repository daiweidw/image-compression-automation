import os from "node:os";
import path from "node:path";

export function getAppDataDir(): string {
  const override = process.env.IMAGE_COMPRESSION_APP_DATA_DIR;
  if (override) return path.resolve(override);

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Image Compression Automation");
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? os.homedir(), "Image Compression Automation");
  }

  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "image-compression-automation");
}

export function getWebDistDir(): string {
  return path.resolve(import.meta.dirname, "../../web/dist");
}
