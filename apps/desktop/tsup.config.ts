import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  external: ["electron", "better-sqlite3", "sharp"],
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __icaCreateRequire } from "node:module"; const require = __icaCreateRequire(import.meta.url);'
  }
});
