import { ensurePrepared, run, useNativeAbi } from "./common.mjs";

const { info } = await ensurePrepared();
await useNativeAbi(info, info.nodeAbi);
try {
  run("pnpm", ["--filter", "@ica/server", "test"]);
} finally {
  await useNativeAbi(info, info.nodeAbi);
}
