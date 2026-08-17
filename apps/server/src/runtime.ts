import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DesktopCapabilities } from "@ica/contracts";
import type { SecretStore } from "./infrastructure/secret-store.js";
import { FileSecretStore } from "./infrastructure/secret-store.js";
import { initializeSessionState, openDatabase } from "./infrastructure/database.js";
import { PathPolicy } from "./infrastructure/path-policy.js";
import { TinyPngAdapter } from "./infrastructure/tinypng-adapter.js";
import { TinyPngUsageService } from "./application/tinypng-usage-service.js";
import { OutputWriter } from "./infrastructure/output-writer.js";
import { SettingsService } from "./application/settings-service.js";
import { ScannerService } from "./application/scanner-service.js";
import { ImageService } from "./application/image-service.js";
import { JobService } from "./application/job-service.js";
import { ApplicationLifecycle } from "./application/application-lifecycle.js";
import { SessionOutputService } from "./application/session-output-service.js";
import { ImportAutomationService } from "./application/import-automation-service.js";
import { buildApp, type PlatformIntegration } from "./app.js";
import { getAppDataDir } from "./paths.js";

export interface LocalRuntimeOptions {
  appDataDir?: string;
  webRoot?: string;
  port?: number;
  production?: boolean;
  secretStore?: SecretStore;
  platform?: PlatformIntegration;
  writeRuntimeFile?: boolean;
  onShutdown?: () => void | Promise<void>;
  onBackgroundError?: (error: unknown) => void | Promise<void>;
  startupSignal?: AbortSignal;
}

export interface LocalRuntime {
  address: string;
  backgroundReady: Promise<void>;
  dispose(): Promise<void>;
  shutdown(): Promise<void>;
}

const browserCapabilities: DesktopCapabilities = {
  desktop: false,
  nativeDirectoryPicker: false,
  fileDropPaths: false,
  revealInFinder: false,
  encryptedSecretStorage: false
};

export async function startLocalRuntime(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
  options.startupSignal?.throwIfAborted();
  const appDataDir = options.appDataDir ?? getAppDataDir();
  const runtimeFile = path.join(appDataDir, "runtime.json");
  const db = await openDatabase(appDataDir);
  let scanner: ScannerService | null = null;
  let jobs: JobService | null = null;
  let disposed = false;
  let databaseClosed = false;
  let jobsStarted = false;
  let runtimeTemporary: string | null = null;
  let disposePromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  const appHolder: { current: Awaited<ReturnType<typeof buildApp>> | null } = { current: null };
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      const errors: unknown[] = [];
      jobs?.stop();
      const serviceResults = await Promise.allSettled([
        jobsStarted && jobs ? jobs.shutdown() : Promise.resolve(),
        scanner?.stop() ?? Promise.resolve()
      ]);
      for (const result of serviceResults) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      try {
        await appHolder.current?.close();
      } catch (error) {
        errors.push(error);
      }
      if (!databaseClosed) {
        try {
          db.pragma("wal_checkpoint(TRUNCATE)");
          db.close();
          databaseClosed = true;
        } catch (error) {
          errors.push(error);
        }
      }
      if (options.writeRuntimeFile !== false) {
        const files = [runtimeFile, runtimeTemporary].filter((candidate): candidate is string => candidate !== null);
        const removalResults = await Promise.allSettled(files.map((candidate) => fs.rm(candidate, { force: true })));
        for (const result of removalResults) {
          if (result.status === "rejected") errors.push(result.reason);
        }
      }
      if (errors.length) throw new AggregateError(errors, "本地运行时未能完全关闭");
    })();
    return disposePromise;
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let disposeError: unknown = null;
      try {
        await dispose();
      } catch (error) {
        disposeError = error;
      }
      await options.onShutdown?.();
      if (disposeError) throw disposeError;
    })();
    return shutdownPromise;
  };

  try {
    options.startupSignal?.throwIfAborted();
    initializeSessionState(db);
    const secrets = options.secretStore ?? new FileSecretStore(appDataDir);
    const pathPolicy = new PathPolicy();
    const tinypng = new TinyPngAdapter();
    const usage = new TinyPngUsageService(db, secrets, tinypng);
    const settings = new SettingsService(appDataDir, db, secrets, pathPolicy, usage);
    await settings.ensureDefaults(options.platform?.downloadsPath ?? path.join(os.homedir(), "Downloads"));
    scanner = new ScannerService(db);
    const images = new ImageService(db, pathPolicy);
    const writer = new OutputWriter(pathPolicy);
    const outputs = new SessionOutputService(db, settings);
    settings.setSessionOutputDirectoryProvider(() => outputs.current());
    jobs = new JobService(db, images, secrets, tinypng, writer, outputs, usage);
    const importAutomation = new ImportAutomationService(settings, images, jobs);
    scanner.setOnImage((event) => importAutomation.handleDetected(event));
    const production = options.production ?? process.env.NODE_ENV === "production";
    const lifecycle = new ApplicationLifecycle({ getActiveJobs: () => jobs!.getActiveCounts(), shutdown });
    const platform = options.platform ?? { capabilities: browserCapabilities };
    const app = await buildApp(
      { db, settings, scanner, images, jobs, usage, importAutomation },
      { production, lifecycle, platform, thumbnailCacheDir: path.join(appDataDir, "cache", "thumbnails"), ...(options.webRoot ? { webRoot: options.webRoot } : {}) }
    );
    appHolder.current = app;
    options.startupSignal?.throwIfAborted();

    const requestedPort = options.port ?? Number.parseInt(process.env.PORT ?? "43127", 10);
    let address: string;
    try {
      address = await app.listen({ host: "127.0.0.1", port: requestedPort });
    } catch (error: any) {
      if (error?.code !== "EADDRINUSE") throw error;
      address = await app.listen({ host: "127.0.0.1", port: 0 });
    }
    options.startupSignal?.throwIfAborted();
    app.log.info({ address, appDataDir }, "本地图片压缩管理工具已启动");

    if (options.writeRuntimeFile !== false) {
      const runtimeUrl = new URL(address);
      runtimeTemporary = `${runtimeFile}.${process.pid}.tmp`;
      await fs.writeFile(runtimeTemporary, JSON.stringify({ pid: process.pid, port: Number(runtimeUrl.port), url: address, startedAt: new Date().toISOString() }), { mode: 0o600 });
      options.startupSignal?.throwIfAborted();
      await fs.rename(runtimeTemporary, runtimeFile);
      runtimeTemporary = null;
    }
    options.startupSignal?.throwIfAborted();
    jobs.start();
    jobsStarted = true;

    const backgroundReady = (async () => {
      try {
        const settingsState = await settings.load();
        if (!settingsState || disposed) return;
        await usage.refreshIfStale();
        if (disposed) return;
      } catch (error) {
        if (disposed) return;
        app.log.error({ err: error }, "工作区后台初始化失败，已降级为手动刷新");
        try {
          await options.onBackgroundError?.(error);
        } catch (reportingError) {
          app.log.error({ err: reportingError }, "记录工作区后台初始化错误失败");
        }
      }
    })();
    return { address, backgroundReady, dispose, shutdown };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      console.error("本地运行时启动失败后的清理未完整完成", cleanupError);
    }
    throw error;
  }
}
