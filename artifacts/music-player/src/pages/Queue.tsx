import { usePlayer } from "@/hooks/use-player";
import { formatDuration } from "@/lib/utils";
import { Music2, ListMusic, X, Play, Trash2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export default function Queue() {
  const { queue, queueIndex, currentTrack, playFromQueue, removeFromQueue, clearQueue } = usePlayer();

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 pb-32">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/8 flex items-center justify-center">
            <ListMusic className="w-5 h-5 text-white/60" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Очередь</h1>
            <p className="text-white/40 text-sm">{queue.length} {queue.length === 1 ? "трек" : queue.length < 5 ? "трека" : "треков"}</p>
          </div>
        </div>
        {queue.length > 0 && (
          <button
            onClick={clearQueue}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-red-500/10 text-white/40 hover:text-red-400 transition-all text-sm"
          >
            <Trash2 className="w-4 h-4" />
            Очистить
          </button>
        )}
      </div>

      {queue.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center py-24"
        >
          <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-5">
            <ListMusic className="w-10 h-10 text-white/20" />
          </div>
          <h2 className="text-xl font-semibold text-white/50 mb-2">Очередь пуста</h2>
          <p className="text-white/25 text-sm max-w-xs mx-auto">
            Добавляйте треки в очередь из поиска, нажимая кнопку&nbsp;
            <span className="text-white/40 font-mono">+</span>
          </p>
        </motion.div>
      ) : (
        <div className="space-y-1">
          <AnimatePresence>
            {queue.map((track, i) => {
              const isCurrent = i === queueIndex && currentTrack?.id === track.id;
              return (
                <motion.div
                  key={`${track.id}-${i}`}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12, height: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className={`group flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all ${
                    isCurrent ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                  onClick={() => playFromQueue(i)}
                >
                  <span className={`w-6 text-center text-xs shrink-0 ${isCurrent ? "text-primary" : "text-white/25"}`}>
                    {isCurrent ? <Play className="w-3 h-3 fill-current inline" /> : i + 1}
                  </span>

                  <div className="w-10 h-10 rounded-lg overflow-hidden bg-white/8 flex-shrink-0">
                    {track.thumbnailUrl ? (
                      <img src={track.thumbnailUrl} alt={track.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music2 className="w-4 h-4 text-white/25" />
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isCurrent ? "text-white" : "text-white/80"}`}>
                      {track.title}
                    </p>
                    <p className="text-xs text-white/40 truncate">{track.artist}</p>
                  </div>

                  <span className="text-xs text-white/25 font-mono shrink-0 hidden sm:block">
                    {formatDuration(track.duration)}
                  </span>

                  <button
                    onClick={(e) => { e.stopPropagation(); removeFromQueue(i); }}
                    className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all shrink-0 p-1"
                    title="Удалить из очереди"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
