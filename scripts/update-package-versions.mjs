import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPaths = [
  path.join(root, "package.json"),
  path.join(root, "apps", "desktop", "package.json")
];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isValidPackageVersion(version) {
  return versionPattern.test(version);
}

export function replaceManifestVersion(source, nextVersion, manifestPath = "package.json") {
  const manifest = JSON.parse(source);
  if (typeof manifest.version !== "string") {
    throw new Error(`${manifestPath} 中没有有效的 version 字段`);
  }

  const currentEntry = `"version": ${JSON.stringify(manifest.version)}`;
  const nextEntry = `"version": ${JSON.stringify(nextVersion)}`;
  const firstMatch = source.indexOf(currentEntry);
  if (firstMatch < 0 || source.indexOf(currentEntry, firstMatch + currentEntry.length) >= 0) {
    throw new Error(`无法安全更新 ${manifestPath} 中的 version 字段`);
  }

  return `${source.slice(0, firstMatch)}${nextEntry}${source.slice(firstMatch + currentEntry.length)}`;
}

async function readCurrentVersion() {
  const source = await fs.readFile(manifestPaths[0], "utf8");
  const manifest = JSON.parse(source);
  if (typeof manifest.version !== "string") throw new Error("package.json 中没有有效的 version 字段");
  return manifest.version;
}

async function updateVersions(nextVersion) {
  const updates = await Promise.all(manifestPaths.map(async (manifestPath) => {
    const source = await fs.readFile(manifestPath, "utf8");
    return {
      manifestPath,
      source,
      updatedSource: replaceManifestVersion(source, nextVersion, manifestPath)
    };
  }));

  const changedUpdates = updates.filter(({ source, updatedSource }) => source !== updatedSource);
  await Promise.all(changedUpdates.map(({ manifestPath, updatedSource }) => fs.writeFile(manifestPath, updatedSource)));
}

async function main() {
  const [commandOrVersion, versionArgument] = process.argv.slice(2);

  if (commandOrVersion === "--current") {
    process.stdout.write(await readCurrentVersion());
    return;
  }

  if (commandOrVersion === "--validate") {
    process.exitCode = isValidPackageVersion(versionArgument ?? "") ? 0 : 1;
    return;
  }

  if (!isValidPackageVersion(commandOrVersion ?? "")) {
    throw new Error("版本号必须为 x.y.z 格式，例如 0.2.5");
  }

  await updateVersions(commandOrVersion);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`同步版本号失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
