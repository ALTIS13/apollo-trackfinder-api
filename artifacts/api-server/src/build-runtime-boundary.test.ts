import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const artifactDir = path.resolve(import.meta.dirname, "..");
const distDir = path.resolve(artifactDir, "dist");
const forbiddenRuntimeIdentifiers = [
  ["spotify", "tokens"].join("_"),
  ["yandex", "tokens"].join("_"),
  ["oauth", "token"].join("_"),
  ["refresh", "token"].join("_"),
  ["spotify", "TokensTable"].join(""),
  ["yandex", "TokensTable"].join(""),
  ["SPOTIFY", "CLIENT", "SECRET"].join("_"),
];

describe("API production bundle boundary", () => {
  it(
    "does not package provider token storage or client credentials",
    async () => {
      await execFileAsync(process.execPath, ["build.mjs"], {
        cwd: artifactDir,
        windowsHide: true,
      });

      const files = await readdir(distDir);
      for (const file of files) {
        const contents = await readFile(path.resolve(distDir, file), "utf8");
        for (const identifier of forbiddenRuntimeIdentifiers) {
          expect(contents).not.toContain(identifier);
        }
      }
    },
    15_000,
  );
});
