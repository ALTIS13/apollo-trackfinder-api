import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const artifactRoot = fileURLToPath(new URL("..", import.meta.url));

it("loads the production ESM bundle before reporting invalid runtime configuration", async () => {
  await execFileAsync(process.execPath, [join(artifactRoot, "build.mjs")], {
    cwd: artifactRoot,
    maxBuffer: 4 * 1024 * 1024,
  });

  const execution = execFileAsync(
    process.execPath,
    [join(artifactRoot, "dist", "index.mjs")],
    {
      cwd: artifactRoot,
      env: { PATH: process.env.PATH, PORT: "invalid" },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );
  await expect(execution).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: "TF search startup failed\n",
  });
});
