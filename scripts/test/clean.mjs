import fs from "node:fs/promises";
import path from "node:path";
import { artifactsRoot, pidRoot, runsRoot, testRoot } from "./common.mjs";

async function stopRecordedProcesses() {
  const files = await fs.readdir(pidRoot).catch(() => []);
  for (const file of files) {
    const recordPath = path.join(pidRoot, file);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await fs.rm(recordPath, { force: true });
  }
}

await stopRecordedProcesses();
if (process.argv.includes("--all")) {
  await fs.rm(testRoot, { recursive: true, force: true });
  console.log(`已删除整个测试区：${testRoot}`);
} else {
  await Promise.all([
    fs.rm(runsRoot, { recursive: true, force: true }),
    fs.rm(artifactsRoot, { recursive: true, force: true })
  ]);
  console.log("已清理测试运行数据；Electron 与 ABI 缓存已保留。 ");
}
