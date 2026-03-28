import { spawn, ChildProcess } from "child_process";

export interface YtDlpEntry {
  id: string;
  title: string;
  uploader?: string;
  duration?: number;
  thumbnail?: string;
  view_count?: number;
  webpage_url?: string;
  url?: string;
  formats?: Array<{ format_id: string; ext: string; abr?: number; vcodec?: string }>;
  _type?: string;
}

function runYtDlp(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const proc = spawn("yt-dlp", args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("yt-dlp timed out"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && chunks.length === 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8");
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function ytdlpSearch(query: string, maxResults = 10): Promise<YtDlpEntry[]> {
  const prefix = `ytsearch${maxResults}:${query}`;
  const output = await runYtDlp(
    [prefix, "--no-download", "--dump-json", "--no-warnings", "--no-playlist"],
    45000,
  );

  const entries: YtDlpEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as YtDlpEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export async function scdlpSearch(query: string, maxResults = 10): Promise<YtDlpEntry[]> {
  const prefix = `scsearch${maxResults}:${query}`;
  const output = await runYtDlp(
    [prefix, "--no-download", "--dump-json", "--no-warnings", "--no-playlist"],
    45000,
  );

  const entries: YtDlpEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as YtDlpEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export async function bcdlpSearch(query: string, maxResults = 10): Promise<YtDlpEntry[]> {
  const prefix = `bcsearch${maxResults}:${query}`;
  const output = await runYtDlp(
    [prefix, "--no-download", "--dump-json", "--no-warnings", "--no-playlist"],
    45000,
  );

  const entries: YtDlpEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as YtDlpEntry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * Get a playable stream URL for a track.
 * YouTube now serves audio as HLS (m3u8), so we use "bestaudio*" to accept
 * HLS audio-only streams. Fallback player clients are tried if the first fails.
 */
export async function getStreamUrl(trackUrl: string): Promise<{ url: string; mimeType?: string }> {
  const isYouTube = trackUrl.includes("youtube.com") || trackUrl.includes("youtu.be");

  // For YouTube: try without player-client override first (default works with HLS),
  // then try explicit clients as fallback. Non-YouTube sources need no client arg.
  const clientList = isYouTube ? ["", "tv_embedded", "ios"] : [""];

  let lastErr: Error = new Error("Unknown error");

  for (const client of clientList) {
    const extraArgs = client
      ? ["--extractor-args", `youtube:player_client=${client}`]
      : [];

    // Use "bestaudio*" so yt-dlp accepts HLS audio-only streams (format 233/234)
    const formatSelector = isYouTube ? "bestaudio*" : "bestaudio/best";

    try {
      const output = await runYtDlp(
        [trackUrl, "--get-url", "-f", formatSelector, "--no-warnings", ...extraArgs],
        30000,
      );

      const url = output.trim().split("\n")[0]?.trim() ?? "";
      if (!url) throw new Error("No stream URL returned by yt-dlp");

      let mimeType = "audio/webm";
      if (url.includes(".m3u8") || url.includes("manifest") || url.includes("hls_playlist")) {
        mimeType = "application/x-mpegURL";
      } else if (url.includes(".mp4") || url.includes("itag=140")) {
        mimeType = "audio/mp4";
      } else if (url.includes(".mp3")) {
        mimeType = "audio/mpeg";
      } else if (url.includes(".opus") || url.includes("itag=251")) {
        mimeType = "audio/opus";
      }

      return { url, mimeType };
    } catch (e) {
      lastErr = e as Error;
    }
  }

  throw lastErr;
}

export type AudioQuality = "128" | "192" | "256" | "320" | "flac";

/**
 * Spawn a yt-dlp process that downloads audio and pipes it to stdout.
 * NOTE: Do NOT use "--extractor-args youtube:player_client=mweb" — mweb
 * produces 0 bytes when piping to stdout. The default client works correctly.
 */
export function spawnAudioDownload(trackUrl: string, quality: AudioQuality = "256"): ChildProcess {
  const isFlac = quality === "flac";
  const formatArgs = isFlac
    ? ["--audio-format", "flac"]
    : ["--audio-format", "mp3", "--audio-quality", `${quality}K`];

  return spawn(
    "yt-dlp",
    [
      trackUrl,
      "-x",
      ...formatArgs,
      "-o", "-",
      "--no-warnings",
    ],
    { env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );
}
