import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { OutputWriter } from "./output-writer.js";
import { PathPolicy } from "./path-policy.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("OutputWriter conflict strategy", () => {
  it("adds a suffix without overwriting an existing file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ica-output-test-"));
    directories.push(root);
    const original = Buffer.from("existing");
    await fs.writeFile(path.join(root, "image.png"), original);
    const output = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#225544" } }).png().toBuffer();
    const writer = new OutputWriter(new PathPolicy());
    const result = await writer.write(root, "image.png", { stream: Readable.from(output), mimeType: "image/png", contentLength: output.length, compressionCount: null }, false, "suffix");
    expect(result.relativePath).toBe("image-compressed-1.png");
    await expect(fs.readFile(path.join(root, "image.png"))).resolves.toEqual(original);
    await expect(fs.readFile(path.join(root, result.relativePath))).resolves.toEqual(output);
  });
});
