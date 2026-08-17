import fs from "node:fs/promises";
import path from "node:path";

export default async function globalSetup() {
  const runDirectory = path.resolve(process.env.ICA_TEST_RUN_DIR ?? ".ica-test/runs/web");
  await fs.rm(path.join(runDirectory, "app-data"), { recursive: true, force: true });
  await fs.mkdir(runDirectory, { recursive: true });
}
