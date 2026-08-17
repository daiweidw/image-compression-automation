import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/runtime.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  external: ["better-sqlite3", "sharp"],
  noExternal: ["@ica/contracts"],
  sourcemap: true
});
