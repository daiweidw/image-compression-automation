import { describe, expect, it, vi } from "vitest";
import { runStartupWithTimeout, StartupTimeoutError } from "../../desktop/src/startup-coordinator.js";

interface TestRuntime {
  dispose(): Promise<void>;
}

describe("runStartupWithTimeout", () => {
  it("does not count user-mediated preparation toward the startup deadline", async () => {
    vi.useFakeTimers();
    const runtime = { dispose: vi.fn(async () => undefined) };
    let finishPreparation: (() => void) | null = null;
    const start = vi.fn(async () => runtime);
    let settled = false;
    const result = runStartupWithTimeout({
      controller: new AbortController(),
      timeoutMs: 5_000,
      prepare: () => new Promise<void>((resolve) => { finishPreparation = resolve; }),
      start,
      load: async () => undefined
    }).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    expect(start).not.toHaveBeenCalled();

    finishPreparation!();
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(runtime);
    vi.useRealTimers();
  });

  it("returns a runtime when startup and page loading finish before the deadline", async () => {
    const runtime = { dispose: vi.fn(async () => undefined) };

    await expect(runStartupWithTimeout({
      controller: new AbortController(),
      timeoutMs: 100,
      start: async () => runtime,
      load: async () => undefined
    })).resolves.toBe(runtime);
    expect(runtime.dispose).not.toHaveBeenCalled();
  });

  it("times out and disposes a runtime that succeeds late", async () => {
    vi.useFakeTimers();
    const runtime: TestRuntime = { dispose: vi.fn(async () => undefined) };
    let finishStart: ((value: TestRuntime) => void) | null = null;
    const result = runStartupWithTimeout({
      controller: new AbortController(),
      timeoutMs: 5_000,
      start: () => new Promise<TestRuntime>((resolve) => { finishStart = resolve; }),
      load: async () => undefined
    });
    const handledResult = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await handledResult).toBeInstanceOf(StartupTimeoutError);
    finishStart!(runtime);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("times out and disposes an acquired runtime when page loading never finishes", async () => {
    vi.useFakeTimers();
    const runtime = { dispose: vi.fn(async () => undefined) };
    const result = runStartupWithTimeout({
      controller: new AbortController(),
      timeoutMs: 5_000,
      start: async () => runtime,
      load: () => new Promise<void>(() => undefined)
    });
    const handledResult = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await handledResult).toBeInstanceOf(StartupTimeoutError);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("disposes an acquired runtime when page loading fails", async () => {
    const runtime = { dispose: vi.fn(async () => undefined) };
    const failure = new Error("page failed");

    await expect(runStartupWithTimeout({
      controller: new AbortController(),
      timeoutMs: 100,
      start: async () => runtime,
      load: async () => { throw failure; }
    })).rejects.toBe(failure);
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledTimes(1));
  });
});
