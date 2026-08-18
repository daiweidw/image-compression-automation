import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import type { SecretStore } from "../../server/src/infrastructure/secret-store.js";
import { startLocalRuntime, type LocalRuntime } from "../../server/src/runtime.js";
import { runStartupWithTimeout, StartupTimeoutError } from "./startup-coordinator.js";

const STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_CLOSE_URL = "ica-startup://close";

type StartupState = "starting" | "ready" | "failed" | "closing";

class SafeStorageSecretStore implements SecretStore {
  private readonly directory: string;
  private readonly legacyEncryptedPath: string;
  private readonly legacyPlaintextPath: string;

  constructor(private readonly dataDir: string) {
    this.directory = path.join(dataDir, "secrets", "tinypng");
    this.legacyEncryptedPath = path.join(dataDir, "secrets", "tinypng.safe-storage");
    this.legacyPlaintextPath = path.join(dataDir, "secrets", "tinypng.key");
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
      if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS 安全存储当前不可用");
      return safeStorage.decryptString(await fs.readFile(this.keyPath(keyId))).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async setTinyPngKey(keyId: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS 安全存储当前不可用，API Key 未保存");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = this.keyPath(keyId);
    const temporary = `${keyPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, safeStorage.encryptString(value.trim()), { mode: 0o600 });
    await fs.rename(temporary, keyPath);
  }

  async deleteTinyPngKey(keyId: string): Promise<void> {
    await fs.rm(this.keyPath(keyId), { force: true });
  }

  async getLegacyTinyPngKey(): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS 安全存储当前不可用");
    try {
      return safeStorage.decryptString(await fs.readFile(this.legacyEncryptedPath)).trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      return (await fs.readFile(this.legacyPlaintextPath, "utf8")).trim() || null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async deleteLegacyTinyPngKey(): Promise<void> {
    await Promise.all([
      fs.rm(this.legacyEncryptedPath, { force: true }),
      fs.rm(this.legacyPlaintextPath, { force: true })
    ]);
  }

  private keyPath(keyId: string): string {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(keyId)) throw new Error("API Key ID 无效");
    return path.join(this.directory, `${keyId}.safe-storage`);
  }
}

let mainWindow: BrowserWindow | null = null;
let runtime: LocalRuntime | null = null;
let quitting = false;
let startupState: StartupState = "starting";
let startupController: AbortController | null = null;
let startupCleanupPromise: Promise<void> | null = null;

function pageUrl(content: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(content)}`;
}

function loadingPageUrl(): string {
  return pageUrl(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="color-scheme" content="light"><title>图片压缩工作台</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f3f5f4;color:#26332f;font:15px system-ui}.loading{display:flex;align-items:center;gap:12px}.dot{width:10px;height:10px;border-radius:50%;background:#147d64;animation:pulse 1s ease-in-out infinite}@keyframes pulse{50%{opacity:.3;transform:scale(.8)}}@media(prefers-reduced-motion:reduce){.dot{animation:none}}</style><div class="loading" role="status"><span class="dot" aria-hidden="true"></span><strong>正在启动图片压缩工作台</strong></div></html>`);
}

function failurePageUrl(timedOut: boolean): string {
  const description = timedOut
    ? `图片压缩工作台未能在 ${STARTUP_TIMEOUT_MS / 1_000} 秒内完成启动。`
    : "图片压缩工作台启动时遇到错误。";
  return pageUrl(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>图片压缩工作台启动失败</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f3f5f4;color:#26332f;font:15px system-ui}.failure{text-align:center;max-width:420px;padding:32px}h1{font-size:22px;margin:0 0 14px}p{line-height:1.7;margin:0;color:#5e6b67}.action{display:inline-flex;align-items:center;justify-content:center;margin-top:28px;min-width:112px;height:40px;padding:0 18px;border-radius:6px;background:#147d64;color:#fff;text-decoration:none;font-weight:650}.action:focus-visible{outline:3px solid #8bc9b8;outline-offset:3px}</style><main class="failure"><h1>启动失败</h1><p>${description}<br>请关闭应用后重新打开。</p><a class="action" href="${STARTUP_CLOSE_URL}">关闭应用</a></main></html>`);
}

async function appendDesktopLog(dataDir: string, event: string, details: Record<string, unknown> = {}): Promise<void> {
  try {
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(logDirectory, "desktop.log"), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      version: app.getVersion(),
      event,
      ...details
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("写入桌面启动日志失败", error);
  }
}

function errorDetails(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { errorName: error.name, errorMessage: error.message } : { errorMessage: String(error) };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: true,
    title: "图片压缩工作台",
    backgroundColor: "#f3f5f4",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  void window.loadURL(loadingPageUrl());
  return window;
}

function isRuntimeNavigation(url: string): boolean {
  if (!runtime) return false;
  try {
    return new URL(url).origin === new URL(runtime.address).origin;
  } catch {
    return false;
  }
}

function isStartupCloseNavigation(url: string): boolean {
  try {
    const candidate = new URL(url);
    return candidate.protocol === "ica-startup:" && candidate.hostname === "close";
  } catch {
    return false;
  }
}

async function closeFailedApplication(): Promise<void> {
  if (startupState !== "failed") return;
  startupState = "closing";
  quitting = true;
  startupController?.abort(new Error("用户关闭启动失败的应用"));
  await startupCleanupPromise;
  app.quit();
}

async function startApplication(): Promise<void> {
  app.setName("图片压缩工作台");
  startupState = "starting";
  startupController = new AbortController();
  mainWindow = createMainWindow();
  const window = mainWindow;
  mainWindow.on("close", (event) => {
    if (!quitting && startupState === "failed") {
      event.preventDefault();
      void closeFailedApplication();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    startupController?.abort(new Error("启动窗口已关闭"));
    if (!quitting) app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (startupState === "ready" && url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (startupState === "failed" && isStartupCloseNavigation(url)) {
      event.preventDefault();
      void closeFailedApplication();
      return;
    }
    if ((startupState === "starting" || startupState === "failed") && url.startsWith("data:text/html;charset=utf-8,")) return;
    if (!["starting", "ready"].includes(startupState) || !isRuntimeNavigation(url)) event.preventDefault();
  });

  const dataDir = process.env.ICA_DESKTOP_DATA_DIR
    ? path.resolve(process.env.ICA_DESKTOP_DATA_DIR)
    : path.join(app.getPath("appData"), "Image Compression Automation");
  const webRoot = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.resolve(import.meta.dirname, "../../web/dist");
  const startedAt = Date.now();
  const secrets = new SafeStorageSecretStore(dataDir);
  void appendDesktopLog(dataDir, "startup.started");

  try {
    const nextRuntime = await runStartupWithTimeout({
      controller: startupController,
      timeoutMs: STARTUP_TIMEOUT_MS,
      prepare: async (signal) => {
        signal.throwIfAborted();
      },
      start: async (signal) => {
        return startLocalRuntime({
          appDataDir: dataDir,
          webRoot,
          port: Number.parseInt(process.env.ICA_DESKTOP_TEST_PORT ?? "0", 10),
          production: true,
          secretStore: secrets,
          writeRuntimeFile: false,
          startupSignal: signal,
          onBackgroundError: (error) => appendDesktopLog(dataDir, "startup.background-degraded", errorDetails(error)),
          platform: {
            capabilities: {
              desktop: true,
              nativeDirectoryPicker: true,
              fileDropPaths: true,
              revealInFinder: true,
              encryptedSecretStorage: safeStorage.isEncryptionAvailable()
            },
            downloadsPath: app.getPath("downloads"),
            chooseDirectory: async (_kind, currentPath) => {
              if (!mainWindow) return null;
              const result = await dialog.showOpenDialog(mainWindow, {
                title: "选择文件夹",
                ...(currentPath ? { defaultPath: currentPath } : {}),
                properties: ["openDirectory", "createDirectory"]
              });
              return result.canceled ? null : result.filePaths[0] ?? null;
            },
            revealPath: async (targetPath) => {
              const stat = await fs.stat(targetPath).catch(() => null);
              if (stat?.isDirectory()) await shell.openPath(targetPath);
              else shell.showItemInFolder(targetPath);
            }
          },
          onShutdown: () => {
            quitting = true;
            app.quit();
          }
        });
      },
      load: async (candidate, signal) => {
        signal.throwIfAborted();
        runtime = candidate;
        await window.loadURL(candidate.address);
      },
      onCleanupError: (error) => {
        console.error("启动超时后的运行时清理失败", error);
        void appendDesktopLog(dataDir, "startup.cleanup-failed", errorDetails(error));
      }
    });
    if (startupState !== "starting" || window.isDestroyed()) {
      runtime = null;
      await nextRuntime.dispose();
      return;
    }
    runtime = nextRuntime;
    startupState = "ready";
    await appendDesktopLog(dataDir, "startup.ready", { durationMs: Date.now() - startedAt, address: nextRuntime.address });
  } catch (error) {
    const failedRuntime = runtime;
    runtime = null;
    if (quitting || window.isDestroyed()) return;
    if (failedRuntime) {
      startupCleanupPromise = failedRuntime.dispose().catch((cleanupError) => {
        console.error("启动失败后的运行时清理失败", cleanupError);
        void appendDesktopLog(dataDir, "startup.cleanup-failed", errorDetails(cleanupError));
      });
    }
    startupState = "failed";
    window.webContents.stop();
    const timedOut = error instanceof StartupTimeoutError;
    console.error("图片压缩工作台启动失败", error);
    void appendDesktopLog(dataDir, timedOut ? "startup.timed-out" : "startup.failed", {
      durationMs: Date.now() - startedAt,
      ...errorDetails(error)
    });
    if (!window.isDestroyed()) await window.loadURL(failurePageUrl(timedOut));
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (mainWindow) mainWindow.show();
  });

  app.on("before-quit", (event) => {
    if (quitting || !runtime) return;
    event.preventDefault();
    quitting = true;
    void runtime.shutdown().finally(() => app.quit());
  });

  void app.whenReady().then(startApplication).catch((error: unknown) => {
    console.error("图片压缩工作台启动失败", error);
    dialog.showErrorBox("图片压缩工作台无法启动", error instanceof Error ? error.message : String(error));
    quitting = true;
    app.quit();
  });
}
