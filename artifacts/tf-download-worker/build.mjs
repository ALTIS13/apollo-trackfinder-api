import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(artifactDir, "dist");

await rm(distDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(artifactDir, "src/index.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outfile: path.join(distDir, "index.mjs"),
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  logLevel: "info",
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
globalThis.require = __createRequire(import.meta.url);`,
  },
});
