import path from "node:path";
import type Database from "better-sqlite3";
import { watch, type FSWatcher } from "chokidar";
import { ulid } from "ulid";
import type { WatchState } from "@ica/contracts";
import { ScannerService } from "./scanner-service.js";
import { ImageService } from "./image-service.js";
import { JobService } from "./job-service.js";

const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

export class WatchService {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private processing = false;
  private stopped = false;
  private pending = new Set<string>();
  private pendingAutoCompress = new Set<string>();
  private state: WatchState = { enabled: false, watching: false, autoCompress: false, pendingChanges: 0, lastEventAt: null, lastError: null };

  constructor(
    private readonly db: Database.Database,
    private readonly scanner: ScannerService,
    private readonly images: ImageService,
    private readonly jobs: JobService,
    private readonly onChange: () => void
  ) {}

  getState(): WatchState {
    return { ...this.state, pendingChanges: this.pending.size };
  }

  async sync(): Promise<void> {
    await this.closeWatcher();
    if (this.stopped) return;
    const workspace = this.db.prepare(
      "SELECT source_real_path, recursive, watch_enabled, auto_compress FROM workspaces WHERE active=1 LIMIT 1"
    ).get() as { source_real_path: string; recursive: number; watch_enabled: number; auto_compress: number } | undefined;
    this.state = { ...this.state, enabled: Boolean(workspace?.watch_enabled), autoCompress: Boolean(workspace?.auto_compress), watching: false, lastError: null };
    if (!workspace?.watch_enabled) return;
    this.watcher = watch(workspace.source_real_path, {
      ignoreInitial: true,
      ...(workspace.recursive ? {} : { depth: 0 }),
      ...(process.env.NODE_ENV === "test" ? { usePolling: true, interval: 100 } : {}),
      ignored: (candidate, stats) => path.basename(candidate).startsWith(".") || Boolean(stats?.isSymbolicLink()),
      awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 100 }
    });
    this.watcher.on("all", (event, candidate) => {
      if (!["add", "change", "unlink", "addDir", "unlinkDir"].includes(event)) return;
      if (!supportedExtensions.has(path.extname(candidate).toLowerCase()) && !event.endsWith("Dir")) return;
      this.pending.add(candidate);
      if (event === "add") this.pendingAutoCompress.add(candidate);
      this.state.lastEventAt = new Date().toISOString();
      this.schedule();
      this.onChange();
    });
    this.watcher.on("error", (error) => {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.onChange();
    });
    await new Promise<void>((resolve) => this.watcher!.once("ready", resolve));
    this.state.watching = true;
    this.onChange();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.closeWatcher();
    while (this.processing) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.process();
    }, 800);
  }

  private async process(): Promise<void> {
    if (this.processing || this.stopped || this.pending.size === 0) return;
    this.processing = true;
    const autoCompressCandidates = [...this.pendingAutoCompress];
    this.pending.clear();
    this.pendingAutoCompress.clear();
    try {
      this.scanner.start("incremental");
      await this.scanner.waitForIdle();
      if (this.state.autoCompress) {
        const ids = await this.images.idsForSourcePaths(autoCompressCandidates);
        if (ids.length) await this.jobs.create(ulid(), ids, false);
      }
      this.state.lastError = null;
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.processing = false;
      this.onChange();
      if (this.pending.size) this.schedule();
    }
  }

  private async closeWatcher(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    this.state.watching = false;
  }
}
