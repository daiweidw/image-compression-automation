import fs from "node:fs/promises";
import path from "node:path";
import { electronAssets, inspectAddonAbi, nativeCachePath, packageInfo, pidRoot, testRoot } from "./common.mjs";

async function main() {
  const info = await packageInfo();
  const assets = await electronAssets(info);
  const manifest = JSON.parse(await fs.readFile(path.join(testRoot, "manifest.json"), "utf8"));
  const currentAbi = inspectAddonAbi(info.bindingPath);
  const problems = [];
  if (currentAbi !== info.nodeAbi) problems.push(`当前 better-sqlite3 ABI 为 ${currentAbi}，默认应为 Node ABI ${info.nodeAbi}`);
  if (manifest.electronVersion !== info.electronVersion) problems.push("Electron 测试缓存版本已过期");
  await Promise.all([
    fs.access(assets.executablePath),
    fs.access(nativeCachePath(info, info.nodeAbi)),
    fs.access(nativeCachePath(info, info.electronAbi))
  ]);
  const pidFiles = await fs.readdir(pidRoot).catch(() => []);
  for (const file of pidFiles) {
    const record = JSON.parse(await fs.readFile(path.join(pidRoot, file), "utf8"));
    try {
      process.kill(record.pid, 0);
      problems.push(`仍有测试进程运行：PID ${record.pid} (${file})`);
    } catch {
      // A stale PID record is reported by clean, but does not make the environment unsafe.
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  console.log(`测试区正常：${testRoot}`);
  console.log(`Node ABI ${info.nodeAbi}；Electron ${info.electronVersion} / ABI ${info.electronAbi}`);
  console.log("Electron ZIP 校验通过；测试命令默认离线。 ");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
