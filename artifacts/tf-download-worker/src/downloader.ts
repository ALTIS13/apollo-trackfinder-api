import type { DownloadQuality } from "@workspace/tf-download-contract";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

export interface DownloaderProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DownloaderProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<DownloaderProcessExit>;
  readonly closed: Promise<void>;
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnYtDlpDownloadOptions {
  readonly executable: string;
  readonly quality: DownloadQuality;
  readonly sourceUrl: string;
  readonly signal: AbortSignal;
}

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;
type SpawnedTranscoder = ChildProcessByStdio<Writable, Readable, Readable>;

interface ProcessOptions extends SpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly signal: AbortSignal;
}

export interface ProcessSpawner {
  (
    command: string,
    args: readonly string[],
    options: ProcessOptions & {
      readonly stdio: readonly ["ignore", "pipe", "pipe"];
    },
  ): SpawnedProcess;
  (
    command: string,
    args: readonly string[],
    options: ProcessOptions & {
      readonly stdio: readonly ["pipe", "pipe", "pipe"];
    },
  ): SpawnedTranscoder;
}

export type SpawnDownload = (
  options: SpawnYtDlpDownloadOptions,
) => DownloaderProcess;

export function spawnYtDlpDownload(
  options: SpawnYtDlpDownloadOptions,
  spawnProcess: ProcessSpawner = spawn as ProcessSpawner,
): DownloaderProcess {
  const downloaderArgs = [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--quiet",
    "--format",
    "bestaudio/best",
    "--output",
    "-",
    "--",
    options.sourceUrl,
  ];
  const downloader = spawnProcess(options.executable, downloaderArgs, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    signal: options.signal,
  });
  let transcoder: SpawnedTranscoder;
  try {
    transcoder = spawnProcess("ffmpeg", createFfmpegArgs(options.quality), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
  } catch (error) {
    safeKill(downloader, "SIGKILL");
    throw error;
  }

  downloader.stdout.pipe(transcoder.stdin);
  transcoder.stdin.on("error", () => {
    safeKill(downloader, "SIGTERM");
  });
  const stderr = new PassThrough();
  downloader.stderr.pipe(stderr, { end: false });
  transcoder.stderr.pipe(stderr, { end: false });

  let downloaderExit: DownloaderProcessExit | undefined;
  let transcoderExit: DownloaderProcessExit | undefined;
  let closedCount = 0;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const observeClose = (): void => {
    closedCount += 1;
    if (closedCount !== 2) return;
    stderr.end();
    resolveClosed?.();
  };
  downloader.once("close", (code, signal) => {
    downloaderExit = { code, signal };
    observeClose();
  });
  transcoder.once("close", (code, signal) => {
    transcoderExit = { code, signal };
    observeClose();
  });

  const completion = new Promise<DownloaderProcessExit>((resolve, reject) => {
    downloader.once("error", reject);
    transcoder.once("error", reject);
    void closed.then(() => {
      const sourceExit = downloaderExit ?? { code: null, signal: null };
      const conversionExit = transcoderExit ?? { code: null, signal: null };
      resolve(sourceExit.code === 0 ? conversionExit : sourceExit);
    });
  });

  return {
    stdout: transcoder.stdout,
    stderr,
    completion,
    closed,
    kill(signal) {
      safeKill(downloader, signal);
      safeKill(transcoder, signal);
    },
  };
}

function createFfmpegArgs(quality: DownloadQuality): string[] {
  const output =
    quality === "flac"
      ? ["-codec:a", "flac", "-compression_level", "5", "-f", "flac"]
      : ["-codec:a", "libmp3lame", "-b:a", `${quality}k`, "-f", "mp3"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostats",
    "-i",
    "pipe:0",
    "-map",
    "0:a:0",
    "-vn",
    "-map_metadata",
    "-1",
    ...output,
    "pipe:1",
  ];
}

function safeKill(
  child: Pick<SpawnedProcess, "kill"> | Pick<SpawnedTranscoder, "kill">,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal);
  } catch {
    // The sibling process still receives the same termination request.
  }
}
