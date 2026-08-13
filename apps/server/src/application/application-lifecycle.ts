import type { ApplicationStatus } from "@ica/contracts";
import { AppError } from "../errors.js";

export interface ApplicationLifecycleOptions {
  getActiveJobs: () => { queued: number; running: number };
  shutdown: () => Promise<void>;
  delayMs?: number;
}

export class ApplicationLifecycle {
  private shuttingDown = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: ApplicationLifecycleOptions) {}

  getStatus(): ApplicationStatus {
    return {
      shuttingDown: this.shuttingDown,
      activeJobs: this.options.getActiveJobs()
    };
  }

  requestShutdown(confirmActiveJobs: boolean): void {
    if (this.shuttingDown) return;
    const activeJobs = this.options.getActiveJobs();
    if (!confirmActiveJobs && activeJobs.queued + activeJobs.running > 0) {
      throw new AppError(
        "ACTIVE_JOBS_CONFIRMATION_REQUIRED",
        "仍有图片正在处理，请确认中断任务后再退出",
        409,
        activeJobs
      );
    }

    this.shuttingDown = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.options.shutdown();
    }, this.options.delayMs ?? 250);
  }
}
