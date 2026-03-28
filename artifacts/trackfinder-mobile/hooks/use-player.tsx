import { Audio } from 'expo-av';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { getApiBase } from '@/hooks/use-session';

export interface PlayerTrack {
  id: string;
  title: string;
  artist: string;
  thumbnailUrl: string | null;
  duration: number;
  localUri?: string;
  source?: string;
  type?: string;
}

interface PlayerState {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  isLoading: boolean;
  position: number;
  duration: number;
  showFullPlayer: boolean;
  play: (track: PlayerTrack) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  seek: (pos: number) => Promise<void>;
  openFullPlayer: () => void;
  closeFullPlayer: () => void;
}

const PlayerContext = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showFullPlayer, setShowFullPlayer] = useState(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const reqIdRef = useRef(0);
  const openFullPlayer = useCallback(() => setShowFullPlayer(true), []);
  const closeFullPlayer = useCallback(() => setShowFullPlayer(false), []);

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
    }).catch(() => {});
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  const stop = useCallback(async () => {
    reqIdRef.current += 1;
    if (soundRef.current) {
      await soundRef.current.unloadAsync().catch(() => {});
      soundRef.current = null;
    }
    setIsPlaying(false);
    setPosition(0);
    setDuration(0);
    setCurrentTrack(null);
  }, []);

  const play = useCallback(async (track: PlayerTrack) => {
    const reqId = ++reqIdRef.current;

    try {
      setIsLoading(true);

      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
      setIsPlaying(false);
      setPosition(0);
      // Seed duration from track metadata immediately so UI isn't stuck at 0
      setDuration(track.duration > 0 ? track.duration : 0);

      if (reqId !== reqIdRef.current) return;

      let uri: string;
      if (track.localUri) {
        uri = track.localUri;
      } else {
        // Use the server-side audio-stream proxy so the mobile never touches
        // IP-bound YouTube HLS URLs directly.
        const isDeezer = track.id.startsWith('dz_');
        const params = new URLSearchParams();
        if (isDeezer) {
          params.set('artist', track.artist);
          params.set('title', track.title);
        }
        const qs = params.toString() ? `?${params}` : '';
        uri = `${getApiBase()}/tracks/${track.id}/audio-stream${qs}`;
      }

      if (reqId !== reqIdRef.current) return;

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, progressUpdateIntervalMillis: 500 },
        (status) => {
          if (reqId !== reqIdRef.current) return;
          if (!status.isLoaded) return;
          setIsPlaying(status.isPlaying);
          setPosition(status.positionMillis / 1000);
          // Only override duration if expo-av reports a valid value;
          // otherwise keep the track-metadata seed set above.
          if (status.durationMillis && status.durationMillis > 0) {
            setDuration(status.durationMillis / 1000);
          }
          if (status.didJustFinish) {
            setIsPlaying(false);
            setPosition(0);
          }
        },
      );

      if (reqId !== reqIdRef.current) {
        sound.unloadAsync().catch(() => {});
        return;
      }

      soundRef.current = sound;
      setCurrentTrack(track);
      setIsPlaying(true);
    } catch (e) {
      console.error('Player error:', e);
    } finally {
      if (reqId === reqIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  const pause = useCallback(async () => {
    await soundRef.current?.pauseAsync().catch(() => {});
    setIsPlaying(false);
  }, []);

  const resume = useCallback(async () => {
    await soundRef.current?.playAsync().catch(() => {});
    setIsPlaying(true);
  }, []);

  const seek = useCallback(async (pos: number) => {
    await soundRef.current?.setPositionAsync(pos * 1000).catch(() => {});
    setPosition(pos);
  }, []);

  return (
    <PlayerContext.Provider
      value={{ currentTrack, isPlaying, isLoading, position, duration, showFullPlayer, play, pause, resume, stop, seek, openFullPlayer, closeFullPlayer }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
