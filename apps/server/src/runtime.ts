import fs from "node:fs/promises";
import path from "node:path";
import type { DesktopCapabilities } from "@ica/contracts";
import type { SecretStore } from "./infrastructure/secret-store.js";
import { FileSecretStore } from "./infrastructure/secret-store.js";
import { openDatabase, recoverInterruptedJobs } from "./infrastructure/database.js";
import { PathPolicy } from "./infrastructure/path-policy.js";
import { TinyPngAdapter } from "./infrastructure/tinypng-adapter.js";
import { OutputWriter } from "./infrastructure/output-writer.js";
import { SettingsService } from "./application/settings-service.js";
import { ScannerService } from "./application/scanner-service.js";
import { ImageService } from "./application/image-service.js";
import { JobService } from "./application/job-service.js";
import { WatchService } from "./application/watch-service.js";
import { ApplicationLifecycle } from "./application/application-lifecycle.js";
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
}

export interface LocalRuntime {
  address: string;
  shutdown(): Promise<void>;
}

const browserCapabilities: DesktopCapabilities = {
  desktop: false,
  nativeDirectoryPicker: false,
  revealInFinder: false,
  encryptedSecretStorage: false
};

export async function startLocalRuntime(options: LocalRuntimeOptions = {}): Promise<LocalRuntime> {
  const appDataDir = options.appDataDir ?? getAppDataDir();
  const runtimeFile = path.join(appDataDir, "runtime.json");
  const db = await openDatabase(appDataDir);
  recoverInterruptedJobs(db);
  const secrets = options.secretStore ?? new FileSecretStore(appDataDir);
  const pathPolicy = new PathPolicy();
  const tinypng = new TinyPngAdapter();
  const settings = new SettingsService(appDataDir, db, secrets, pathPolicy, tinypng);
  const scanner = new ScannerService(db);
  const images = new ImageService(db, pathPolicy);
  const writer = new OutputWriter(pathPolicy);
  const jobs = new JobService(db, images, secrets, tinypng, writer);
  let publishWatchChange: () => void = () => undefined;
  const watch = new WatchService(db, scanner, images, jobs, () => publishWatchChange());
  const production = options.production ?? process.env.NODE_ENV === "production";
  let shutdownPromise: Promise<void> | null = null;
  const appHolder: { current: Awaited<ReturnType<typeof buildApp>> | null } = { current: null };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      jobs.stop();
      await Promise.all([watch.stop(), jobs.shutdown(), scanner.stop()]);
      await appHolder.current?.close();
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      if (options.writeRuntimeFile !== false) await fs.rm(runtimeFile, { force: true });
      await options.onShutdown?.();
    })();
    return shutdownPromise;
  };
  const lifecycle = new ApplicationLifecycle({ getActiveJobs: () => jobs.getActiveCounts(), shutdown });
  const platform = options.platform ?? { capabilities: browserCapabilities };
  const app = await buildApp(
    { db, settings, scanner, images, jobs, watch },
    { production, lifecycle, platform, thumbnailCacheDir: path.join(appDataDir, "cache", "thumbnails"), ...(options.webRoot ? { webRoot: options.webRoot } : {}) }
  );
  appHolder.current = app;
  publishWatchChange = () => app.publish("watch.changed");

  jobs.start();
  const requestedPort = options.port ?? Number.parseInt(process.env.PORT ?? "43127", 10);
  let address: string;
  try {
    address = await app.listen({ host: "127.0.0.1", port: requestedPort });
  } catch (error: any) {
    if (error?.code !== "EADDRINUSE") throw error;
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  }
  app.log.info({ address, appDataDir }, "本地图片压缩管理工具已启动");

  if (options.writeRuntimeFile !== false) {
    const runtimeUrl = new URL(address);
    const runtimeTemporary = `${runtimeFile}.${process.pid}.tmp`;
    await fs.writeFile(runtimeTemporary, JSON.stringify({ pid: process.pid, port: Number(runtimeUrl.port), url: address, startedAt: new Date().toISOString() }), { mode: 0o600 });
    await fs.rename(runtimeTemporary, runtimeFile);
  }

  const settingsState = await settings.load();
  if (settingsState) {
    scanner.start("incremental");
    await watch.sync();
  }
  return { address, shutdown };
}
