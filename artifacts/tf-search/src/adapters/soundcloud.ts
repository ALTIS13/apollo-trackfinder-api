import { classify } from "../classifier.js";
import type { InternalTrack } from "../search-service.js";

let cachedClientId: string | null = null;
let clientIdFetchedAt = 0;
const CLIENT_ID_TTL_MS = 30 * 60 * 1_000;

interface SoundCloudTrack {
  readonly id: number;
  readonly title: string;
  readonly permalink_url?: string;
  readonly duration?: number;
  readonly playback_count?: number;
  readonly artwork_url?: string;
  readonly user?: { readonly username?: string };
}

function encodeTrackId(url: string): string {
  return `sc_${Buffer.from(url).toString("base64url")}`;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function extractClientId(): Promise<string> {
  const now = Date.now();
  if (cachedClientId && now - clientIdFetchedAt < CLIENT_ID_TTL_MS) return cachedClientId;

  const home = await fetchWithTimeout("https://soundcloud.com", 12_000);
  if (!home.ok) throw new Error("soundcloud_home_failed");
  const html = await home.text();
  const scriptUrls = [...html.matchAll(/src="(https:\/\/[^\"]*\.js[^\"]*)"/g)].map((match) => match[1]!);

  for (const scriptUrl of scriptUrls.slice(-8)) {
    try {
      const script = await fetchWithTimeout(scriptUrl, 8_000);
      if (!script.ok) continue;
      const match = (await script.text()).match(/client_id[=:"]+([a-zA-Z0-9]{20,})/);
      if (match?.[1]) {
        cachedClientId = match[1];
        clientIdFetchedAt = now;
        return cachedClientId;
      }
    } catch {
      // A single stale script must not hide usable scripts later in the page.
    }
  }

  throw new Error("soundcloud_client_id_missing");
}

export async function searchSoundCloud(query: string, maxResults = 10): Promise<readonly InternalTrack[]> {
  const clientId = await extractClientId();
  const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${maxResults}&offset=0`;
  const response = await fetchWithTimeout(url, 12_000);
  if (!response.ok) {
    if (response.status === 401) cachedClientId = null;
    throw new Error("soundcloud_search_failed");
  }

  const body = await response.json() as { readonly collection?: readonly SoundCloudTrack[] };
  return (body.collection ?? []).map((entry) => {
    const sourceUrl = entry.permalink_url ?? `https://soundcloud.com/tracks/${entry.id}`;
    return {
      id: encodeTrackId(sourceUrl),
      title: entry.title ?? "",
      artist: entry.user?.username ?? "Unknown",
      type: classify(entry.title ?? ""),
      duration: Math.round((entry.duration ?? 0) / 1_000),
      source: "soundcloud" as const,
      thumbnailUrl: entry.artwork_url?.replace("-large", "-t500x500") ?? null,
      quality: ["128"],
      viewCount: entry.playback_count ?? null,
      score: 0,
      sourceUrl,
    };
  });
}
