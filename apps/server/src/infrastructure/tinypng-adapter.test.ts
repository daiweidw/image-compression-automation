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
    await expect(adapter.validateKey("good")).resolves.toEqual({ valid: true, compressionCount: 7 });
    await expect(adapter.validateKey("bad")).resolves.toEqual({ valid: false, compressionCount: 7 });
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
});
