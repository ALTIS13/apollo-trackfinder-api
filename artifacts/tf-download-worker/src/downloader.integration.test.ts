import { spawn } from "node:child_process";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";

const RUN_REAL_DOCKER = process.env.TF_DOWNLOAD_REAL_DOCKER === "1";
const repositoryRoot = new URL("../../..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const image = `apollo-tf-download-media-${process.pid}`;

describe.skipIf(!RUN_REAL_DOCKER)("production media conversion", () => {
  afterAll(async () => {
    await runDocker(["image", "rm", "--force", image], 60_000, true);
  });

  it(
    "converts an offline AAC source to the declared MP3 and FLAC codecs",
    async () => {
      await runDocker(
        [
          "build",
          "--file",
          `${repositoryRoot}/artifacts/tf-download-worker/Dockerfile`,
          "--target",
          "final",
          "--tag",
          image,
          repositoryRoot,
        ],
        10 * 60_000,
      );

      const nodeProbe = [
        "const { createWriteStream } = await import('node:fs');",
        "const { pipeline } = await import('node:stream/promises');",
        "const { spawnYtDlpDownload } = await import('/app/dist/index.mjs');",
        "for (const quality of ['320', 'flac']) {",
        "  const child = spawnYtDlpDownload({",
        "    executable: '/usr/local/bin/yt-dlp',",
        "    quality,",
        "    sourceUrl: 'http://127.0.0.1:8765/source.m4a',",
        "    signal: new AbortController().signal,",
        "  });",
        "  const output = `/tmp/output.${quality === 'flac' ? 'flac' : 'mp3'}`;",
        "  const [exit] = await Promise.all([",
        "    child.completion,",
        "    pipeline(child.stdout, createWriteStream(output)),",
        "  ]);",
        "  if (exit.code !== 0) throw new Error(`conversion failed: ${quality}`);",
        "}",
      ].join("\n");
      const shellProbe = [
        "set -eu",
        "ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=1 -c:a aac /tmp/source.m4a",
        "python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp >/tmp/http.log 2>&1 &",
        "server_pid=$!",
        "trap 'kill \"$server_pid\" 2>/dev/null || true' EXIT",
        "sleep 1",
        `node --input-type=module --eval ${quoteForShell(nodeProbe)}`,
        'test "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 /tmp/output.mp3)" = mp3',
        'test "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 /tmp/output.flac)" = flac',
        'test -z "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 /tmp/output.mp3)"',
        'test -z "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 /tmp/output.flac)"',
        'printf \'mp3=%s flac=%s\\n\' "$(stat -c %s /tmp/output.mp3)" "$(stat -c %s /tmp/output.flac)"',
      ].join("\n");

      const result = await runDocker(
        ["run", "--rm", "--entrypoint", "/bin/sh", image, "-c", shellProbe],
        120_000,
      );

      expect(result.stdout).toMatch(/^mp3=\d+ flac=\d+\r?\n$/);
      expect(result.stderr).toBe("");
    },
    12 * 60_000,
  );
});

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runDocker(
  args: readonly string[],
  timeoutMs: number,
  allowFailure = false,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-65_536);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `docker ${args[0] ?? "command"} failed (${code ?? "signal"})\n${stderr}`,
        ),
      );
    });
  });
}
