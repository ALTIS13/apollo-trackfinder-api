import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

export type DownloadQuality = '128' | '192' | '256' | '320' | 'flac';

const QUALITY_KEY = 'trackfinder_download_quality';
const DEFAULT_QUALITY: DownloadQuality = '256';

export const QUALITY_OPTIONS: { value: DownloadQuality; label: string; desc: string }[] = [
  { value: '128', label: '128 kbps', desc: 'Экономия трафика' },
  { value: '192', label: '192 kbps', desc: 'Хорошее качество' },
  { value: '256', label: '256 kbps', desc: 'Высокое качество' },
  { value: '320', label: '320 kbps', desc: 'Максимальное MP3' },
  { value: 'flac', label: 'FLAC', desc: 'Без потерь' },
];

let _quality: DownloadQuality = DEFAULT_QUALITY;
let _loaded = false;
const _listeners: Set<() => void> = new Set();

export async function loadQuality(): Promise<void> {
  if (_loaded) return;
  try {
    const stored = await AsyncStorage.getItem(QUALITY_KEY);
    if (stored && ['128', '192', '256', '320', 'flac'].includes(stored)) {
      _quality = stored as DownloadQuality;
    }
  } catch {}
  _loaded = true;
  _listeners.forEach((fn) => fn());
}

export async function setQuality(q: DownloadQuality): Promise<void> {
  _quality = q;
  await AsyncStorage.setItem(QUALITY_KEY, q).catch(() => {});
  _listeners.forEach((fn) => fn());
}

export function getQuality(): DownloadQuality {
  return _quality;
}

export function useDownloadQuality() {
  const [quality, setLocalQuality] = useState<DownloadQuality>(_quality);

  useEffect(() => {
    const update = () => setLocalQuality(_quality);
    _listeners.add(update);
    if (!_loaded) loadQuality();
    else update();
    return () => { _listeners.delete(update); };
  }, []);

  const changeQuality = useCallback(async (q: DownloadQuality) => {
    await setQuality(q);
  }, []);

  return { quality, changeQuality };
}
