import path from "node:path";
import { ensurePrepared, projectRoot, run, useNativeAbi } from "./common.mjs";

const { info } = await ensurePrepared();
await useNativeAbi(info, info.nodeAbi);
try {
  run("pnpm", ["build"]);
  await useNativeAbi(info, info.electronAbi);
  run(process.execPath, [path.join(projectRoot, "scripts", "package-mac-arm64-offline.mjs")], {
    env: { ELECTRON_DOWNLOAD_CACHE_MODE: "1" }
  });
} finally {
  await useNativeAbi(info, info.nodeAbi);
}
