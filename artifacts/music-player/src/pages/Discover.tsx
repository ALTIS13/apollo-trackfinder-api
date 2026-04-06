import { useState, useEffect } from "react";
import { TrackCard } from "@/components/TrackCard";
import { Sparkles, Music2, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { TrackResult } from "@workspace/api-client-react";
import { getClientSessionId } from "@/lib/client-session";

export default function Discover() {
  const [recommendations, setRecommendations] = useState<TrackResult[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sessionId = getClientSessionId();
    const url = `${import.meta.env.BASE_URL}api/tracks/recommendations?sessionId=${encodeURIComponent(sessionId)}&limit=20`;
    setIsLoading(true);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Не удалось загрузить рекомендации");
        return r.json();
      })
      .then((data) => {
        setRecommendations(data.results ?? []);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 pb-32">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500/30 to-pink-500/30 flex items-center justify-center border border-white/10">
          <Sparkles className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Рекомендации</h1>
          <p className="text-white/40 text-sm">На основе вашей истории прослушиваний</p>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {isLoading && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center gap-4 py-24"
          >
            <Loader2 className="w-8 h-8 text-white/30 animate-spin" />
            <p className="text-white/30 text-sm">Подбираем треки…</p>
          </motion.div>
        )}

        {!isLoading && error && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-24 glass-card rounded-3xl"
          >
            <Music2 className="w-12 h-12 text-white/20 mx-auto mb-4" />
            <p className="text-white/50">{error}</p>
          </motion.div>
        )}

        {!isLoading && !error && recommendations.length === 0 && (
          <motion.div
            key="empty"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-24"
          >
            <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-5">
              <Music2 className="w-10 h-10 text-white/20" />
            </div>
            <h2 className="text-xl font-semibold text-white/50 mb-2">Пока нет рекомендаций</h2>
            <p className="text-white/25 text-sm max-w-xs mx-auto">
              Послушайте несколько треков через поиск, и мы начнём подбирать музыку специально для вас.
            </p>
          </motion.div>
        )}

        {!isLoading && !error && recommendations.length > 0 && (
          <motion.div
            key="results"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            {recommendations.map((track, i) => (
              <TrackCard key={`${track.id}-${i}`} track={track} index={i} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
