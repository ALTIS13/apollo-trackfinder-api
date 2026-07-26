import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const artifactRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(artifactRoot, "../..");

async function text(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch(() => "");
}

describe("TF download worker build and image boundary", () => {
  beforeAll(async () => {
    await execute(process.execPath, [path.join(artifactRoot, "build.mjs")], {
      cwd: repositoryRoot,
      windowsHide: true,
      timeout: 120_000,
    });
    await execute(
      process.execPath,
      [path.join(repositoryRoot, "artifacts/api-server/build.mjs")],
      {
        cwd: repositoryRoot,
        windowsHide: true,
        timeout: 120_000,
      },
    );
  }, 240_000);

  it("builds one production runtime entry without forbidden control or data dependencies", async () => {
    const bundle = await text(path.join(artifactRoot, "dist/index.mjs"));
    const packageJson = JSON.parse(
      await text(path.join(artifactRoot, "package.json")),
    ) as { dependencies?: Record<string, string> };

    expect(bundle.length).toBeGreaterThan(10_000);
    expect(bundle).toContain("apollo-tf-downloads-v1");
    expect(bundle).toContain("/v1/files");
    for (const forbidden of [
      "@workspace/db",
      "tf-integrations-db",
      "provider-account",
      "SESSION_REDIS",
      "CACHE_REDIS",
      "SPOTIFY_CLIENT_SECRET",
      "YANDEX_TOKEN",
      "dockerode",
      "ssh2",
      "coolify",
      "caddy",
    ]) {
      expect(bundle.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([
      "@workspace/module-runtime-contract",
      "@workspace/tf-download-contract",
      "bullmq",
      "ioredis",
    ]);
  });

  it("keeps worker engine and storage out of the API runtime while retaining the signed client", async () => {
    const apiBundle = await text(
      path.join(repositoryRoot, "artifacts/api-server/dist/index.mjs"),
    );
    const apiDockerfile = await text(
      path.join(repositoryRoot, "artifacts/api-server/Dockerfile"),
    );

    expect(apiBundle).toContain("/v1/files");
    expect(apiBundle).toContain("TF_DOWNLOAD_WORKER_ORIGIN");
    expect(apiBundle).not.toContain("class DownloadStorage");
    expect(apiBundle).not.toContain("spawnYtDlpDownload");
    expect(apiBundle).not.toContain("createDownloadProcessor");
    expect(apiDockerfile).toContain("lib/tf-download-contract");
    expect(apiDockerfile).not.toContain("artifacts/tf-download-worker");
  });

  it("defines a pinned least-privilege image with no retained package manager", async () => {
    const dockerfile = await text(path.join(artifactRoot, "Dockerfile"));

    expect(dockerfile).toContain("pnpm@10.33.2");
    expect(dockerfile).toContain("YT_DLP_VERSION=2026.7.4");
    expect(dockerfile).toContain(
      "YT_DLP_SHA256=f11f2b11d5a8ac4059f9bdf29fa4407dc7c6bb00c5097e95ca22a7a9db518266",
    );
    expect(dockerfile).toContain("--require-hashes");
    expect(dockerfile).toContain("ffmpeg");
    expect(dockerfile).toContain("10001:10001");
    expect(dockerfile).toContain("/var/lib/apollo-tf/downloads");
    expect(dockerfile).toMatch(/chown\s+-R\s+10001:10001/);
    expect(dockerfile).toMatch(/chmod\s+0700/);
    expect(dockerfile).toContain("chmod -R a-w /app");
    expect(dockerfile).toMatch(
      /rm -rf[\s\S]*\/usr\/local\/lib\/node_modules\/npm/,
    );
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/bin\/apt-get/);
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/local\/bin\/pip/);
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/bin\/pip/);
    expect(dockerfile).toMatch(/rm -f[\s\S]*\/usr\/local\/bin\/yarn/);
    expect(dockerfile).toContain("test ! -e /usr/bin/apt-get");
    expect(dockerfile).toContain("test ! -e /usr/bin/pip");
    expect(dockerfile).toContain("test ! -e /usr/local/bin/yarn");
    expect(dockerfile).toContain("USER 10001:10001");
  });

  it("starts only after checking file-backed inputs and owned storage without printing values", async () => {
    const script = await text(
      path.join(artifactRoot, "container/start-worker.sh"),
    );

    expect(script).toContain("TF_DOWNLOAD_QUEUE_REDIS_URL_FILE");
    expect(script).toContain("TF_DOWNLOAD_INTERNAL_AUTH_SECRET_FILE");
    expect(script).toContain("TF_DOWNLOAD_HEARTBEAT_SECRET_FILE");
    expect(script).toContain('stat -c "%u:%g"');
    expect(script).toContain("10001:10001");
    expect(script).toContain("exec \"$@\"");
    expect(script).not.toContain("set -x");
    expect(script).not.toMatch(/cat\s+.*SECRET/);
    expect(script).not.toMatch(/echo\s+.*TF_DOWNLOAD_/);
  });
});
