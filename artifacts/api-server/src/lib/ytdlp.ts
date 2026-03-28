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
    [prefix, "--no-download", "--dump-json", "--no-warnings", "--no-playlist",
      "--extractor-args", "youtube:player_client=mweb"],
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

const YT_PLAYER_CLIENTS = [
  "mweb",
  "tv_embedded",
  "web",
  "ios",
];

export async function getStreamUrl(trackUrl: string): Promise<{ url: string; mimeType?: string }> {
  const isYouTube = trackUrl.includes("youtube.com") || trackUrl.includes("youtu.be");

  const clientList = isYouTube ? YT_PLAYER_CLIENTS : [""];

  let lastErr: Error = new Error("Unknown error");

  for (const client of clientList) {
    const extraArgs = client
      ? ["--extractor-args", `youtube:player_client=${client}`]
      : [];
    try {
      const output = await runYtDlp(
        [trackUrl, "--get-url", "-f", "bestaudio/best", "--no-warnings", ...extraArgs],
        30000,
      );

      const url = output.trim().split("\n")[0]?.trim() ?? "";
      if (!url) throw new Error("No stream URL returned by yt-dlp");

      let mimeType = "audio/webm";
      if (url.includes(".m3u8") || url.includes("manifest") || url.includes("playlist")) {
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

export function spawnAudioDownload(trackUrl: string): ChildProcess {
  const isYouTube = trackUrl.includes("youtube.com") || trackUrl.includes("youtu.be");
  const extraArgs = isYouTube
    ? ["--extractor-args", "youtube:player_client=mweb"]
    : [];

  return spawn(
    "yt-dlp",
    [
      trackUrl,
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "5",
      "-o", "-",
      "--no-warnings",
      ...extraArgs,
    ],
    { env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );
}
