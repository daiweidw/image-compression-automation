import { openDatabase, recoverInterruptedJobs } from "./infrastructure/database.js";
import { FileSecretStore } from "./infrastructure/secret-store.js";
import { PathPolicy } from "./infrastructure/path-policy.js";
import { TinyPngAdapter } from "./infrastructure/tinypng-adapter.js";
import { OutputWriter } from "./infrastructure/output-writer.js";
import { SettingsService } from "./application/settings-service.js";
import { ScannerService } from "./application/scanner-service.js";
import { ImageService } from "./application/image-service.js";
import { JobService } from "./application/job-service.js";
import { buildApp } from "./app.js";
import { getAppDataDir } from "./paths.js";
import { ApplicationLifecycle } from "./application/application-lifecycle.js";
import fs from "node:fs/promises";
import path from "node:path";

const appDataDir = getAppDataDir();
const runtimeFile = path.join(appDataDir, "runtime.json");
const db = await openDatabase(appDataDir);
recoverInterruptedJobs(db);
const secrets = new FileSecretStore(appDataDir);
const pathPolicy = new PathPolicy();
const tinypng = new TinyPngAdapter();
const settings = new SettingsService(appDataDir, db, secrets, pathPolicy, tinypng);
const scanner = new ScannerService(db);
const images = new ImageService(db, pathPolicy);
const writer = new OutputWriter(pathPolicy);
const jobs = new JobService(db, images, secrets, tinypng, writer);
const production = process.env.NODE_ENV === "production";
let shutdownPromise: Promise<void> | null = null;
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    jobs.stop();
    await Promise.all([jobs.shutdown(), scanner.stop()]);
    await app.close();
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    await fs.rm(runtimeFile, { force: true });
  })();
  return shutdownPromise;
};
const lifecycle = new ApplicationLifecycle({
  getActiveJobs: () => jobs.getActiveCounts(),
  shutdown
});
const app = await buildApp({ db, settings, scanner, images, jobs }, { production, lifecycle });

jobs.start();
const requestedPort = Number.parseInt(process.env.PORT ?? "43127", 10);
let address: string;
try {
  address = await app.listen({ host: "127.0.0.1", port: requestedPort });
} catch (error: any) {
  if (error?.code !== "EADDRINUSE") throw error;
  address = await app.listen({ host: "127.0.0.1", port: 0 });
}
app.log.info({ address, appDataDir }, "本地图片压缩管理工具已启动");
const runtimeUrl = new URL(address);
const runtimeTemporary = `${runtimeFile}.${process.pid}.tmp`;
await fs.writeFile(runtimeTemporary, JSON.stringify({
  pid: process.pid,
  port: Number(runtimeUrl.port),
  url: address,
  startedAt: new Date().toISOString()
}), { mode: 0o600 });
await fs.rename(runtimeTemporary, runtimeFile);

const settingsState = await settings.load();
if (settingsState) scanner.start("incremental");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        app.log.error(error, "本地图片压缩管理工具关闭失败");
        process.exit(1);
      }
    );
  });
}
