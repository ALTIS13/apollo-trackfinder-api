import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(artifactDir, "dist");

await rm(distDir, { recursive: true, force: true });
await build({
  entryPoints: [
    "src/app.ts",
    "src/cancellation.ts",
    "src/downloader.ts",
    "src/internal-auth.ts",
    "src/logger.ts",
    "src/processor.ts",
    "src/storage.ts",
  ].map((entry) => path.join(artifactDir, entry)),
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: distDir,
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  logLevel: "info",
});
