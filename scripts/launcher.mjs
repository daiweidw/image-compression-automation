import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const applicationId = "image-compression-automation";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(os.homedir(), "Library", "Application Support", "Image Compression Automation");
const runtimeFile = path.join(dataDir, "runtime.json");
const startupLock = path.join(dataDir, "startup.lock");
const logDir = path.join(dataDir, "logs");
const serverEntry = path.join(root, "apps", "server", "dist", "index.js");
const noOpen = process.argv.includes("--no-open");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isLocalAppUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0;
  } catch {
    return false;
  }
}

async function readRuntime() {
  try {
    const runtime = JSON.parse(await fsp.readFile(runtimeFile, "utf8"));
    return typeof runtime?.url === "string" && isLocalAppUrl(runtime.url) ? runtime : null;
  } catch {
    return null;
  }
}

async function appIsHealthy(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.data?.application === applicationId && payload.data.shuttingDown === false;
  } catch {
    return false;
  }
}

async function findRunningApp() {
  const runtime = await readRuntime();
  if (runtime && await appIsHealthy(runtime.url)) return runtime.url;
  const defaultUrl = "http://127.0.0.1:43127";
  return await appIsHealthy(defaultUrl) ? defaultUrl : null;
}

function openBrowser(url) {
  if (noOpen) return;
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

function commandAvailable(command, args = ["--version"]) {
  return spawnSync(command, args, { cwd: root, stdio: "ignore" }).status === 0;
}

function buildApplication() {
  console.log("首次启动，正在准备应用...");
  const command = commandAvailable("pnpm") ? "pnpm" : commandAvailable("corepack") ? "corepack" : null;
  if (!command) throw new Error("未找到 pnpm。请先安装 pnpm 10，然后重新双击启动。");
  const args = command === "corepack" ? ["pnpm", "build"] : ["build"];
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0 || !fs.existsSync(serverEntry)) throw new Error("应用构建失败，请检查上方错误信息。");
}

async function choosePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 43127 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 43127;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  }).catch(async () => await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("无法分配本地端口"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  }));
}

async function startApplication() {
  if (!fs.existsSync(serverEntry)) buildApplication();
  await fsp.mkdir(logDir, { recursive: true, mode: 0o700 });
  await fsp.rm(runtimeFile, { force: true });
  const port = await choosePort();
  const logPath = path.join(logDir, "launcher.log");
  const log = fs.openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) }
  });
  child.unref();
  fs.closeSync(log);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const runtime = await readRuntime();
    if (runtime && await appIsHealthy(runtime.url)) return runtime.url;
    await wait(250);
  }
  throw new Error(`应用未能正常启动，请查看日志：${logPath}`);
}

async function waitForOtherLauncher() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const running = await findRunningApp();
    if (running) return running;
    await wait(250);
  }
  return null;
}

async function main() {
  await fsp.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const running = await findRunningApp();
  if (running) {
    console.log(`应用已经运行：${running}`);
    openBrowser(running);
    return;
  }

  let lock;
  try {
    lock = await fsp.open(startupLock, "wx", 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const fromOtherLauncher = await waitForOtherLauncher();
    if (fromOtherLauncher) {
      openBrowser(fromOtherLauncher);
      return;
    }
    const stat = await fsp.stat(startupLock).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs <= 30_000) throw new Error("另一个启动过程仍在进行，请稍后重试。");
    await fsp.rm(startupLock, { force: true });
    lock = await fsp.open(startupLock, "wx", 0o600);
  }

  try {
    await lock.writeFile(String(process.pid));
    const url = await startApplication();
    console.log(`图片压缩工作台已启动：${url}`);
    openBrowser(url);
  } finally {
    await lock.close();
    await fsp.rm(startupLock, { force: true });
  }
}

main().catch((error) => {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
