import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrepared, projectRoot, run, runsRoot, useNativeAbi } from "./common.mjs";

const { info, assets } = await ensurePrepared();
await useNativeAbi(info, info.nodeAbi);
run("pnpm", ["build"]);
const runDirectory = path.join(runsRoot, "desktop");
await fs.rm(runDirectory, { recursive: true, force: true });
await fs.mkdir(runDirectory, { recursive: true });
await useNativeAbi(info, info.electronAbi);
try {
  run(assets.executablePath, [path.join(projectRoot, "apps", "desktop", "dist", "main.js")], {
    env: { ICA_DESKTOP_DATA_DIR: path.join(runDirectory, "app-data") }
  });
} finally {
  await useNativeAbi(info, info.nodeAbi);
}
