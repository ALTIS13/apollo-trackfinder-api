import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { tfFetch } from "@/lib/tf-session-client";

export interface YandexTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  thumbnailUrl: string | null;
  trackUrl: string;
}

export interface YandexPlaylist {
  kind: number;
  uid: number;
  title: string;
  description: string;
  trackCount: number;
  thumbnailUrl: string | null;
  owner: string;
}

export interface YandexStatus {
  connected: boolean;
  displayName?: string;
  login?: string;
  userId?: string;
}

export function useYandexStatus() {
  return useQuery<YandexStatus>({
    queryKey: ["yandex", "status"],
    queryFn: () => tfFetch("/yandex/status"),
    retry: false,
  });
}

export function useYandexSaveToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      tfFetch("/yandex/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["yandex"] });
    },
  });
}

export function useYandexLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => tfFetch("/yandex/logout", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["yandex"] });
    },
  });
}

export function useYandexLiked(offset = 0, limit = 50) {
  return useQuery<{ tracks: YandexTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["yandex", "liked", offset, limit],
    queryFn: () =>
      tfFetch(`/yandex/liked?offset=${offset}&limit=${limit}`),
    enabled: false,
  });
}

export function useYandexPlaylists() {
  return useQuery<{ playlists: YandexPlaylist[]; total: number }>({
    queryKey: ["yandex", "playlists"],
    queryFn: () => tfFetch("/yandex/playlists"),
    enabled: false,
  });
}

export function useYandexPlaylistTracks(uid: number | null, kind: number | null, offset = 0, limit = 50) {
  return useQuery<{ tracks: YandexTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["yandex", "playlist", uid, kind, offset, limit],
    queryFn: () =>
      tfFetch(`/yandex/playlists/${uid}/${kind}/tracks?offset=${offset}&limit=${limit}`),
    enabled: uid != null && kind != null,
  });
}
