import { createContext, useContext, useState, useRef, useEffect, ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetTrackStreamQueryOptions } from "@workspace/api-client-react";
import type { TrackResult } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

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

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<TrackResult | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

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

  const playTrack = async (track: TrackResult) => {
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

      // Reset audio element
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
  };

  const togglePlayPause = () => {
    if (!audioRef.current || !currentTrack) return;
    
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      // If we pause and resume, it might fail if the URL expired, but let's assume it's fine for short pauses
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
  };

  const seekTo = (percentage: number) => {
    if (!audioRef.current || !duration) return;
    const time = (percentage / 100) * duration;
    audioRef.current.currentTime = time;
    setProgress(time);
  };

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
