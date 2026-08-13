import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPackagePath = path.join(root, "node_modules", "electron", "package.json");
const electronCacheRoot = path.join(os.homedir(), "Library", "Caches", "electron");

async function findFile(directory, fileName) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return entryPath;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = await findFile(path.join(directory, entry.name), fileName);
    if (match) return match;
  }

  return null;
}

async function main() {
  const electronPackage = JSON.parse(await fs.readFile(electronPackagePath, "utf8"));
  const version = electronPackage.version;
  if (typeof version !== "string" || !version) throw new Error("无法读取已安装的 Electron 版本");

  const archiveName = `electron-v${version}-darwin-arm64.zip`;
  const electronDist = await findFile(electronCacheRoot, archiveName);
  if (!electronDist) {
    throw new Error([
      `离线打包需要本机缓存文件：${archiveName}`,
      `未在 ${electronCacheRoot} 中找到该文件。`,
      "请联网安装当前 Electron 版本以准备一次缓存，然后重新执行打包。"
    ].join("\n"));
  }

  console.log(`使用本地 Electron 缓存：${electronDist}`);
  console.log("离线模式不会下载 Electron，也不会请求在线校验文件。");

  const builder = path.join(root, "node_modules", ".bin", "electron-builder");
  const result = spawnSync(builder, [
    "--mac",
    "zip",
    "--arm64",
    `--config.electronDist=${electronDist}`
  ], {
    cwd: root,
    env: { ...process.env, ELECTRON_DOWNLOAD_CACHE_MODE: "1" },
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

main().catch((error) => {
  console.error(`离线打包失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
