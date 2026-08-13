import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { ApplicationLifecycle } from "./application/application-lifecycle.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fakeServices() {
  return {
    db: {} as any,
    settings: {} as any,
    scanner: {} as any,
    images: {} as any,
    jobs: {
      setOnChange: vi.fn(),
      getActiveCounts: () => ({ queued: 0, running: 0 })
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
