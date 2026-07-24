import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, "dist");

await rm(distDir, { recursive: true, force: true });
await build({
  entryPoints: [path.resolve(artifactDir, "src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: distDir,
  outExtension: { ".js": ".mjs" },
  banner: {
    js: `import { createRequire as __bannerCreateRequire } from "node:module";
globalThis.require = __bannerCreateRequire(import.meta.url);`,
  },
  sourcemap: "linked",
  logLevel: "info",
});
