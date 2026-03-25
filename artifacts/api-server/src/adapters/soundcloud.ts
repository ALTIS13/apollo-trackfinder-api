import { classify } from "../lib/classifier.js";
import type { TrackType } from "../lib/classifier.js";

export interface NormalizedTrack {
  id: string;
  title: string;
  artist: string;
  type: TrackType;
  duration: number;
  source: "soundcloud";
  thumbnailUrl: string | null;
  quality: string[];
  viewCount: number | null;
  score: number;
  _sourceUrl: string;
}

function encodeTrackId(source: "yt" | "sc", url: string): string {
  return `${source}_${Buffer.from(url).toString("base64url")}`;
}

let cachedClientId: string | null = null;
let clientIdFetchedAt = 0;
const CLIENT_ID_TTL_MS = 30 * 60 * 1000;

async function fetchWithTimeout(url: string, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function extractClientId(): Promise<string> {
  const now = Date.now();
  if (cachedClientId && now - clientIdFetchedAt < CLIENT_ID_TTL_MS) {
    return cachedClientId;
  }

  const homeRes = await fetchWithTimeout("https://soundcloud.com", 12000);
  if (!homeRes.ok) throw new Error(`SoundCloud home returned ${homeRes.status}`);
  const html = await homeRes.text();

  const scriptMatches = [...html.matchAll(/src="(https:\/\/[^"]*\.js[^"]*)"/g)].map((m) => m[1]!);

  for (const scriptUrl of scriptMatches.slice(-8)) {
    try {
      const jsRes = await fetchWithTimeout(scriptUrl, 8000);
      if (!jsRes.ok) continue;
      const js = await jsRes.text();
      const match = js.match(/client_id[=:"]+([a-zA-Z0-9]{20,})/);
      if (match?.[1]) {
        cachedClientId = match[1];
        clientIdFetchedAt = now;
        return cachedClientId;
      }
    } catch {
      // try next script
    }
  }

  throw new Error("Could not find SoundCloud client_id in page scripts");
}

interface SoundCloudTrack {
  id: number;
  title: string;
  permalink_url: string;
  duration: number;
  playback_count?: number;
  artwork_url?: string;
  user: { username: string };
}

async function searchSoundCloudApi(query: string, clientId: string, limit = 10): Promise<SoundCloudTrack[]> {
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&offset=0`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) {
    if (res.status === 401) {
      cachedClientId = null;
    }
    throw new Error(`SoundCloud API returned ${res.status}`);
  }
  const data = (await res.json()) as { collection: SoundCloudTrack[] };
  return data.collection ?? [];
}

export async function searchSoundCloud(
  query: string,
  maxResults = 10,
): Promise<NormalizedTrack[]> {
  let clientId: string;
  try {
    clientId = await extractClientId();
  } catch {
    return [];
  }

  let tracks: SoundCloudTrack[];
  try {
    tracks = await searchSoundCloudApi(query, clientId, maxResults);
  } catch {
    return [];
  }

  return tracks.map((t) => {
    const url = t.permalink_url ?? `https://soundcloud.com/tracks/${t.id}`;
    return {
      id: encodeTrackId("sc", url),
      title: t.title ?? "",
      artist: t.user?.username ?? "Unknown",
      type: classify(t.title ?? "") as TrackType,
      duration: Math.round((t.duration ?? 0) / 1000),
      source: "soundcloud" as const,
      thumbnailUrl: t.artwork_url?.replace("-large", "-t500x500") ?? null,
      quality: ["128"],
      viewCount: t.playback_count ?? null,
      score: 0,
      _sourceUrl: url,
    };
  });
}
