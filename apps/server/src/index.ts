import { startLocalRuntime } from "./runtime.js";

const runtime = await startLocalRuntime();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void runtime.shutdown().then(
      () => process.exit(0),
      (error) => {
        console.error("本地图片压缩管理工具关闭失败", error);
        process.exit(1);
      }
    );
  });
}
