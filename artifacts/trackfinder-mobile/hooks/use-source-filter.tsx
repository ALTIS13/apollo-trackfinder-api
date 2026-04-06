import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'trackfinder_source_prefs';

export type SourceKey = 'yt' | 'sc' | 'bc' | 'dz';
export type SourceMode = 'auto' | 'manual';

export interface SourceState {
  yt: boolean;
  sc: boolean;
  bc: boolean;
  dz: boolean;
}

export const SOURCE_LABELS: Record<SourceKey, string> = {
  yt: 'YouTube',
  sc: 'SoundCloud',
  bc: 'Bandcamp',
  dz: 'Deezer',
};

const DEFAULT_SOURCES: SourceState = { yt: true, sc: true, bc: true, dz: true };

export function useSourceFilter() {
  const [mode, setMode] = useState<SourceMode>('auto');
  const [sources, setSources] = useState<SourceState>({ ...DEFAULT_SOURCES });

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as { mode: SourceMode; sources: SourceState };
        if (parsed.mode) setMode(parsed.mode);
        if (parsed.sources) setSources(parsed.sources);
      } catch {}
    });
  }, []);

  const persist = useCallback((m: SourceMode, s: SourceState) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: m, sources: s })).catch(() => {});
  }, []);

  const toggleSource = useCallback((key: SourceKey) => {
    setSources((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      const enabledCount = Object.values(next).filter(Boolean).length;
      if (enabledCount === 0) return prev;
      const newMode: SourceMode = 'manual';
      setMode(newMode);
      persist(newMode, next);
      return next;
    });
  }, [persist]);

  const setAuto = useCallback(() => {
    const next = { ...DEFAULT_SOURCES };
    setMode('auto');
    setSources(next);
    persist('auto', next);
  }, [persist]);

  const enabledSources = (Object.keys(sources) as SourceKey[]).filter((k) => sources[k]);
  const isAllEnabled = enabledSources.length === 4;

  return { mode, sources, enabledSources, isAllEnabled, toggleSource, setAuto };
}
