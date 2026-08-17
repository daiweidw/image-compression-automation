import http from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { TinyPngAdapter } from "./tinypng-adapter.js";

const servers: http.Server[] = [];

async function fakeServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("TinyPngAdapter", () => {
  it("validates credentials without accepting invalid keys", async () => {
    const base = await fakeServer((request, response) => {
      response.statusCode = request.headers.authorization === `Basic ${Buffer.from("api:good").toString("base64")}` ? 400 : 401;
      response.setHeader("Compression-Count", "7");
      response.end(JSON.stringify({ message: "empty input" }));
    });
    const adapter = new TinyPngAdapter(base);
    await expect(adapter.validateKey("good")).resolves.toEqual({ valid: true, compressionCount: 7, quotaExceeded: false });
    await expect(adapter.validateKey("bad")).resolves.toEqual({ valid: false, compressionCount: 7, quotaExceeded: false });
  });

  it("distinguishes monthly quota exhaustion from transient rate limiting", async () => {
    const quotaBase = await fakeServer((_request, response) => {
      response.statusCode = 429;
      response.setHeader("Compression-Count", "500");
      response.end(JSON.stringify({ error: "TooManyRequests", message: "Your monthly limit has been exceeded" }));
    });
    const quotaAdapter = new TinyPngAdapter(quotaBase);
    await expect(quotaAdapter.compress(new URL(import.meta.url).pathname, "good")).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    await expect(quotaAdapter.validateKey("good")).resolves.toEqual({ valid: true, compressionCount: 500, quotaExceeded: true });

    const rateBase = await fakeServer((_request, response) => {
      response.statusCode = 429;
      response.setHeader("Retry-After", "2");
      response.end(JSON.stringify({ error: "TooManyRequests", message: "Too many requests" }));
    });
    const rateAdapter = new TinyPngAdapter(rateBase);
    await expect(rateAdapter.compress(new URL(import.meta.url).pathname, "good")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: 2 }
    });
  });

  it("uploads and returns the output stream", async () => {
    let base = "";
    base = await fakeServer((request, response) => {
      if (request.url === "/shrink") {
        request.resume();
        request.on("end", () => {
          response.statusCode = 201;
          response.setHeader("Location", `${base}/output/1`);
          response.setHeader("Compression-Count", "8");
          response.end("{}");
        });
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "image/png");
      response.setHeader("Content-Length", "4");
      response.end(Buffer.from([1, 2, 3, 4]));
    });
    const adapter = new TinyPngAdapter(base);
    const originalFetch = globalThis.fetch;
    const result = await adapter.compress(new URL(import.meta.url).pathname, "good");
    expect(result.mimeType).toBe("image/png");
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream as Readable) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("does not automatically retry a failed result download", async () => {
    let base = "";
    let downloadRequests = 0;
    base = await fakeServer((request, response) => {
      if (request.url === "/shrink") {
        request.resume();
        request.on("end", () => {
          response.statusCode = 201;
          response.setHeader("Location", `${base}/output/failed`);
          response.end("{}");
        });
        return;
      }
      downloadRequests += 1;
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "temporary failure" }));
    });

    const adapter = new TinyPngAdapter(base);
    await expect(adapter.compress(new URL(import.meta.url).pathname, "good")).rejects.toMatchObject({ code: "SERVER_TEMPORARY" });
    expect(downloadRequests).toBe(1);
  });
});
