import fs from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/main.ts"],
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    external: ["electron", "better-sqlite3", "sharp"],
    noExternal: ["@ica/contracts"],
    sourcemap: true,
    banner: {
      js: 'import { createRequire as __icaCreateRequire } from "node:module"; const require = __icaCreateRequire(import.meta.url);'
    },
    onSuccess: async () => {
      const bundle = await fs.readFile(new URL("./dist/main.js", import.meta.url), "utf8");
      if (bundle.includes('from "@ica/contracts"') || bundle.includes("from '@ica/contracts'")) {
        throw new Error("桌面构建产物仍包含 @ica/contracts 运行时导入");
      }
    }
  },
  {
    entry: { preload: "src/preload.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    outExtension: () => ({ js: ".cjs" }),
    external: ["electron"],
    sourcemap: true
  }
]);
