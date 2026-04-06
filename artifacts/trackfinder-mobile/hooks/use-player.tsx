import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { showToast } from '@/components/Toast';
import { getLibraryLocalUri } from '@/hooks/use-library';
import { getApiBase, getSessionId } from '@/hooks/use-session';
import { getOfflineMode } from '@/hooks/use-settings';
import { usePlayerSync, type PlayerSyncState } from '@/hooks/use-sync';

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

export type RepeatMode = 'none' | 'one' | 'all';

interface PlayerState {
  currentTrack: PlayerTrack | null;
  isPlaying: boolean;
  isLoading: boolean;
  position: number;
  duration: number;
  showFullPlayer: boolean;
  queue: PlayerTrack[];
  queueIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
  play: (track: PlayerTrack) => Promise<void>;
  playQueue: (tracks: PlayerTrack[], startIndex?: number) => Promise<void>;
  playNext: () => Promise<void>;
  playPrev: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  seek: (pos: number) => Promise<void>;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  openFullPlayer: () => void;
  closeFullPlayer: () => void;
}

const PlayerContext = createContext<PlayerState | null>(null);

function buildUri(track: PlayerTrack): string {
  const isDeezer = track.id.startsWith('dz_');
  const params = new URLSearchParams();
  if (isDeezer) {
    params.set('artist', track.artist);
    params.set('title', track.title);
  }
  const qs = params.toString() ? `?${params}` : '';
  return `${getApiBase()}/tracks/${track.id}/audio-stream${qs}`;
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showFullPlayer, setShowFullPlayer] = useState(false);

  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('none');

  const soundRef = useRef<Audio.Sound | null>(null);
  const reqIdRef = useRef(0);

  // Refs for values needed inside status callbacks (avoids stale closures)
  const queueRef = useRef<PlayerTrack[]>([]);
  const queueIndexRef = useRef(0);
  const shuffleRef = useRef(false);
  const repeatRef = useRef<RepeatMode>('none');
  const positionRef = useRef(0);
  const currentTrackRef = useRef<PlayerTrack | null>(null);
  const isPlayingRef = useRef(false);

  // Guard flag: true while applying a remote WS state (prevents send loop)
  const applyingRemoteRef = useRef(false);

  // Smart shuffle: recently played IDs (last N) for exclusion when shuffling
  const recentlyPlayedRef = useRef<string[]>([]);
  const RECENT_HISTORY_SIZE = 10;

  // Guard: prevent concurrent/duplicate recommendation fetches
  const fetchingRecsRef = useRef(false);

  // Ref to break circular dep: _playTrackInner → status callback → advance → _playTrackInner
  const playTrackInnerRef = useRef<(track: PlayerTrack, reqId: number) => Promise<void>>(
    async () => {},
  );

  /** Pick a shuffle index that avoids recently played tracks (smart shuffle). */
  function smartShuffleNext(q: PlayerTrack[], currentIdx: number): number {
    if (q.length <= 1) return 0;
    const recent = recentlyPlayedRef.current;
    // Prefer tracks not in recently played and not current
    const candidates = q
      .map((t, i) => i)
      .filter((i) => i !== currentIdx && !recent.includes(q[i].id));
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    // All played — reset history (except current) and pick any other
    recentlyPlayedRef.current = [];
    let nextIdx: number;
    do { nextIdx = Math.floor(Math.random() * q.length); } while (nextIdx === currentIdx);
    return nextIdx;
  }

  /** Record a track as recently played (capped at RECENT_HISTORY_SIZE). */
  function recordRecentlyPlayed(trackId: string) {
    const list = recentlyPlayedRef.current;
    if (list[list.length - 1] === trackId) return;
    list.push(trackId);
    if (list.length > RECENT_HISTORY_SIZE) list.shift();
  }

  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { queueIndexRef.current = queueIndex; }, [queueIndex]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  useEffect(() => {
    if (!currentTrack) return;
    const sessionId = getSessionId();
    fetch(`${getApiBase()}/tracks/play`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Session': sessionId,
      },
      body: JSON.stringify({
        trackId: currentTrack.id,
        artist: currentTrack.artist,
        title: currentTrack.title,
        sessionId,
      }),
    }).catch(() => {});
  }, [currentTrack?.id]);

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

  // Internal play implementation — stable via ref
  const _playTrackInner = async (track: PlayerTrack, reqId: number) => {
    try {
      const resolvedLocalUri = track.localUri || getLibraryLocalUri(track.id);
      const localUriValid = resolvedLocalUri
        ? await FileSystem.getInfoAsync(resolvedLocalUri)
            .then((info) => info.exists && ((info as { size?: number }).size ?? 0) > 0)
            .catch(() => false)
        : false;

      if (!localUriValid && getOfflineMode()) {
        showToast(`«${track.title}» не скачан — оффлайн-режим`);
        return;
      }

      setIsLoading(true);

      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
      setIsPlaying(false);
      setPosition(0);
      setDuration(track.duration > 0 ? track.duration : 0);

      if (reqId !== reqIdRef.current) return;

      const uri = localUriValid ? resolvedLocalUri! : buildUri(track);

      if (reqId !== reqIdRef.current) return;

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, progressUpdateIntervalMillis: 250 },
        (status) => {
          if (reqId !== reqIdRef.current) return;
          if (!status.isLoaded) return;
          setIsPlaying(status.isPlaying);
          setPosition(status.positionMillis / 1000);
          if (status.durationMillis && status.durationMillis > 0) {
            setDuration(status.durationMillis / 1000);
          }
          if (status.didJustFinish) {
            setIsPlaying(false);
            setPosition(0);
            // Auto-advance — all data from refs, no stale closures
            const q = queueRef.current;
            const idx = queueIndexRef.current;
            const rep = repeatRef.current;
            const shuf = shuffleRef.current;

            if (rep === 'one') {
              const newId = ++reqIdRef.current;
              playTrackInnerRef.current(q[idx], newId);
              return;
            }

            let nextIdx: number;
            if (shuf && q.length > 1) {
              nextIdx = smartShuffleNext(q, idx);
            } else {
              nextIdx = idx + 1;
            }

            if (nextIdx >= q.length) {
              if (rep === 'all') {
                nextIdx = 0;
              } else {
                // End of queue — fetch recommendations once (guarded against duplicate calls)
                if (fetchingRecsRef.current) return;
                fetchingRecsRef.current = true;
                const sessionId = getSessionId();
                fetch(`${getApiBase()}/tracks/recommendations?sessionId=${sessionId}&limit=10`)
                  .then((r) => r.json())
                  .then((data: { results?: PlayerTrack[] }) => {
                    fetchingRecsRef.current = false;
                    const recs: PlayerTrack[] = (data.results ?? []).map((r) => ({
                      id: r.id,
                      title: r.title,
                      artist: r.artist,
                      thumbnailUrl: r.thumbnailUrl ?? null,
                      duration: r.duration ?? 0,
                      source: (r as { source?: string }).source,
                      type: (r as { type?: string }).type,
                    }));
                    if (recs.length === 0) return;
                    // Dedupe: skip tracks already in queue
                    const existingIds = new Set(queueRef.current.map((t) => t.id));
                    const newRecs = recs.filter((r) => !existingIds.has(r.id));
                    if (newRecs.length === 0) return;
                    const newQueue = [...queueRef.current, ...newRecs];
                    queueRef.current = newQueue;
                    setQueue(newQueue);
                    const autoIdx = queueIndexRef.current + 1;
                    queueIndexRef.current = autoIdx;
                    setQueueIndex(autoIdx);
                    const newId = ++reqIdRef.current;
                    playTrackInnerRef.current(newQueue[autoIdx], newId);
                  })
                  .catch(() => {
                    fetchingRecsRef.current = false;
                  });
                return;
              }
            }

            queueIndexRef.current = nextIdx;
            setQueueIndex(nextIdx);
            const newId = ++reqIdRef.current;
            playTrackInnerRef.current(q[nextIdx], newId);
          }
        },
      );

      if (reqId !== reqIdRef.current) {
        sound.unloadAsync().catch(() => {});
        return;
      }

      soundRef.current = sound;
      recordRecentlyPlayed(track.id);
      setCurrentTrack(track);
      setIsPlaying(true);
    } catch (e) {
      console.error('Player error:', e);
    } finally {
      if (reqId === reqIdRef.current) setIsLoading(false);
    }
  };

  // Keep ref up to date so status callbacks always call the latest version
  playTrackInnerRef.current = _playTrackInner;

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
    setQueue([]);
    setQueueIndex(0);
    queueRef.current = [];
    queueIndexRef.current = 0;
  }, []);

  const play = useCallback(async (track: PlayerTrack) => {
    const reqId = ++reqIdRef.current;
    // Reset recently played on fresh queue start
    recentlyPlayedRef.current = [];
    setQueue([track]);
    setQueueIndex(0);
    queueRef.current = [track];
    queueIndexRef.current = 0;
    await playTrackInnerRef.current(track, reqId);
  }, []);

  const playQueue = useCallback(async (tracks: PlayerTrack[], startIndex = 0) => {
    if (tracks.length === 0) return;
    const idx = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const reqId = ++reqIdRef.current;
    // Reset recently played on new queue
    recentlyPlayedRef.current = [];
    setQueue(tracks);
    setQueueIndex(idx);
    queueRef.current = tracks;
    queueIndexRef.current = idx;
    await playTrackInnerRef.current(tracks[idx], reqId);
  }, []);

  const playNext = useCallback(async () => {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    if (q.length === 0) return;

    let nextIdx: number;
    if (shuffleRef.current && q.length > 1) {
      nextIdx = smartShuffleNext(q, idx);
    } else {
      nextIdx = (idx + 1) % q.length;
    }

    queueIndexRef.current = nextIdx;
    setQueueIndex(nextIdx);
    const reqId = ++reqIdRef.current;
    await playTrackInnerRef.current(q[nextIdx], reqId);
  }, []);

  const playPrev = useCallback(async () => {
    const q = queueRef.current;
    const idx = queueIndexRef.current;
    if (q.length === 0) return;

    // Restart if >3s into track, else go to prev
    if (positionRef.current > 3) {
      await soundRef.current?.setPositionAsync(0).catch(() => {});
      setPosition(0);
      return;
    }

    const prevIdx = (idx - 1 + q.length) % q.length;
    queueIndexRef.current = prevIdx;
    setQueueIndex(prevIdx);
    const reqId = ++reqIdRef.current;
    await playTrackInnerRef.current(q[prevIdx], reqId);
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

  const toggleShuffle = useCallback(() => {
    setShuffle((s) => {
      shuffleRef.current = !s;
      return !s;
    });
  }, []);

  const cycleRepeat = useCallback(() => {
    setRepeat((r) => {
      const next: RepeatMode = r === 'none' ? 'all' : r === 'all' ? 'one' : 'none';
      repeatRef.current = next;
      return next;
    });
  }, []);

  // ── WS sync ─────────────────────────────────────────────────────────────────

  // Debounce position updates: send at most once per second
  const positionSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRemoteState = useCallback((state: PlayerSyncState) => {
    if (applyingRemoteRef.current) return;
    applyingRemoteRef.current = true;
    try {
      const track = state.track;
      if (!track) {
        // Remote stopped — do nothing (don't auto-stop local playback)
        return;
      }

      const local = currentTrackRef.current;
      if (local?.id !== track.id) {
        // Different track → start playing the new one, then apply remote position/isPlaying
        const reqId = ++reqIdRef.current;
        const newTrack: PlayerTrack = {
          id: track.id,
          title: track.title,
          artist: track.artist,
          thumbnailUrl: track.thumbnailUrl,
          duration: track.duration,
          source: track.source,
        };
        setQueue([newTrack]);
        setQueueIndex(0);
        queueRef.current = [newTrack];
        queueIndexRef.current = 0;
        const targetPosition = state.position;
        const targetIsPlaying = state.isPlaying;
        playTrackInnerRef.current(newTrack, reqId).then(() => {
          if (reqId !== reqIdRef.current) return; // superseded
          // Seek to the remote position if > 1s
          if (targetPosition > 1) {
            soundRef.current?.setPositionAsync(targetPosition * 1000).catch(() => {});
            setPosition(targetPosition);
          }
          // If remote is paused, pause locally (playTrackInner always starts playing)
          if (!targetIsPlaying) {
            soundRef.current?.pauseAsync().catch(() => {});
            setIsPlaying(false);
          }
        }).catch(() => {});
        return;
      }

      // Same track — sync play/pause
      if (state.isPlaying && !isPlayingRef.current) {
        soundRef.current?.playAsync().catch(() => {});
        setIsPlaying(true);
      } else if (!state.isPlaying && isPlayingRef.current) {
        soundRef.current?.pauseAsync().catch(() => {});
        setIsPlaying(false);
      }

      // Sync position if drift > 5s
      const drift = Math.abs(positionRef.current - state.position);
      if (drift > 5) {
        soundRef.current?.setPositionAsync(state.position * 1000).catch(() => {});
        setPosition(state.position);
      }
    } finally {
      applyingRemoteRef.current = false;
    }
  }, []);

  const { sendState } = usePlayerSync({ onRemoteState: handleRemoteState });

  // Send state when track or play/pause changes
  useEffect(() => {
    if (applyingRemoteRef.current) return;
    sendState({
      track: currentTrack
        ? {
            id: currentTrack.id,
            title: currentTrack.title,
            artist: currentTrack.artist,
            thumbnailUrl: currentTrack.thumbnailUrl,
            duration: currentTrack.duration,
            source: currentTrack.source,
          }
        : null,
      position: positionRef.current,
      isPlaying,
    });
  }, [currentTrack?.id, isPlaying, sendState]);

  // Send position updates debounced (1s) — fires even when paused so seeks sync correctly
  useEffect(() => {
    if (applyingRemoteRef.current) return;
    if (!currentTrack) return;
    if (positionSendTimerRef.current) clearTimeout(positionSendTimerRef.current);
    positionSendTimerRef.current = setTimeout(() => {
      sendState({
        track: currentTrackRef.current
          ? {
              id: currentTrackRef.current.id,
              title: currentTrackRef.current.title,
              artist: currentTrackRef.current.artist,
              thumbnailUrl: currentTrackRef.current.thumbnailUrl,
              duration: currentTrackRef.current.duration,
              source: currentTrackRef.current.source,
            }
          : null,
        position: positionRef.current,
        isPlaying: isPlayingRef.current,
      });
    }, 1000);
  }, [position, currentTrack?.id, isPlaying, sendState]);

  return (
    <PlayerContext.Provider
      value={{
        currentTrack, isPlaying, isLoading, position, duration, showFullPlayer,
        queue, queueIndex, shuffle, repeat,
        play, playQueue, playNext, playPrev,
        pause, resume, stop, seek,
        toggleShuffle, cycleRepeat,
        openFullPlayer, closeFullPlayer,
      }}
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
