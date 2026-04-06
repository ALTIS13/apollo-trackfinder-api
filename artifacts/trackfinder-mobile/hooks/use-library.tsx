import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { getApiBase, getSessionId } from '@/hooks/use-session';
import { getQuality, loadQuality, type DownloadQuality } from '@/hooks/use-settings';

const LIBRARY_KEY = 'trackfinder_library';

export interface SavedTrack {
  id: string;
  title: string;
  artist: string;
  thumbnailUrl: string | null;
  duration: number;
  localUri: string;
  savedAt: number;
  fileSize?: number;
  source?: string;
  downloadQuality?: DownloadQuality;
  importOrder?: number;
}

export interface BulkProgress {
  total: number;
  done: number;
  failed: number;
  active: boolean;
}

interface LibraryState {
  tracks: SavedTrack[];
  isDownloading: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  bulkProgress: BulkProgress;
  saveToLibrary: (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number; source?: string; importOrder?: number }) => Promise<void>;
  download: (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }) => Promise<void>;
  bulkDownload: (tracks: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }[]) => Promise<{ failed: number }>;
  /** Queue server-side async downloads (via BullMQ). Returns job IDs for polling. */
  queueServerDownloads: (tracks: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number; sourceUrl?: string }[]) => Promise<{ jobId: string; position: number; trackId: string }[]>;
  cancelBulkDownload: () => void;
  remove: (id: string) => Promise<void>;
  bulkRemove: (ids: string[]) => Promise<void>;
  isSaved: (id: string) => boolean;
  isDownloaded: (id: string) => boolean;
}

const LibraryContext = createContext<LibraryState | null>(null);

let _tracksRef: SavedTrack[] = [];

export function getLibraryLocalUri(trackId: string): string | undefined {
  const t = _tracksRef.find((s) => s.id === trackId);
  return t?.localUri || undefined;
}

