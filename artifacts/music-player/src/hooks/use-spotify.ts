import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/+/g, "/").replace(":/", "://");

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  thumbnailUrl: string | null;
  spotifyUrl: string;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string;
  trackCount: number;
  thumbnailUrl: string | null;
  owner: string;
}

export interface SpotifyStatus {
  connected: boolean;
  displayName?: string;
  spotifyUserId?: string;
}

async function apiFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), { credentials: "include" });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: resp.statusText }));
    throw new Error(err.message ?? "Request failed");
  }
  return resp.json();
}

export function useSpotifyStatus() {
  return useQuery<SpotifyStatus>({
    queryKey: ["spotify", "status"],
    queryFn: () => apiFetch(`${API_BASE}/spotify/status`),
    retry: false,
  });
}

export function useSpotifyLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`${API_BASE}/spotify/logout`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spotify"] });
    },
  });
}

export function useSpotifyLiked(offset = 0, limit = 50) {
  return useQuery<{ tracks: SpotifyTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["spotify", "liked", offset, limit],
    queryFn: () =>
      apiFetch(`${API_BASE}/spotify/liked`, {
        offset: String(offset),
        limit: String(limit),
      }),
    enabled: false,
  });
}

export function useSpotifyPlaylists() {
  return useQuery<{ playlists: SpotifyPlaylist[]; total: number }>({
    queryKey: ["spotify", "playlists"],
    queryFn: () => apiFetch(`${API_BASE}/spotify/playlists`),
    enabled: false,
  });
}

export function useSpotifyPlaylistTracks(playlistId: string | null, offset = 0, limit = 50) {
  return useQuery<{ tracks: SpotifyTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["spotify", "playlist", playlistId, offset, limit],
    queryFn: () =>
      apiFetch(`${API_BASE}/spotify/playlists/${playlistId}/tracks`, {
        offset: String(offset),
        limit: String(limit),
      }),
    enabled: !!playlistId,
  });
}

export function useSpotifyTopTracks(timeRange: "short_term" | "medium_term" | "long_term" = "medium_term") {
  return useQuery<{ tracks: SpotifyTrack[]; timeRange: string }>({
    queryKey: ["spotify", "top-tracks", timeRange],
    queryFn: () => apiFetch(`${API_BASE}/spotify/top-tracks`, { time_range: timeRange }),
    enabled: false,
  });
}

export function spotifyLoginUrl(): string {
  return `${API_BASE}/spotify/login`;
}
