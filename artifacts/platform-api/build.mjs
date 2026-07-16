import { build } from "esbuild";
import { rm } from "node:fs/promises";

await rm("dist", { force: true, recursive: true });
await build({
  bundle: true,
  entryPoints: ["src/index.ts"],
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
  outfile: "dist/index.mjs",
  platform: "node",
  target: "node20",
});
