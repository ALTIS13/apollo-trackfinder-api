import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api-config";
import { tfFetch } from "@/lib/tf-session-client";

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

export function useSpotifyStatus() {
  return useQuery<SpotifyStatus>({
    queryKey: ["spotify", "status"],
    queryFn: () => tfFetch("/spotify/status"),
    retry: false,
  });
}

export function useSpotifyLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => tfFetch("/spotify/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spotify"] });
    },
  });
}

export function useSpotifyLiked(offset = 0, limit = 50) {
  return useQuery<{ tracks: SpotifyTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["spotify", "liked", offset, limit],
    queryFn: () =>
      tfFetch(`/spotify/liked?offset=${offset}&limit=${limit}`),
    enabled: false,
  });
}

export function useSpotifyPlaylists() {
  return useQuery<{ playlists: SpotifyPlaylist[]; total: number }>({
    queryKey: ["spotify", "playlists"],
    queryFn: () => tfFetch("/spotify/playlists"),
    enabled: false,
  });
}

export function useSpotifyPlaylistTracks(playlistId: string | null, offset = 0, limit = 50) {
  return useQuery<{ tracks: SpotifyTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["spotify", "playlist", playlistId, offset, limit],
    queryFn: () =>
      tfFetch(`/spotify/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}`),
    enabled: !!playlistId,
  });
}

export function useSpotifyTopTracks(timeRange: "short_term" | "medium_term" | "long_term" = "medium_term") {
  return useQuery<{ tracks: SpotifyTrack[]; timeRange: string }>({
    queryKey: ["spotify", "top-tracks", timeRange],
    queryFn: () => tfFetch(`/spotify/top-tracks?time_range=${timeRange}`),
    enabled: false,
  });
}

export function spotifyLoginUrl(): string {
  return apiUrl("/spotify/login");
}
