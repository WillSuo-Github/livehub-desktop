import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperDirectory = path.join(repositoryRoot, "native", "douyin-helper");
const binaryName = process.platform === "win32" ? "douyin-helper.exe" : "douyin-helper";
const outputPath = path.join(helperDirectory, "bin", binaryName);

mkdirSync(path.dirname(outputPath), { recursive: true });

const result = spawnSync("go", ["build", "-trimpath", "-o", outputPath, "."], {
  cwd: helperDirectory,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Unable to build Douyin helper: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Built Douyin helper at ${outputPath}`);
