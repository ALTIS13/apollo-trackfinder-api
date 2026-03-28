import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { getApiBase, getSessionId } from '@/hooks/use-session';
import { getQuality, loadQuality } from '@/hooks/use-settings';

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
}

interface LibraryState {
  tracks: SavedTrack[];
  isDownloading: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  saveToLibrary: (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number; source?: string }) => Promise<void>;
  download: (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bulkRemove: (ids: string[]) => Promise<void>;
  isSaved: (id: string) => boolean;
  isDownloaded: (id: string) => boolean;
}

const LibraryContext = createContext<LibraryState | null>(null);

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

  useEffect(() => {
    loadQuality();
    AsyncStorage.getItem(LIBRARY_KEY).then((raw) => {
      if (raw) {
        try { setTracks(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  const saveToLibrary = useCallback(
    async (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number; source?: string }) => {
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
        };
        const updated = [entry, ...prev];
        AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
        return updated;
      });
    },
    [],
  );

  const download = useCallback(
    async (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }) => {
      if (isDownloading[track.id]) return;
      setIsDownloading((p) => ({ ...p, [track.id]: true }));
      setDownloadProgress((p) => ({ ...p, [track.id]: 0 }));

      try {
        const quality = getQuality();
        const ext = quality === 'flac' ? 'flac' : 'mp3';
        const downloadUrl = `${getApiBase()}/tracks/${track.id}/download?quality=${quality}`;

        const safe = track.title.replace(/[^a-z0-9_\-\s]/gi, '').replace(/\s+/g, '_');
        const filename = `${safe}_${track.id.slice(-6)}.${ext}`;
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
        if (!result) throw new Error('Download failed');

        const granted = await tryGrantMediaPermission();
        if (granted) {
          try { await MediaLibrary.createAssetAsync(result.uri); } catch {}
        }

        const info = await FileSystem.getInfoAsync(result.uri);
        const fileSize = info.exists ? (info as { size?: number }).size : undefined;

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
    <LibraryContext.Provider value={{ tracks, isDownloading, downloadProgress, saveToLibrary, download, remove, bulkRemove, isSaved, isDownloaded }}>
      {children}
    </LibraryContext.Provider>
  );
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider');
  return ctx;
}
