import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });
await build({
  bundle: true,
  entryNames: "[name]",
  entryPoints: {
    index: "src/index.ts",
    migrate: "src/migrate.ts",
    "policy-smoke": "src/policy-smoke.ts",
  },
  external: [
    "argon2",
    "cookie-parser",
    "express",
    "ioredis",
    "pg",
    "pino",
    "zod",
  ],
  format: "esm",
  outExtension: { ".js": ".mjs" },
  outdir: "dist",
  platform: "node",
  target: "node20",
});
