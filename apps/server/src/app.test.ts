import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { ApplicationLifecycle } from "./application/application-lifecycle.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fakeServices() {
  const usage = { configured: true, used: 12, limit: 500, remaining: 488, status: "available", updatedAt: "2026-08-14T00:00:00.000Z", stale: false, source: "cache" };
  return {
    db: {} as any,
    settings: {
      setAutoCompressOnImport: vi.fn(async (enabled: boolean) => ({ autoCompressOnImport: enabled }))
    } as any,
    scanner: {} as any,
    images: {} as any,
    jobs: {
      setOnChange: vi.fn(),
      getActiveCounts: () => ({ queued: 0, running: 0 })
    } as any,
    usage: {
      setOnChange: vi.fn(),
      getUsage: vi.fn(async () => usage),
      isExhausted: vi.fn(() => false),
      refresh: vi.fn(async () => ({ validation: { valid: true, compressionCount: 12, quotaExceeded: false }, usage }))
    } as any
  };
}

describe("application shutdown API", () => {
  it("rejects a request without the local session token", async () => {
    const lifecycle = new ApplicationLifecycle({
      getActiveJobs: () => ({ queued: 0, running: 0 }),
      shutdown: vi.fn(),
      delayMs: 10_000
    });
    const app = await buildApp(fakeServices(), { lifecycle });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/application/shutdown",
      payload: { confirmActiveJobs: false }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("INVALID_LOCAL_TOKEN");
    expect(lifecycle.getStatus().shuttingDown).toBe(false);
  });

  it("accepts a token-protected shutdown request", async () => {
    const shutdown = vi.fn(async () => undefined);
    const lifecycle = new ApplicationLifecycle({
      getActiveJobs: () => ({ queued: 0, running: 0 }),
      shutdown,
      delayMs: 0
    });
    const app = await buildApp(fakeServices(), { lifecycle });
    apps.push(app);
    const session = await app.inject({ method: "GET", url: "/api/session" });
    const token = session.json().data.token as string;

    const response = await app.inject({
      method: "POST",
      url: "/api/application/shutdown",
      headers: { "x-local-app-token": token, origin: "http://127.0.0.1:43127" },
      payload: { confirmActiveJobs: false }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ accepted: true });
    expect(lifecycle.getStatus().shuttingDown).toBe(true);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
  });
});

describe("TinyPNG usage API", () => {
  it("returns cached usage and protects active refreshes with the local token", async () => {
    const services = fakeServices();
    const app = await buildApp(services);
    apps.push(app);
    const cached = await app.inject({ method: "GET", url: "/api/tinypng/usage" });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().data).toMatchObject({ used: 12, remaining: 488, status: "available" });

    const rejected = await app.inject({ method: "POST", url: "/api/tinypng/usage/refresh", payload: {} });
    expect(rejected.statusCode).toBe(403);
    const session = await app.inject({ method: "GET", url: "/api/session" });
    const accepted = await app.inject({
      method: "POST",
      url: "/api/tinypng/usage/refresh",
      headers: { "x-local-app-token": session.json().data.token, origin: "http://127.0.0.1:43127" },
      payload: {}
    });
    expect(accepted.statusCode).toBe(200);
    expect(services.usage.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("automatic compression settings API", () => {
  it("updates only the import automation switch through a protected endpoint", async () => {
    const services = fakeServices();
    const app = await buildApp(services);
    apps.push(app);
    const session = await app.inject({ method: "GET", url: "/api/session" });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/settings/auto-compress",
      headers: { "x-local-app-token": session.json().data.token, origin: "http://127.0.0.1:43127" },
      payload: { enabled: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ autoCompressOnImport: true });
    expect(services.settings.setAutoCompressOnImport).toHaveBeenCalledWith(true);
  });
});