async function tryGrantMediaPermission(): Promise<boolean> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return false;
  try {
    const { status } = await MediaLibrary.getPermissionsAsync();
    if (status === 'granted') return true;
    const { status: asked } = await MediaLibrary.requestPermissionsAsync();
    return asked === 'granted';
  } catch {
    return false;
  }
}

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [isDownloading, setIsDownloading] = useState<Record<string, boolean>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>({ total: 0, done: 0, failed: 0, active: false });
  const bulkCancelRef = useRef(false);

  useEffect(() => {
    loadQuality();
    AsyncStorage.getItem(LIBRARY_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as SavedTrack[];
          setTracks(parsed);
          _tracksRef = parsed;
        } catch {}
      }
    });
  }, []);

  useEffect(() => {
    _tracksRef = tracks;
  }, [tracks]);

  const saveToLibrary = useCallback(
    async (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number; source?: string; importOrder?: number }) => {
      setTracks((prev) => {
        if (prev.some((t) => t.id === track.id)) return prev;
        const entry: SavedTrack = {
          id: track.id,
          title: track.title,
          artist: track.artist,
          thumbnailUrl: track.thumbnailUrl,
          duration: track.duration,
          localUri: '',
          savedAt: Date.now(),
          source: track.source,
          importOrder: track.importOrder,
        };
        const updated = [entry, ...prev];
        AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
        return updated;
      });
    },
    [],
  );

  const downloadSingle = useCallback(
    async (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }): Promise<void> => {
      if (isDownloading[track.id]) return;
      setIsDownloading((p) => ({ ...p, [track.id]: true }));
      setDownloadProgress((p) => ({ ...p, [track.id]: 0 }));

      try {
        const quality = getQuality();
        const ext = quality === 'flac' ? 'flac' : 'mp3';
        const isDeezer = track.id.startsWith('dz_');
        const params = new URLSearchParams({ quality });
        if (isDeezer) {
          params.set('artist', track.artist);
          params.set('title', track.title);
        }
        const downloadUrl = `${getApiBase()}/tracks/${track.id}/download?${params}`;

        const safe = track.title.replace(/[^а-яёa-z0-9_\-\s]/gi, '').replace(/\s+/g, '_');
        const filename = `${safe || track.id.slice(-8)}_${track.id.slice(-6)}.${ext}`;
        const localUri = (FileSystem.documentDirectory ?? '') + filename;

        const downloadResumable = FileSystem.createDownloadResumable(
          downloadUrl,
          localUri,
          { headers: { 'X-Client-Session': getSessionId() } },
          (progress) => {
            const pct = progress.totalBytesExpectedToWrite > 0
              ? progress.totalBytesWritten / progress.totalBytesExpectedToWrite
              : 0;
            setDownloadProgress((p) => ({ ...p, [track.id]: pct }));
          },
        );

        const result = await downloadResumable.downloadAsync();
        if (!result) throw new Error('Download returned null');
        if (result.status && result.status >= 400) {
          await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
          throw new Error(`Server returned HTTP ${result.status}`);
        }

        const granted = await tryGrantMediaPermission();
        if (granted) {
          try { await MediaLibrary.createAssetAsync(result.uri); } catch {}
        }

        const info = await FileSystem.getInfoAsync(result.uri);
        const fileSize = info.exists ? (info as { size?: number }).size : undefined;

        // Reject 0-byte files — these come from failed Deezer CDN downloads
        // or yt-dlp errors. Don't save a broken localUri into the library.
        if (!fileSize || fileSize < 1024) {
          await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
          throw new Error(`Download produced an empty or corrupt file (${fileSize ?? 0} bytes)`);
        }

        setTracks((prev) => {
          const existing = prev.find((t) => t.id === track.id);
          const updated: SavedTrack = {
            id: track.id,
            title: track.title,
            artist: track.artist,
            thumbnailUrl: track.thumbnailUrl,
            duration: track.duration,
            localUri: result.uri,
            savedAt: existing?.savedAt ?? Date.now(),
            fileSize,
            source: existing?.source,
            downloadQuality: quality,
          };
          const filtered = prev.filter((t) => t.id !== track.id);
          const next = [updated, ...filtered];
          AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(next));
          return next;
        });
      } catch (e) {
        console.error('Download error:', e);
        throw e;
      } finally {
        setIsDownloading((p) => ({ ...p, [track.id]: false }));
        setDownloadProgress((p) => {
          const n = { ...p };
          delete n[track.id];
          return n;
        });
      }
    },
    [isDownloading],
  );

  const bulkDownload = useCallback(
    async (tracksToDownload: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }[]): Promise<{ failed: number }> => {
      const queue = tracksToDownload.filter((t) => !isDownloading[t.id]);
      if (queue.length === 0) return { failed: 0 };

      bulkCancelRef.current = false;
      setBulkProgress({ total: queue.length, done: 0, failed: 0, active: true });

      let failed = 0;
      let done = 0;

      for (const track of queue) {
        if (bulkCancelRef.current) break;
        try {
          await downloadSingle(track);
        } catch {
          failed++;
        }
        done++;
        if (!bulkCancelRef.current) {
          setBulkProgress({ total: queue.length, done, failed, active: done < queue.length && !bulkCancelRef.current });
        }
      }

      setBulkProgress({ total: queue.length, done, failed, active: false });
      return { failed };
    },
    [isDownloading, downloadSingle],
  );

  const cancelBulkDownload = useCallback(() => {
    bulkCancelRef.current = true;
    setBulkProgress((p) => ({ ...p, active: false }));
  }, []);

  /**
   * Queue server-side async downloads via BullMQ download endpoint.
   * Returns an array of { jobId, position, trackId } entries that callers
   * can poll via GET /tracks/download/status/:jobId.
   */
  const queueServerDownloads = useCallback(
    async (
      tracksInput: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number; sourceUrl?: string }[],
    ): Promise<{ jobId: string; position: number; trackId: string }[]> => {
      const quality = getQuality();
      const payload = tracksInput.map((t) => ({
        trackId: t.id,
        artist: t.artist,
        title: t.title,
        quality,
        sourceUrl: t.sourceUrl,
      }));
      const resp = await fetch(`${getApiBase()}/tracks/download/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Session': getSessionId(),
        },
        body: JSON.stringify({ tracks: payload }),
      });
      if (!resp.ok) throw new Error(`Queue request failed: HTTP ${resp.status}`);
      const data = await resp.json() as { results: Array<{ trackId: string; jobId?: string; position?: number; error?: string }> };
      return (data.results ?? [])
        .filter((r): r is { trackId: string; jobId: string; position: number } => !!r.jobId)
        .map((r) => ({ jobId: r.jobId, position: r.position, trackId: r.trackId }));
    },
    [],
  );

  const remove = useCallback(
    async (id: string) => {
      const track = tracks.find((t) => t.id === id);
      if (track?.localUri) {
        try { await FileSystem.deleteAsync(track.localUri, { idempotent: true }); } catch {}
      }
      const updated = tracks.filter((t) => t.id !== id);
      setTracks(updated);
      await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
    },
    [tracks],
  );

  const bulkRemove = useCallback(
    async (ids: string[]) => {
      const idSet = new Set(ids);
      setTracks((prev) => {
        const toDelete = prev.filter((t) => idSet.has(t.id));
        toDelete.forEach((t) => {
          if (t.localUri) {
            FileSystem.deleteAsync(t.localUri, { idempotent: true }).catch(() => {});
          }
        });
        const updated = prev.filter((t) => !idSet.has(t.id));
        AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
        return updated;
      });
    },
    [],
  );

  const isSaved = useCallback((id: string) => tracks.some((t) => t.id === id), [tracks]);
  const isDownloaded = useCallback((id: string) => tracks.some((t) => t.id === id && !!t.localUri), [tracks]);

  return (
    <LibraryContext.Provider value={{
      tracks,
      isDownloading,
      downloadProgress,
      bulkProgress,
      saveToLibrary,
      download: downloadSingle,
      bulkDownload,
      queueServerDownloads,
      cancelBulkDownload,
      remove,
      bulkRemove,
      isSaved,
      isDownloaded,
    }}>
      {children}
    </LibraryContext.Provider>
  );
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider');
  return ctx;
}
