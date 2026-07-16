import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/index.ts"],
  external: ["argon2", "cookie-parser", "express", "pg", "pino", "zod"],
  format: "esm",
  outfile: "dist/index.mjs",
  platform: "node",
  target: "node20",
});
