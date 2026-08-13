import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "./path-policy.js";

const temporaryDirectories: string[] = [];

async function temp(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ica-path-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("PathPolicy", () => {
  it("rejects overlapping roots", async () => {
    const root = await temp();
    const source = path.join(root, "source");
    const output = path.join(source, "output");
    await fs.mkdir(source);
    await expect(new PathPolicy().validateRoots(source, output, true)).rejects.toMatchObject({ code: "OVERLAPPING_DIRECTORIES" });
  });

  it("rejects relative path traversal", async () => {
    const root = await temp();
    const policy = new PathPolicy();
    expect(() => policy.resolveWithin(root, "../secret.txt")).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_ROOT" }));
  });

  it("rejects symlinks inside an allowed root", async () => {
    const root = await temp();
    const outside = await temp();
    await fs.symlink(outside, path.join(root, "linked"));
    await expect(new PathPolicy().assertNoSymlink(root, path.join(root, "linked", "image.png"))).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });
});
