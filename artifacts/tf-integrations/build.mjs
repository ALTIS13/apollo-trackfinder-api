import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const artifactDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(artifactDirectory, "../..");
const outputDirectory = path.join(artifactDirectory, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await build({
  bundle: true,
  entryNames: "[name]",
  entryPoints: {
    index: path.join(artifactDirectory, "src/index.ts"),
    migrate: path.join(artifactDirectory, "src/migrate.ts"),
  },
  external: ["express", "pg", "zod"],
  format: "esm",
  outExtension: { ".js": ".mjs" },
  outdir: outputDirectory,
  platform: "node",
  target: "node24",
  logLevel: "info",
});
await cp(
  path.join(workspaceDirectory, "lib/tf-integrations-db/migrations"),
  path.join(outputDirectory, "migrations"),
  { recursive: true },
);
