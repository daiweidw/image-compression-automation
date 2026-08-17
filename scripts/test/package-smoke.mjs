import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePrepared, projectRoot, run, runsRoot, useNativeAbi } from "./common.mjs";

const { info } = await ensurePrepared();
await useNativeAbi(info, info.nodeAbi);
run(process.execPath, [path.join(projectRoot, "scripts", "test", "package-offline.mjs")]);
const releaseDir = path.join(projectRoot, "release");
const archives = (await fs.readdir(releaseDir))
  .filter((name) => name.endsWith("-mac-arm64.zip"))
  .map((name) => path.join(releaseDir, name));
if (!archives.length) throw new Error("没有找到本次 arm64 ZIP 打包产物");
const stats = await Promise.all(archives.map(async (archive) => ({ archive, stat: await fs.stat(archive) })));
stats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
const runDirectory = path.join(runsRoot, "package-smoke");
const unpackDirectory = path.join(runDirectory, "unpacked");
await fs.rm(runDirectory, { recursive: true, force: true });
await fs.mkdir(unpackDirectory, { recursive: true });
run("ditto", ["-x", "-k", stats[0].archive, unpackDirectory]);
const appName = (await fs.readdir(unpackDirectory)).find((name) => name.endsWith(".app"));
if (!appName) throw new Error("打包 ZIP 中没有 .app");
const executable = path.join(unpackDirectory, appName, "Contents", "MacOS", "图片压缩工作台");
const child = spawn(executable, [], {
  cwd: projectRoot,
  env: { ...process.env, ICA_DESKTOP_DATA_DIR: path.join(runDirectory, "app-data"), ICA_DESKTOP_TEST_PORT: "0" },
  stdio: "ignore"
});

async function stopChild() {
  if (child.exitCode != null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timeout;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), 5_000);
    timeout.unref();
  });
  const stopped = await Promise.race([
    exited.then(() => true),
    timedOut
  ]);
  clearTimeout(timeout);
  if (stopped || child.exitCode != null) return;
  child.kill("SIGKILL");
  await exited;
}

try {
  const logPath = path.join(runDirectory, "app-data", "logs", "desktop.log");
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const log = await fs.readFile(logPath, "utf8").catch(() => "");
    ready = log.includes('"event":"startup.ready"');
    if (child.exitCode != null) throw new Error(`打包应用提前退出，退出码 ${child.exitCode}`);
  }
  if (!ready) throw new Error("打包应用未在 20 秒内完成启动");
  console.log(`打包应用冒烟测试通过：${stats[0].archive}`);
} finally {
  await stopChild();
  await useNativeAbi(info, info.nodeAbi);
}
