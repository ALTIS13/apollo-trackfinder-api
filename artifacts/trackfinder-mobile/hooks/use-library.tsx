import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { apiFetch } from '@/hooks/use-session';

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
}

interface LibraryState {
  tracks: SavedTrack[];
  isDownloading: Record<string, boolean>;
  downloadProgress: Record<string, number>;
  download: (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  isSaved: (id: string) => boolean;
}

const LibraryContext = createContext<LibraryState | null>(null);

export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [isDownloading, setIsDownloading] = useState<Record<string, boolean>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions();

  useEffect(() => {
    AsyncStorage.getItem(LIBRARY_KEY).then((raw) => {
      if (raw) {
        try { setTracks(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  const save = useCallback(async (updated: SavedTrack[]) => {
    setTracks(updated);
    await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
  }, []);

  const download = useCallback(
    async (track: { id: string; title: string; artist: string; thumbnailUrl: string | null; duration: number }) => {
      if (isDownloading[track.id]) return;
      setIsDownloading((p) => ({ ...p, [track.id]: true }));
      setDownloadProgress((p) => ({ ...p, [track.id]: 0 }));

      try {
        const resp = await apiFetch<{ url: string }>(`/tracks/${track.id}/download`);
        const downloadUrl = resp.url;

        const safe = track.title.replace(/[^a-z0-9_\-\s]/gi, '').replace(/\s+/g, '_');
        const filename = `${safe}_${track.id.slice(-6)}.mp3`;
        const localUri = (FileSystem.documentDirectory ?? '') + filename;

        const downloadResumable = FileSystem.createDownloadResumable(
          downloadUrl,
          localUri,
          {},
          (progress) => {
            const pct = progress.totalBytesExpectedToWrite > 0
              ? progress.totalBytesWritten / progress.totalBytesExpectedToWrite
              : 0;
            setDownloadProgress((p) => ({ ...p, [track.id]: pct }));
          },
        );

        const result = await downloadResumable.downloadAsync();
        if (!result) throw new Error('Download failed');

        if (Platform.OS === 'android' || Platform.OS === 'ios') {
          let perm = mediaPermission;
          if (!perm?.granted) perm = await requestMediaPermission();
          if (perm?.granted) {
            try { await MediaLibrary.createAssetAsync(result.uri); } catch {}
          }
        }

        const info = await FileSystem.getInfoAsync(result.uri);
        const fileSize = info.exists ? (info as { size?: number }).size : undefined;

        const saved: SavedTrack = {
          id: track.id,
          title: track.title,
          artist: track.artist,
          thumbnailUrl: track.thumbnailUrl,
          duration: track.duration,
          localUri: result.uri,
          savedAt: Date.now(),
          fileSize,
        };

        setTracks((prev) => {
          const filtered = prev.filter((t) => t.id !== track.id);
          const updated = [saved, ...filtered];
          AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
          return updated;
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
    [isDownloading, mediaPermission, requestMediaPermission],
  );

  const remove = useCallback(
    async (id: string) => {
      const track = tracks.find((t) => t.id === id);
      if (track?.localUri) {
        try { await FileSystem.deleteAsync(track.localUri, { idempotent: true }); } catch {}
      }
      const updated = tracks.filter((t) => t.id !== id);
      await save(updated);
    },
    [tracks, save],
  );

  const isSaved = useCallback((id: string) => tracks.some((t) => t.id === id), [tracks]);

  return (
    <LibraryContext.Provider value={{ tracks, isDownloading, downloadProgress, download, remove, isSaved }}>
      {children}
    </LibraryContext.Provider>
  );
}

export function useLibrary() {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary must be used within LibraryProvider');
  return ctx;
}
