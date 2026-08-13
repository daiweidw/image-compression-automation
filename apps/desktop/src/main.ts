import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import type { SecretStore } from "../../server/src/infrastructure/secret-store.js";
import { startLocalRuntime, type LocalRuntime } from "../../server/src/runtime.js";

class SafeStorageSecretStore implements SecretStore {
  private readonly encryptedPath: string;
  private readonly legacyPath: string;

  constructor(private readonly dataDir: string) {
    this.encryptedPath = path.join(dataDir, "secrets", "tinypng.safe-storage");
    this.legacyPath = path.join(dataDir, "secrets", "tinypng.key");
  }

  async migrateLegacy(): Promise<void> {
    try {
      await fs.access(this.encryptedPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const legacy = (await fs.readFile(this.legacyPath, "utf8")).trim();
      if (!legacy) return;
      await this.setTinyPngKey(legacy);
      if ((await this.getTinyPngKey()) === legacy) await fs.rm(this.legacyPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async hasTinyPngKey(): Promise<boolean> {
    try {
      await fs.access(this.encryptedPath);
      return true;
    } catch {
      return false;
    }
  }

  async getTinyPngKey(): Promise<string | null> {
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS 安全存储当前不可用");
      return safeStorage.decryptString(await fs.readFile(this.encryptedPath)).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async setTinyPngKey(value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS 安全存储当前不可用，API Key 未保存");
    const directory = path.dirname(this.encryptedPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.encryptedPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, safeStorage.encryptString(value.trim()), { mode: 0o600 });
    await fs.rename(temporary, this.encryptedPath);
  }

  async deleteTinyPngKey(): Promise<void> {
    await Promise.all([fs.rm(this.encryptedPath, { force: true }), fs.rm(this.legacyPath, { force: true })]);
  }
}

let mainWindow: BrowserWindow | null = null;
let runtime: LocalRuntime | null = null;
let quitting = false;

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  const loadingPage = encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>图片压缩工作台</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f3f5f4;color:#26332f;font:15px system-ui}.loading{display:flex;align-items:center;gap:12px}.dot{width:10px;height:10px;border-radius:50%;background:#147d64;animation:pulse 1s ease-in-out infinite}@keyframes pulse{50%{opacity:.3;transform:scale(.8)}}</style><div class="loading"><span class="dot"></span><strong>正在启动图片压缩工作台</strong></div></html>`);
  void window.loadURL(`data:text/html;charset=utf-8,${loadingPage}`);
  return window;
}

async function startApplication(): Promise<void> {
  app.setName("图片压缩工作台");
  mainWindow = createMainWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });

  const dataDir = process.env.ICA_DESKTOP_DATA_DIR
    ? path.resolve(process.env.ICA_DESKTOP_DATA_DIR)
    : path.join(app.getPath("appData"), "Image Compression Automation");
  const secrets = new SafeStorageSecretStore(dataDir);
  await secrets.migrateLegacy();
  const webRoot = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.resolve(import.meta.dirname, "../../web/dist");
  runtime = await startLocalRuntime({
    appDataDir: dataDir,
    webRoot,
    port: Number.parseInt(process.env.ICA_DESKTOP_TEST_PORT ?? "0", 10),
    production: true,
    secretStore: secrets,
    writeRuntimeFile: false,
    platform: {
      capabilities: {
        desktop: true,
        nativeDirectoryPicker: true,
        revealInFinder: true,
        encryptedSecretStorage: safeStorage.isEncryptionAvailable()
      },
      chooseDirectory: async (_kind, currentPath) => {
        const result = await dialog.showOpenDialog(mainWindow!, {
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
      mainWindow?.close();
      app.quit();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(runtime!.address)) event.preventDefault();
  });
  await mainWindow.loadURL(runtime.address);
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
