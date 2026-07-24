import { spawn } from "node:child_process";

export interface YtDlpEntry {
  readonly id: string;
  readonly title: string;
  readonly uploader?: string;
  readonly duration?: number;
  readonly thumbnail?: string;
  readonly view_count?: number;
  readonly webpage_url?: string;
  readonly formats?: readonly {
    readonly format_id: string;
    readonly ext: string;
    readonly abr?: number;
    readonly vcodec?: string;
  }[];
}

export class YtDlpSearchError extends Error {
  constructor(readonly kind: "timeout" | "output_limit" | "process") {
    super(kind);
    this.name = "YtDlpSearchError";
  }
}

const SEARCH_TIMEOUT_MS = 45_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const CHILD_ENV_KEYS = ["PATH", "HOME", "XDG_CACHE_HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"] as const;

export function createYtDlpEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8" };
  for (const key of CHILD_ENV_KEYS) {
    if (environment[key] !== undefined) childEnvironment[key] = environment[key];
  }
  return childEnvironment;
}

function runSearch(prefix: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const proc = spawn("yt-dlp", [
      prefix,
      "--no-download",
      "--dump-json",
      "--no-warnings",
      "--no-playlist",
      "--no-cache-dir",
    ], {
      env: createYtDlpEnvironment(),
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(() => reject(new YtDlpSearchError("timeout")));
    }, SEARCH_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        proc.kill("SIGKILL");
        finish(() => reject(new YtDlpSearchError("output_limit")));
        return;
      }
      chunks.push(chunk);
    });
    proc.stderr.resume();
    proc.on("error", () => finish(() => reject(new YtDlpSearchError("process"))));
    proc.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) {
        finish(() => reject(new YtDlpSearchError("process")));
        return;
      }
      finish(() => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
  });
}

async function search(prefix: string, query: string, maxResults: number): Promise<YtDlpEntry[]> {
  const output = await runSearch(`${prefix}${maxResults}:${query}`);
  const entries: YtDlpEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as YtDlpEntry);
    } catch {
      // yt-dlp occasionally emits non-JSON progress lines despite --no-warnings.
    }
  }
  return entries;
}

export function ytdlpSearch(query: string, maxResults = 10): Promise<YtDlpEntry[]> {
  return search("ytsearch", query, maxResults);
}

export function bcdlpSearch(query: string, maxResults = 10): Promise<YtDlpEntry[]> {
  return search("bcsearch", query, maxResults);
}
