import fs from "node:fs/promises";

export default async function globalSetup() {
  await fs.rm("/tmp/ica-e2e-app-data", { recursive: true, force: true });
}
