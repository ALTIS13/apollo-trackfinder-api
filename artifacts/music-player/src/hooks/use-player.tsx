import { createContext, useContext, useState, useRef, useEffect, useCallback, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetTrackStreamQueryOptions } from "@workspace/api-client-react";
import type { TrackResult, TrackSource, TrackType } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { getClientSessionId } from "@/lib/client-session";

interface PlayerContextType {
  currentTrack: TrackResult | null;
  isPlaying: boolean;
  isLoading: boolean;
  progress: number;
  duration: number;
  playTrack: (track: TrackResult) => Promise<void>;
  togglePlayPause: () => void;
  seekTo: (percentage: number) => void;
}

interface PlayerSyncState {
  type: "player_state";
  track: {
    id: string;
    title: string;
    artist: string;
    thumbnailUrl: string | null;
    duration: number;
    source?: string;
  } | null;
  position: number;
  isPlaying: boolean;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30000;

function getWsUrl(): string {
  const sessionId = encodeURIComponent(getClientSessionId());
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws?sessionId=${sessionId}`;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<TrackResult | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const currentTrackRef = useRef<TrackResult | null>(null);
  const isPlayingRef = useRef(false);
  const progressRef = useRef(0);
  const applyingRemoteRef = useRef(false);
  // Stable ref for playTrack — always points to the latest version (avoids stale closure in WS handler)
  const playTrackRef = useRef<(track: TrackResult) => Promise<void>>(async () => {});

  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { progressRef.current = progress; }, [progress]);

  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.volume = 0.8;

    const audio = audioRef.current;

    const handleTimeUpdate = () => {
      setProgress(audio.currentTime);
    };

    const handleDurationChange = () => {
      setDuration(audio.duration);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
    };

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.pause();
      audio.src = "";
    };
  }, []);

  useEffect(() => {
    if (!currentTrack) return;
    fetch(`${import.meta.env.BASE_URL}api/tracks/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackId: currentTrack.id,
        artist: currentTrack.artist,
        title: currentTrack.title,
        sessionId: getClientSessionId(),
      }),
    }).catch(() => {});
  }, [currentTrack?.id]);

  const playTrack = useCallback(async (track: TrackResult) => {
    if (!audioRef.current) return;

    if (currentTrack?.id === track.id) {
      togglePlayPause();
      return;
    }

    try {
      setIsLoading(true);
      setCurrentTrack(track);
      setIsPlaying(false);
      setProgress(0);
      setDuration(track.duration || 0);

      audioRef.current.pause();
      audioRef.current.src = "";

      const res = await queryClient.fetchQuery(getGetTrackStreamQueryOptions(track.id));

      if (!res.streamUrl) {
        throw new Error("Stream URL not provided by server");
      }

      audioRef.current.src = res.streamUrl;
      await audioRef.current.play();
      setIsPlaying(true);
    } catch (err) {
      console.error("Failed to play track:", err);
      setCurrentTrack(null);
      setIsPlaying(false);
      toast({
        title: "Playback Error",
        description: "Could not load the audio stream for this track.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, queryClient, toast]);

  // Keep stable ref for use in WS handler (avoids stale closures)
  playTrackRef.current = playTrack;

  const togglePlayPause = useCallback(() => {
    if (!audioRef.current || !currentTrackRef.current) return;

    if (isPlayingRef.current) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(err => {
        console.error("Resume failed:", err);
        toast({
          title: "Playback Error",
          description: "Stream might have expired. Try playing from the list again.",
          variant: "destructive",
        });
        setIsPlaying(false);
      });
    }
  }, [toast]);

  const seekTo = useCallback((percentage: number) => {
    if (!audioRef.current || !duration) return;
    const time = (percentage / 100) * duration;
    audioRef.current.currentTime = time;
    setProgress(time);
  }, [duration]);

  // ── WebSocket sync ───────────────────────────────────────────────────────────

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_DELAY_MS);
  const mountedRef = useRef(true);
  // Suppress outgoing WS messages while applying a remote track (time-based guard for async ops)
  const suppressSendUntilRef = useRef<number>(0);

  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING || wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectDelayRef.current = RECONNECT_DELAY_MS;
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as PlayerSyncState;
          if (msg.type !== "player_state") return;
          if (!msg.track) return;

          const local = currentTrackRef.current;

          if (local?.id !== msg.track.id) {
            // Different (or no) track — load and start playing the remote track.
            // Suppress outgoing sends for 10s to avoid echoing back intermediate states
            // while the stream resolves and playback begins.
            suppressSendUntilRef.current = Date.now() + 10_000;

            const validSources = ["youtube", "soundcloud"];
            const remoteTrack: TrackResult = {
              id: msg.track.id,
              title: msg.track.title,
              artist: msg.track.artist,
              thumbnailUrl: msg.track.thumbnailUrl ?? null,
              duration: msg.track.duration,
              source: (validSources.includes(msg.track.source ?? "")
                ? msg.track.source
                : "youtube") as TrackSource,
              type: "original" as TrackType,
              quality: [],
              score: 0,
            };
            // Fire-and-forget: always use ref to get the latest playTrack (avoids stale closure)
            playTrackRef.current(remoteTrack).catch(() => {});
            return;
          }

          // Same track — sync play/pause and position
          applyingRemoteRef.current = true;
          try {
            if (msg.isPlaying && !isPlayingRef.current) {
              audioRef.current?.play().catch(() => {});
            } else if (!msg.isPlaying && isPlayingRef.current) {
              audioRef.current?.pause();
            }

            // Sync position if drift > 5s
            const drift = Math.abs(progressRef.current - msg.position);
            if (drift > 5 && audioRef.current) {
              audioRef.current.currentTime = msg.position;
              setProgress(msg.position);
            }
          } finally {
            applyingRemoteRef.current = false;
          }
        } catch {}
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!mountedRef.current) return;
        const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY_MS);
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimerRef.current = setTimeout(connectWs, delay);
      };

      ws.onerror = () => { ws.close(); };
    } catch {
      const delay = Math.min(reconnectDelayRef.current, MAX_RECONNECT_DELAY_MS);
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimerRef.current = setTimeout(connectWs, delay);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connectWs();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connectWs]);

  // Send state when track or play/pause changes
  const sendWsState = useCallback((overrides?: Partial<PlayerSyncState>) => {
    if (applyingRemoteRef.current) return;
    if (Date.now() < suppressSendUntilRef.current) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const track = currentTrackRef.current;
    const msg: PlayerSyncState = {
      type: "player_state",
      track: track
        ? {
            id: track.id,
            title: track.title,
            artist: track.artist,
            thumbnailUrl: track.thumbnailUrl ?? null,
            duration: track.duration ?? 0,
            source: track.source,
          }
        : null,
      position: progressRef.current,
      isPlaying: isPlayingRef.current,
      ...overrides,
    };
    try { ws.send(JSON.stringify(msg)); } catch {}
  }, []);

  useEffect(() => {
    sendWsState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack?.id, isPlaying]);

  return (
    <PlayerContext.Provider
      value={{
        currentTrack,
        isPlaying,
        isLoading,
        progress,
        duration,
        playTrack,
        togglePlayPause,
        seekTo,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const context = useContext(PlayerContext);
  if (context === undefined) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
}
