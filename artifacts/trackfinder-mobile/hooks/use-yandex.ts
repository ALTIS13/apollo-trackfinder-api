import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '@/hooks/use-session';

export interface YandexStatus {
  connected: boolean;
  login?: string;
  uid?: number;
}

export interface YandexTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  thumbnailUrl: string | null;
}

export interface YandexPlaylist {
  kind: number;
  title: string;
  trackCount: number;
  thumbnailUrl: string | null;
  uid: number;
}

export function useYandexStatus() {
  return useQuery({
    queryKey: ['yandex', 'status'],
    queryFn: () => apiFetch<YandexStatus>('/yandex/status'),
    staleTime: 30000,
    refetchOnWindowFocus: true,
  });
}

export function useYandexConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch('/yandex/connect', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['yandex'] }),
  });
}

export function useYandexDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/yandex/disconnect', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['yandex'] }),
  });
}

export function useYandexLiked(page = 0, limit = 20) {
  return useQuery({
    queryKey: ['yandex', 'liked', page],
    queryFn: () =>
      apiFetch<{ tracks: YandexTrack[]; total: number; hasMore: boolean }>(
        `/yandex/liked?limit=${limit}&offset=${page * limit}`,
      ),
    enabled: false,
  });
}

export function useYandexPlaylists() {
  return useQuery({
    queryKey: ['yandex', 'playlists'],
    queryFn: () => apiFetch<{ playlists: YandexPlaylist[] }>('/yandex/playlists'),
    enabled: false,
  });
}

export function useYandexPlaylistTracks(uid: number | null, kind: number | null, page = 0, limit = 20) {
  return useQuery({
    queryKey: ['yandex', 'playlist-tracks', uid, kind, page],
    queryFn: () =>
      apiFetch<{ tracks: YandexTrack[]; total: number; hasMore: boolean }>(
        `/yandex/playlists/${uid}/${kind}/tracks?limit=${limit}&offset=${page * limit}`,
      ),
    enabled: uid !== null && kind !== null,
  });
}
