import { useState } from "react";
import { Play, Pause, Download, Music, Loader2, ListPlus } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { usePlayer } from "@/hooks/use-player";
import { getGetTrackDownloadQueryOptions } from "@workspace/api-client-react";
import type { TrackResult } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { tfRequestInit } from "@/lib/tf-session-client";

interface TrackCardProps {
  track: TrackResult;
  index: number;
}

export function TrackCard({ track, index }: TrackCardProps) {
  const { currentTrack, isPlaying, playTrack, togglePlayPause, isLoading, addToQueue } = usePlayer();
  const [isDownloading, setIsDownloading] = useState(false);
  const [queueAdded, setQueueAdded] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isCurrentTrack = currentTrack?.id === track.id;
  const isThisLoading = isCurrentTrack && isLoading;
  const isThisPlaying = isCurrentTrack && isPlaying;

  const handlePlayClick = () => {
    if (isCurrentTrack) {
      togglePlayPause();
    } else {
      playTrack(track);
    }
  };

  const handleAddToQueue = (e: React.MouseEvent) => {
    e.stopPropagation();
    addToQueue(track);
    setQueueAdded(true);
    setTimeout(() => setQueueAdded(false), 1500);
    toast({ title: "Добавлено в очередь", description: track.title });
  };

  const handleDownload = async () => {
    try {
      setIsDownloading(true);
      const res = await queryClient.fetchQuery(getGetTrackDownloadQueryOptions(track.id, {
        request: tfRequestInit({ method: "GET" }),
      }));
      if (!res.downloadUrl) throw new Error("No download URL returned");
      const a = document.createElement("a");
      a.href = res.downloadUrl;
      a.download = res.filename || `${track.artist} - ${track.title}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast({ title: "Загрузка начата", description: `Скачиваем ${track.title}...` });
    } catch (err) {
      console.error("Download failed:", err);
      toast({ title: "Ошибка загрузки", description: "Не удалось получить ссылку для скачивания.", variant: "destructive" });
    } finally {
      setIsDownloading(false);
    }
  };

  type TypeVariant = "original" | "remix" | "live" | "cover" | "outline";
  type SourceVariant = "youtube" | "soundcloud" | "default";

  const getVariant = (type: string): TypeVariant => {
    const map: Record<string, TypeVariant> = {
      original: "original", remix: "remix", live: "live", cover: "cover",
    };
    return map[type] ?? "outline";
  };

  const getSourceVariant = (source: string): SourceVariant => {
    if (source === "youtube") return "youtube";
    if (source === "soundcloud") return "soundcloud";
    return "default";
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className={`
        glass-card rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6 group
        hover:bg-card/90 hover:border-white/10 hover:-translate-y-1
        ${isCurrentTrack ? "ring-2 ring-primary/50 bg-card/90" : ""}
      `}
    >
      {/* Thumbnail + Play Overlay */}
      <div
        className="relative w-full sm:w-20 h-48 sm:h-20 rounded-xl overflow-hidden bg-secondary flex-shrink-0 cursor-pointer shadow-lg group-hover:shadow-primary/10 transition-all"
        onClick={handlePlayClick}
      >
        {track.thumbnailUrl ? (
          <img
            src={track.thumbnailUrl}
            alt={track.title}
            className={`w-full h-full object-cover transition-transform duration-500 ${isThisPlaying ? "scale-110" : "group-hover:scale-105"}`}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-secondary/80">
            <Music className="w-8 h-8 text-muted-foreground/50" />
          </div>
        )}
        <div
          className={`absolute inset-0 bg-black/40 flex items-center justify-center backdrop-blur-[2px] transition-opacity duration-300 ${isCurrentTrack || isThisLoading ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        >
          <div
            className={`w-12 h-12 sm:w-10 sm:h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg transform transition-transform duration-200 ${isCurrentTrack ? "scale-100" : "scale-90 group-hover:scale-100"}`}
          >
            {isThisLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : isThisPlaying ? (
              <Pause className="w-5 h-5 fill-current" />
            ) : (
              <Play className="w-5 h-5 fill-current ml-1" />
            )}
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="flex-grow min-w-0 w-full">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-foreground truncate group-hover:text-primary transition-colors">
              {track.title}
            </h3>
            <p className="text-muted-foreground flex items-center gap-2 mt-1">
              <span className="truncate">{track.artist}</span>
              <span className="w-1 h-1 rounded-full bg-muted-foreground/30 inline-block" />
              <span className="font-mono text-sm tracking-wide">{formatDuration(track.duration)}</span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <Badge variant={getVariant(track.type)} className="capitalize px-3 py-1">
              {track.type}
            </Badge>
            <Badge variant={getSourceVariant(track.source)} className="uppercase text-[10px] tracking-wider px-2">
              {track.source}
            </Badge>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex-shrink-0 w-full sm:w-auto flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2 border-t sm:border-t-0 sm:border-l border-white/10 pt-4 sm:pt-0 sm:pl-6">
        <button
          onClick={handleAddToQueue}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all border ${
            queueAdded
              ? "bg-primary/20 text-primary border-primary/30"
              : "bg-secondary/50 text-foreground hover:bg-secondary border-white/5 hover:text-primary"
          }`}
          title="Добавить в очередь"
        >
          <ListPlus className="w-4 h-4" />
          <span className="sm:hidden">{queueAdded ? "✓ В очереди" : "В очередь"}</span>
          <span className="hidden sm:inline">{queueAdded ? "✓" : "+"}</span>
        </button>

        <button
          onClick={handleDownload}
          disabled={isDownloading}
          className="flex items-center gap-2 px-4 py-2 sm:p-3 rounded-xl bg-secondary/50 text-foreground hover:bg-secondary hover:text-primary hover:shadow-lg transition-all disabled:opacity-50 group/dl border border-white/5 w-full sm:w-auto justify-center"
          title="Скачать"
        >
          {isDownloading ? (
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          ) : (
            <Download className="w-5 h-5 group-hover/dl:-translate-y-0.5 transition-transform" />
          )}
          <span className="sm:hidden font-medium">Скачать</span>
        </button>
      </div>
    </motion.div>
  );
}
