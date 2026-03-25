import { usePlayer } from "@/hooks/use-player";
import { formatDuration } from "@/lib/utils";
import { Play, Pause, SkipBack, SkipForward, Volume2, Music, Loader2 } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export function Player() {
  const { currentTrack, isPlaying, isLoading, progress, duration, togglePlayPause, seekTo } = usePlayer();
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    seekTo(percentage);
  };

  const handleDragStart = () => setIsDragging(true);
  const handleDragEnd = () => setIsDragging(false);
  const handleDrag = (e: MouseEvent) => {
    if (!progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    seekTo(percentage);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleDrag);
      window.addEventListener("mouseup", handleDragEnd);
      return () => {
        window.removeEventListener("mousemove", handleDrag);
        window.removeEventListener("mouseup", handleDragEnd);
      };
    }
    return undefined;
  }, [isDragging]);

  if (!currentTrack) return null;

  const progressPercentage = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 glass-panel animate-in slide-in-from-bottom-full duration-500">
      {/* Top thin progress bar */}
      <div
        ref={progressBarRef}
        className="h-1.5 bg-secondary/50 cursor-pointer group relative"
        onMouseDown={(e) => {
          handleProgressClick(e);
          handleDragStart();
        }}
      >
        <div
          className="absolute top-0 left-0 h-full bg-primary z-10 transition-all duration-100 ease-linear"
          style={{ width: `${progressPercentage}%` }}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity translate-x-1/2 shadow-lg scale-0 group-hover:scale-100" />
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 h-20 flex items-center justify-between gap-4">
        {/* Track Info */}
        <div className="flex items-center gap-4 w-1/3 min-w-[200px]">
          <div className="w-14 h-14 rounded-lg overflow-hidden bg-secondary flex-shrink-0 relative shadow-md shadow-black/20">
            {currentTrack.thumbnailUrl ? (
              <img
                src={currentTrack.thumbnailUrl}
                alt={currentTrack.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-secondary/80">
                <Music className="w-6 h-6 text-muted-foreground" />
              </div>
            )}
            {isLoading && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center backdrop-blur-[2px]">
                <Loader2 className="w-6 h-6 text-white animate-spin" />
              </div>
            )}
          </div>
          <div className="flex flex-col truncate">
            <h4 className="text-sm font-bold text-foreground truncate">{currentTrack.title}</h4>
            <p className="text-xs text-muted-foreground truncate">{currentTrack.artist}</p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-col items-center justify-center w-1/3 flex-shrink-0">
          <div className="flex items-center gap-6">
            <button className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
              <SkipBack className="w-5 h-5 fill-current" />
            </button>
            <button
              onClick={togglePlayPause}
              disabled={isLoading}
              className="w-12 h-12 flex items-center justify-center bg-primary text-primary-foreground rounded-full hover:scale-105 hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/25 active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : isPlaying ? (
                <Pause className="w-5 h-5 fill-current" />
              ) : (
                <Play className="w-5 h-5 fill-current ml-1" />
              )}
            </button>
            <button className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
              <SkipForward className="w-5 h-5 fill-current" />
            </button>
          </div>
        </div>

        {/* Time & Extras */}
        <div className="flex items-center justify-end gap-6 w-1/3 min-w-[200px]">
          <div className="text-xs font-mono tracking-wider text-muted-foreground bg-secondary/50 px-3 py-1.5 rounded-full border border-white/5">
            {formatDuration(progress)} <span className="opacity-50 mx-1">/</span>{" "}
            {formatDuration(duration || currentTrack.duration)}
          </div>
          <button className="text-muted-foreground hover:text-foreground transition-colors hidden sm:block">
            <Volume2 className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
