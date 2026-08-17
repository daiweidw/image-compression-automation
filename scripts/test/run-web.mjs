import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrepared, run, runsRoot, useNativeAbi } from "./common.mjs";

const { info } = await ensurePrepared();
await useNativeAbi(info, info.nodeAbi);
const runDirectory = path.join(runsRoot, "web");
await fs.rm(runDirectory, { recursive: true, force: true });
await fs.mkdir(runDirectory, { recursive: true });
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
try {
  await fs.access(chromePath);
  run("pnpm", ["exec", "playwright", "test"], {
    env: { ICA_TEST_RUN_DIR: runDirectory, PLAYWRIGHT_CHROME_EXECUTABLE: chromePath }
  });
} finally {
  await useNativeAbi(info, info.nodeAbi);
}
