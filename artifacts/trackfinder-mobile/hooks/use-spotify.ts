import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';

import { apiFetch, getApiBase, getSessionId } from '@/hooks/use-session';

WebBrowser.maybeCompleteAuthSession();


export interface SpotifyStatus {
  connected: boolean;
  displayName?: string;
}

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  thumbnailUrl: string | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string;
  trackCount: number;
  thumbnailUrl: string | null;
  owner: string;
}

export function useSpotifyStatus() {
  return useQuery({
    queryKey: ['spotify', 'status'],
    queryFn: () => apiFetch<SpotifyStatus>('/spotify/status'),
    refetchInterval: 3000,
  });
}

export function useSpotifyLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const sid = getSessionId();
      const loginUrl = `${getApiBase()}/spotify/login?sid=${encodeURIComponent(sid)}&mobile=1`;
      const result = await WebBrowser.openAuthSessionAsync(loginUrl, 'trackfinder://');
      if (result.type === 'success') {
        await qc.invalidateQueries({ queryKey: ['spotify'] });
      }
      return result;
    },
  });
}

export function useSpotifyLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/spotify/logout', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spotify'] }),
  });
}

export function useSpotifyLiked(page: number, limit = 20) {
  return useQuery({
    queryKey: ['spotify', 'liked', page],
    queryFn: () =>
      apiFetch<{ tracks: SpotifyTrack[]; total: number; hasMore: boolean }>(
        `/spotify/liked?limit=${limit}&offset=${page * limit}`,
      ),
    enabled: false,
  });
}

export function useSpotifyPlaylists() {
  return useQuery({
    queryKey: ['spotify', 'playlists'],
    queryFn: () => apiFetch<{ playlists: SpotifyPlaylist[] }>('/spotify/playlists'),
    enabled: false,
  });
}

export function useSpotifyPlaylistTracks(id: string | null, page = 0, limit = 20) {
  return useQuery({
    queryKey: ['spotify', 'playlist-tracks', id, page],
    queryFn: () =>
      apiFetch<{ tracks: SpotifyTrack[]; total: number; hasMore: boolean }>(
        `/spotify/playlists/${id}/tracks?limit=${limit}&offset=${page * limit}`,
      ),
    enabled: !!id,
  });
}

export function useSpotifyLikedAll() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ tracks: SpotifyTrack[]; total: number }>('/spotify/liked-all'),
  });
}

export function useSpotifyTopTracks() {
  return useQuery({
    queryKey: ['spotify', 'top-tracks'],
    queryFn: () => apiFetch<{ tracks: SpotifyTrack[] }>('/spotify/top-tracks'),
    enabled: false,
  });
}
