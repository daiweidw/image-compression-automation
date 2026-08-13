import { describe, expect, it, vi } from "vitest";
import { ApplicationLifecycle } from "./application-lifecycle.js";
import { AppError } from "../errors.js";

describe("ApplicationLifecycle", () => {
  it("requires explicit confirmation when jobs are active", () => {
    const lifecycle = new ApplicationLifecycle({
      getActiveJobs: () => ({ queued: 2, running: 1 }),
      shutdown: vi.fn()
    });

    expect(() => lifecycle.requestShutdown(false)).toThrowError(AppError);
    expect(lifecycle.getStatus()).toEqual({
      shuttingDown: false,
      activeJobs: { queued: 2, running: 1 }
    });
  });

  it("schedules shutdown once after confirmation", async () => {
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ApplicationLifecycle({
      getActiveJobs: () => ({ queued: 1, running: 1 }),
      shutdown,
      delayMs: 0
    });

    lifecycle.requestShutdown(true);
    lifecycle.requestShutdown(true);
    expect(lifecycle.getStatus().shuttingDown).toBe(true);
    expect(shutdown).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
  });
});
