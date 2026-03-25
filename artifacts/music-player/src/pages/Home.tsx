import { useState, useEffect } from "react";
import { useSearchTracks } from "@workspace/api-client-react";
import type { TrackType, TrackResult } from "@workspace/api-client-react";
import { TrackCard } from "@/components/TrackCard";
import { Search, Music2, Loader2, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type FilterType = TrackType | "all";

export default function Home() {
  const params = new URLSearchParams(window.location.search);
  const [artist, setArtist] = useState(params.get("artist") ?? "");
  const [title, setTitle] = useState(params.get("title") ?? "");
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [hasSearched, setHasSearched] = useState(false);

  const searchMutation = useSearchTracks();

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const a = p.get("artist");
    const t = p.get("title");
    if (a && t) {
      setHasSearched(true);
      searchMutation.mutate({ data: { artist: a, title: t } });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!artist.trim() || !title.trim()) return;
    
    setHasSearched(true);
    searchMutation.mutate({ data: { artist, title } });
  };

  const results = searchMutation.data?.results || [];
  
  const filteredResults = activeFilter === "all" 
    ? results 
    : results.filter(track => track.type === activeFilter);

  const filterOptions: { id: FilterType; label: string; color?: string }[] = [
    { id: "all", label: "All Types" },
    { id: "original", label: "Originals", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
    { id: "remix", label: "Remixes", color: "text-purple-400 bg-purple-400/10 border-purple-400/20" },
    { id: "live", label: "Live", color: "text-orange-400 bg-orange-400/10 border-orange-400/20" },
    { id: "cover", label: "Covers", color: "text-blue-400 bg-blue-400/10 border-blue-400/20" },
  ];

  return (
    <div className="min-h-screen pb-32">
      {/* Hero Section */}
      <div className="relative overflow-hidden border-b border-white/5 bg-black/20">
        <div className="absolute inset-0 z-0">
          <img 
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`} 
            alt="Hero background" 
            className="w-full h-full object-cover opacity-30 mix-blend-screen"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background" />
        </div>
        
        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 py-20 sm:py-32 flex flex-col items-center text-center">
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-sm font-medium text-muted-foreground mb-6 backdrop-blur-md"
          >
            <Sparkles className="w-4 h-4 text-primary" />
            Cross-Platform Music Discovery
          </motion.div>
          
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-4xl sm:text-6xl lg:text-7xl font-display font-bold text-white mb-6 tracking-tight"
          >
            Find any track. <br className="hidden sm:block" />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-accent">
              Play everywhere.
            </span>
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-lg sm:text-xl text-muted-foreground max-w-2xl mb-12"
          >
            Search YouTube and SoundCloud simultaneously. Discover originals, rare remixes, live performances, and covers instantly.
          </motion.p>

          <motion.form 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            onSubmit={handleSearch} 
            className="w-full max-w-3xl glass-card p-2 sm:p-3 rounded-2xl sm:rounded-full flex flex-col sm:flex-row gap-3"
          >
            <div className="flex-1 flex items-center bg-secondary/50 rounded-xl sm:rounded-full px-4 border border-transparent focus-within:border-primary/50 focus-within:bg-secondary transition-all h-14">
              <Music2 className="w-5 h-5 text-muted-foreground shrink-0" />
              <input 
                type="text" 
                placeholder="Artist name..." 
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                className="w-full bg-transparent border-none focus:outline-none text-foreground px-3 placeholder:text-muted-foreground h-full"
                required
              />
            </div>
            
            <div className="w-px h-8 bg-white/10 hidden sm:block self-center" />
            
            <div className="flex-1 flex items-center bg-secondary/50 rounded-xl sm:rounded-full px-4 border border-transparent focus-within:border-primary/50 focus-within:bg-secondary transition-all h-14">
              <Search className="w-5 h-5 text-muted-foreground shrink-0" />
              <input 
                type="text" 
                placeholder="Track title..." 
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-transparent border-none focus:outline-none text-foreground px-3 placeholder:text-muted-foreground h-full"
                required
              />
            </div>

            <button 
              type="submit"
              disabled={searchMutation.isPending}
              className="h-14 px-8 rounded-xl sm:rounded-full font-bold bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-primary/40 hover:-translate-y-0.5 active:translate-y-0 disabled:opacity-50 disabled:transform-none transition-all duration-200 shrink-0"
            >
              {searchMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Searching
                </span>
              ) : (
                "Search"
              )}
            </button>
          </motion.form>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        {hasSearched && (
          <div className="mb-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
            <h2 className="text-2xl font-bold text-foreground">
              {searchMutation.isPending ? "Searching..." : searchMutation.data ? "Results" : ""}
            </h2>
            
            {!searchMutation.isPending && results.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 p-1.5 glass-card rounded-2xl w-full sm:w-auto">
                {filterOptions.map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setActiveFilter(opt.id)}
                    className={`
                      px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-200
                      ${activeFilter === opt.id 
                        ? opt.color || 'bg-white text-black shadow-md' 
                        : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
                      }
                    `}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {searchMutation.isPending && (
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="glass-card rounded-2xl p-5 flex items-center gap-6 animate-pulse">
                <div className="w-20 h-20 rounded-xl bg-secondary flex-shrink-0" />
                <div className="flex-1 space-y-3">
                  <div className="h-5 bg-secondary rounded-full w-1/3" />
                  <div className="h-4 bg-secondary rounded-full w-1/4" />
                </div>
                <div className="w-12 h-12 rounded-full bg-secondary" />
              </div>
            ))}
          </div>
        )}

        {!searchMutation.isPending && searchMutation.isError && (
          <div className="text-center py-20 px-4 glass-card rounded-3xl border-destructive/20">
            <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-6">
              <Sparkles className="w-8 h-8 text-destructive" />
            </div>
            <h3 className="text-xl font-bold text-foreground mb-2">Search Failed</h3>
            <p className="text-muted-foreground">We couldn't find tracks right now. Please try again later.</p>
          </div>
        )}

        {!searchMutation.isPending && searchMutation.data && (
          <AnimatePresence mode="popLayout">
            {filteredResults.length === 0 ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="text-center py-24 px-4 glass-card rounded-3xl"
              >
                <div className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mx-auto mb-6">
                  <Music2 className="w-10 h-10 text-muted-foreground" />
                </div>
                <h3 className="text-2xl font-display font-bold text-foreground mb-3">No tracks found</h3>
                <p className="text-muted-foreground max-w-md mx-auto">
                  We couldn't find any {activeFilter !== 'all' ? activeFilter : ''} matches for your search. Try changing the filter or searching for something else.
                </p>
                {activeFilter !== 'all' && (
                  <button 
                    onClick={() => setActiveFilter('all')}
                    className="mt-6 text-primary hover:text-primary-foreground font-semibold hover:underline"
                  >
                    View all results
                  </button>
                )}
              </motion.div>
            ) : (
              <div className="space-y-4">
                {filteredResults.map((track, i) => (
                  <TrackCard key={`${track.id}-${i}`} track={track} index={i} />
                ))}
              </div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
