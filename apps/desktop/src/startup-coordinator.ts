export class StartupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`图片压缩工作台未能在 ${timeoutMs} 毫秒内完成启动`);
    this.name = "StartupTimeoutError";
  }
}

interface DisposableStartupResource {
  dispose(): Promise<void>;
}

interface StartupOptions<T extends DisposableStartupResource> {
  controller: AbortController;
  timeoutMs: number;
  prepare?: (signal: AbortSignal) => Promise<void>;
  start: (signal: AbortSignal) => Promise<T>;
  load: (resource: T, signal: AbortSignal) => Promise<void>;
  onCleanupError?: (error: unknown) => void;
}

export async function runStartupWithTimeout<T extends DisposableStartupResource>(options: StartupOptions<T>): Promise<T> {
  const { controller, timeoutMs } = options;
  await options.prepare?.(controller.signal);
  controller.signal.throwIfAborted();
  let resource: T | null = null;
  let cleanupStarted = false;
  const cleanup = () => {
    if (!resource || cleanupStarted) return;
    cleanupStarted = true;
    void resource.dispose().catch((error) => options.onCleanupError?.(error));
  };
  const startup = (async () => {
    resource = await options.start(controller.signal);
    controller.signal.throwIfAborted();
    await options.load(resource, controller.signal);
    controller.signal.throwIfAborted();
    return resource;
  })();
  let rejectOnAbort: ((error: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(controller.signal.reason ?? new Error("应用启动已取消"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new StartupTimeoutError(timeoutMs)), timeoutMs);

  try {
    return await Promise.race([startup, aborted]);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    cleanup();
    void startup.then(cleanup, cleanup);
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
