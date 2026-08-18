import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const testRoot = path.join(projectRoot, ".ica-test");
export const runsRoot = path.join(testRoot, "runs");
export const artifactsRoot = path.join(testRoot, "artifacts");
export const pidRoot = path.join(testRoot, "pids");
export const nativeRoot = path.join(testRoot, "native");
export const fixtureRoot = path.join(testRoot, "fixtures");
export const npmCacheRoot = path.join(testRoot, "npm-cache");
export const nodeGypRoot = path.join(testRoot, "node-gyp");

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
    env: {
      ...process.env,
      npm_config_offline: "true",
      npm_config_cache: npmCacheRoot,
      npm_config_devdir: nodeGypRoot,
      ...options.env
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 失败，退出码 ${result.status ?? "unknown"}`);
}

export async function packageInfo() {
  const electronPackagePath = await fs.realpath(path.join(projectRoot, "node_modules", "electron", "package.json"));
  const electronPackageDir = path.dirname(electronPackagePath);
  const electronPackage = JSON.parse(await fs.readFile(electronPackagePath, "utf8"));
  const betterSqliteEntry = await fs.realpath(path.join(projectRoot, "node_modules", "better-sqlite3"));
  const betterSqlitePackage = JSON.parse(await fs.readFile(path.join(betterSqliteEntry, "package.json"), "utf8"));
  return {
    electronPackageDir,
    electronVersion: electronPackage.version,
    electronAbi: Number((await fs.readFile(path.join(electronPackageDir, "abi_version"), "utf8")).trim()),
    betterSqliteDir: betterSqliteEntry,
    betterSqliteVersion: betterSqlitePackage.version,
    bindingPath: path.join(betterSqliteEntry, "build", "Release", "better_sqlite3.node"),
    nodeAbi: Number(process.versions.modules),
    arch: process.arch,
    platform: process.platform
  };
}

export function inspectAddonAbi(bindingPath) {
  const probe = spawnSync(process.execPath, [
    "-e",
    "const m={exports:{}};try{process.dlopen(m,process.argv[1]);process.stdout.write(process.versions.modules)}catch(e){process.stderr.write(String(e&&e.stack||e));process.exit(1)}",
    bindingPath
  ], { encoding: "utf8" });
  if (probe.status === 0) return Number(probe.stdout.trim());
  const mismatch = `${probe.stdout}\n${probe.stderr}`.match(/NODE_MODULE_VERSION\s+(\d+)/);
  if (mismatch) return Number(mismatch[1]);
  throw new Error(`无法识别原生模块 ABI：${probe.stderr.trim()}`);
}

export function nativeCachePath(info, abi) {
  return path.join(nativeRoot, `${info.platform}-${info.arch}`, `better-sqlite3-${info.betterSqliteVersion}-abi${abi}.node`);
}

export async function nodeGypPath() {
  const pnpmModules = path.join(projectRoot, "node_modules", ".pnpm");
  const entries = await fs.readdir(pnpmModules, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-gyp@"))
    .map((entry) => path.join(pnpmModules, entry.name, "node_modules", "node-gyp", "bin", "node-gyp.js"));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next locally installed node-gyp package.
    }
  }
  throw new Error("本地依赖中缺少 node-gyp，测试准备已停止，不会下载");
}

export async function cacheCurrentBinding(info) {
  const abi = inspectAddonAbi(info.bindingPath);
  const cachePath = nativeCachePath(info, abi);
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.copyFile(info.bindingPath, cachePath);
  return abi;
}

export async function useNativeAbi(info, abi) {
  const cachePath = nativeCachePath(info, abi);
  await fs.access(cachePath);
  await fs.mkdir(path.dirname(info.bindingPath), { recursive: true });
  const temporary = `${info.bindingPath}.${process.pid}.${abi}.tmp`;
  try {
    await fs.copyFile(cachePath, temporary);
    await fs.rename(temporary, info.bindingPath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const actual = inspectAddonAbi(info.bindingPath);
  if (actual !== abi) throw new Error(`原生模块 ABI 切换失败：期望 ${abi}，实际 ${actual}`);
}

async function findFile(root, filename) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isFile() && entry.name === filename) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = await findFile(path.join(root, entry.name), filename);
    if (match) return match;
  }
  return null;
}

export async function electronAssets(info) {
  if (info.platform !== "darwin" || info.arch !== "arm64") {
    throw new Error("当前测试区只支持 Apple Silicon macOS");
  }
  const archiveName = `electron-v${info.electronVersion}-darwin-arm64.zip`;
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "electron");
  const archivePath = await findFile(cacheRoot, archiveName);
  if (!archivePath) throw new Error(`离线缓存中缺少 ${archiveName}，测试准备已停止，不会下载`);
  const checksums = JSON.parse(await fs.readFile(path.join(info.electronPackageDir, "checksums.json"), "utf8"));
  const expectedHash = checksums[archiveName];
  if (!expectedHash) throw new Error(`Electron 校验文件中缺少 ${archiveName}`);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(archivePath)) hash.update(chunk);
  const actualHash = hash.digest("hex");
  if (actualHash !== expectedHash) throw new Error(`Electron 离线缓存校验失败：${archiveName}`);
  const runtimeDir = path.join(testRoot, "electron", `${info.electronVersion}-darwin-arm64`);
  const executablePath = path.join(runtimeDir, "Electron.app", "Contents", "MacOS", "Electron");
  return { archiveName, archivePath, expectedHash, runtimeDir, executablePath };
}

export async function ensureElectronRuntime(assets) {
  try {
    await fs.access(assets.executablePath, fsSync.constants.X_OK);
    return;
  } catch {
    await fs.rm(assets.runtimeDir, { recursive: true, force: true });
  }
  await fs.mkdir(assets.runtimeDir, { recursive: true });
  run("unzip", ["-q", assets.archivePath, "-d", assets.runtimeDir]);
  await fs.access(assets.executablePath, fsSync.constants.X_OK);
}

export async function ensurePrepared() {
  const manifestPath = path.join(testRoot, "manifest.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const info = await packageInfo();
    const assets = await electronAssets(info);
    if (manifest.electronVersion !== info.electronVersion || manifest.betterSqliteVersion !== info.betterSqliteVersion) {
      throw new Error("测试缓存版本已变化");
    }
    await Promise.all([
      fs.access(assets.executablePath, fsSync.constants.X_OK),
      fs.access(nativeCachePath(info, info.nodeAbi)),
      fs.access(nativeCachePath(info, info.electronAbi))
    ]);
    return { info, assets, manifest };
  } catch {
    run(process.execPath, [path.join(projectRoot, "scripts", "test", "prepare.mjs")]);
    const info = await packageInfo();
    const assets = await electronAssets(info);
    const manifest = JSON.parse(await fs.readFile(path.join(testRoot, "manifest.json"), "utf8"));
    return { info, assets, manifest };
  }
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}
