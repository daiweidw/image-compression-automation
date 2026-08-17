import fs from "node:fs/promises";
import path from "node:path";
import {
  cacheCurrentBinding,
  electronAssets,
  ensureElectronRuntime,
  fixtureRoot,
  inspectAddonAbi,
  nativeCachePath,
  nodeGypPath,
  packageInfo,
  projectRoot,
  run,
  testRoot,
  useNativeAbi,
  writeJson
} from "./common.mjs";

async function ensureFixture() {
  const source = path.join(projectRoot, "tests", "fixtures", "images", "pixel.png.base64");
  const target = path.join(fixtureRoot, "pixel.png");
  try {
    await fs.access(target);
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from((await fs.readFile(source, "utf8")).trim(), "base64"));
  }
}

async function main() {
  const info = await packageInfo();
  const assets = await electronAssets(info);
  await fs.mkdir(testRoot, { recursive: true });
  await ensureElectronRuntime(assets);
  await ensureFixture();

  const nodeCache = nativeCachePath(info, info.nodeAbi);
  const electronCache = nativeCachePath(info, info.electronAbi);
  let currentAbi;
  try {
    currentAbi = await cacheCurrentBinding(info);
  } catch (error) {
    try {
      await fs.access(info.bindingPath);
      throw error;
    } catch (accessError) {
      if (accessError?.code !== "ENOENT") throw error;
      await useNativeAbi(info, info.electronAbi);
      currentAbi = info.electronAbi;
    }
  }

  if (currentAbi !== info.electronAbi) {
    try {
      await fs.access(electronCache);
    } catch {
      throw new Error(`缺少 Electron ABI ${info.electronAbi} 的 better-sqlite3 离线缓存，测试准备已停止，不会下载或在线重建`);
    }
  }

  try {
    await fs.access(nodeCache);
  } catch {
    run(process.execPath, [await nodeGypPath(), "rebuild", "--release"], {
      cwd: info.betterSqliteDir,
      env: { npm_config_nodedir: path.resolve(path.dirname(process.execPath), "..") }
    });
    const rebuiltAbi = inspectAddonAbi(info.bindingPath);
    if (rebuiltAbi !== info.nodeAbi) throw new Error(`Node 原生模块 ABI 应为 ${info.nodeAbi}，实际为 ${rebuiltAbi}`);
    await cacheCurrentBinding(info);
  }

  await Promise.all([fs.access(nodeCache), fs.access(electronCache)]);
  await useNativeAbi(info, info.nodeAbi);
  await writeJson(path.join(testRoot, "manifest.json"), {
    version: 1,
    platform: info.platform,
    arch: info.arch,
    nodeVersion: process.version,
    nodeAbi: info.nodeAbi,
    electronVersion: info.electronVersion,
    electronAbi: info.electronAbi,
    betterSqliteVersion: info.betterSqliteVersion,
    electronArchive: assets.archivePath,
    electronArchiveSha256: assets.expectedHash,
    preparedAt: new Date().toISOString()
  });
  console.log(`测试区已准备：${testRoot}`);
  console.log(`默认原生模块 ABI：Node ${info.nodeAbi}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
