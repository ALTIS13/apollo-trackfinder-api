import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getClientSessionId } from "@/lib/client-session";
import { API_BASE } from "@/lib/api-config";

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

function sessionHeaders(): Record<string, string> {
  return { "X-Client-Session": getClientSessionId() };
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      ...sessionHeaders(),
      ...(options?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: resp.statusText }));
    throw new Error((err as { message?: string }).message ?? "Request failed");
  }
  return resp.json();
}

export function useYandexStatus() {
  return useQuery<YandexStatus>({
    queryKey: ["yandex", "status"],
    queryFn: () => apiFetch(`${API_BASE}/yandex/status`),
    retry: false,
  });
}

export function useYandexSaveToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiFetch(`${API_BASE}/yandex/token`, {
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
    mutationFn: () => apiFetch(`${API_BASE}/yandex/logout`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["yandex"] });
    },
  });
}

export function useYandexLiked(offset = 0, limit = 50) {
  return useQuery<{ tracks: YandexTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["yandex", "liked", offset, limit],
    queryFn: () =>
      apiFetch(`${API_BASE}/yandex/liked?offset=${offset}&limit=${limit}`),
    enabled: false,
  });
}

export function useYandexPlaylists() {
  return useQuery<{ playlists: YandexPlaylist[]; total: number }>({
    queryKey: ["yandex", "playlists"],
    queryFn: () => apiFetch(`${API_BASE}/yandex/playlists`),
    enabled: false,
  });
}

export function useYandexPlaylistTracks(uid: number | null, kind: number | null, offset = 0, limit = 50) {
  return useQuery<{ tracks: YandexTrack[]; total: number; offset: number; limit: number }>({
    queryKey: ["yandex", "playlist", uid, kind, offset, limit],
    queryFn: () =>
      apiFetch(`${API_BASE}/yandex/playlists/${uid}/${kind}/tracks?offset=${offset}&limit=${limit}`),
    enabled: uid != null && kind != null,
  });
}
