import type { DownloadQuality } from "@workspace/tf-download-contract";
import { spawn } from "node:child_process";
import type {
  ChildProcessByStdio,
  SpawnOptions,
} from "node:child_process";
import type { Readable } from "node:stream";

export interface DownloaderProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DownloaderProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<DownloaderProcessExit>;
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnYtDlpDownloadOptions {
  readonly executable: string;
  readonly quality: DownloadQuality;
  readonly sourceUrl: string;
  readonly signal: AbortSignal;
}

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>;

export type ProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions & {
    readonly shell: false;
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
    readonly windowsHide: true;
    readonly signal: AbortSignal;
  },
) => SpawnedProcess;

export type SpawnDownload = (
  options: SpawnYtDlpDownloadOptions,
) => DownloaderProcess;

export function spawnYtDlpDownload(
  options: SpawnYtDlpDownloadOptions,
  spawnProcess: ProcessSpawner = spawn as ProcessSpawner,
): DownloaderProcess {
  const extension = options.quality === "flac" ? "flac" : "mp3";
  const args = [
    "--no-playlist",
    "--no-progress",
    "--no-warnings",
    "--extract-audio",
    "--audio-format",
    extension,
  ];
  if (options.quality !== "flac") {
    args.push("--audio-quality", `${options.quality}K`);
  }
  args.push("--output", "-", "--", options.sourceUrl);

  const child = spawnProcess(options.executable, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    signal: options.signal,
  });
  const completion = new Promise<DownloaderProcessExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    kill(signal) {
      child.kill(signal);
    },
  };
}
