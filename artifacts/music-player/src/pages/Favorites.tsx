import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Music2,
  LogIn,
  LogOut,
  Search,
  ChevronLeft,
  ChevronRight,
  List,
  Heart,
  TrendingUp,
  Loader2,
  AlertCircle,
  ExternalLink,
  Play,
} from "lucide-react";
import {
  useSpotifyStatus,
  useSpotifyLogout,
  useSpotifyLiked,
  useSpotifyPlaylists,
  useSpotifyPlaylistTracks,
  useSpotifyTopTracks,
  spotifyLoginUrl,
  type SpotifyTrack,
  type SpotifyPlaylist,
} from "@/hooks/use-spotify";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useLocation as useWouterLocation } from "wouter";

type TabId = "liked" | "playlists" | "top";

const SPOTIFY_GREEN = "#1DB954";

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function ConnectPrompt() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center min-h-[60vh] gap-8 px-4"
    >
      <div
        className="w-24 h-24 rounded-full flex items-center justify-center shadow-2xl"
        style={{ background: `radial-gradient(circle at 35% 35%, #1ed760, ${SPOTIFY_GREEN})` }}
      >
        <Music2 className="w-12 h-12 text-black" />
      </div>

      <div className="text-center max-w-md">
        <h2 className="text-3xl font-bold text-white mb-3">Connect Your Spotify</h2>
        <p className="text-white/60 text-lg">
          Browse your liked songs, playlists, and top tracks — then find every version of any song you love.
        </p>
      </div>

      <a
        href={spotifyLoginUrl()}
        className="flex items-center gap-3 px-8 py-4 rounded-full font-semibold text-black text-lg shadow-xl transition-all hover:scale-105 hover:brightness-110 active:scale-95"
        style={{ background: SPOTIFY_GREEN }}
      >
        <LogIn className="w-5 h-5" />
        Connect with Spotify
      </a>

      <p className="text-white/30 text-sm text-center max-w-xs">
        We only read your music library. We never modify your Spotify account or post on your behalf.
      </p>
    </motion.div>
  );
}

function SpotifyTrackItem({
  track,
  index,
  onSearchVariants,
}: {
  track: SpotifyTrack;
  index: number;
  onSearchVariants: (track: SpotifyTrack) => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.5) }}
      className="group flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all cursor-default"
    >
      <span className="w-6 text-center text-white/30 text-sm shrink-0 group-hover:hidden">{index + 1}</span>
      <button
        className="w-6 h-6 shrink-0 hidden group-hover:flex items-center justify-center text-white/70 hover:text-white"
        onClick={() => onSearchVariants(track)}
        title="Search variants"
      >
        <Search className="w-4 h-4" />
      </button>

      {track.thumbnailUrl ? (
        <img
          src={track.thumbnailUrl}
          alt={track.album}
          className="w-10 h-10 rounded-md object-cover shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-md bg-white/10 flex items-center justify-center shrink-0">
          <Music2 className="w-5 h-5 text-white/30" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="font-medium text-white truncate text-sm">{track.title}</p>
        <p className="text-white/50 text-xs truncate">{track.artist}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-white/30 text-xs hidden sm:block">{formatDuration(track.durationMs)}</span>
        <a
          href={track.spotifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="opacity-0 group-hover:opacity-100 text-white/40 hover:text-white transition-opacity"
          onClick={(e) => e.stopPropagation()}
          title="Open in Spotify"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
        <button
          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-all hover:scale-105"
          style={{ background: SPOTIFY_GREEN, color: "#000", opacity: undefined }}
          onClick={() => onSearchVariants(track)}
        >
          <Play className="w-3 h-3" />
          Find variants
        </button>
      </div>
    </motion.div>
  );
}

function Pagination({
  offset,
  limit,
  total,
  onPageChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onPageChange: (offset: number) => void;
}) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-3 pt-4 pb-2">
      <button
        className="p-2 rounded-full hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        onClick={() => onPageChange(Math.max(0, offset - limit))}
        disabled={offset === 0}
      >
        <ChevronLeft className="w-5 h-5 text-white" />
      </button>
      <span className="text-white/60 text-sm">
        Page {currentPage} of {totalPages}
        <span className="text-white/30 ml-2">({total} tracks)</span>
      </span>
      <button
        className="p-2 rounded-full hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        onClick={() => onPageChange(offset + limit)}
        disabled={offset + limit >= total}
      >
        <ChevronRight className="w-5 h-5 text-white" />
      </button>
    </div>
  );
}

function LikedTracksTab({ onSearchVariants }: { onSearchVariants: (track: SpotifyTrack) => void }) {
  const [offset, setOffset] = useState(0);
  const { data, isFetching, error, refetch } = useSpotifyLiked(offset, 50);

  useEffect(() => {
    refetch();
  }, [offset, refetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  if (isFetching) return <LoadingState label="Loading liked songs..." />;
  if (error) return <ErrorState message={(error as Error).message} />;
  if (!data) return null;

  return (
    <div>
      <div className="space-y-1">
        {data.tracks.map((track, i) => (
          <SpotifyTrackItem
            key={track.id}
            track={track}
            index={offset + i}
            onSearchVariants={onSearchVariants}
          />
        ))}
      </div>
      <Pagination
        offset={offset}
        limit={50}
        total={data.total}
        onPageChange={setOffset}
      />
    </div>
  );
}

function PlaylistsTab({ onSearchVariants }: { onSearchVariants: (track: SpotifyTrack) => void }) {
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [offset, setOffset] = useState(0);

  const { data: playlistsData, isFetching: loadingPlaylists, error: playlistsError, refetch: refetchPlaylists } = useSpotifyPlaylists();
  const { data: tracksData, isFetching: loadingTracks, error: tracksError, refetch: refetchTracks } = useSpotifyPlaylistTracks(
    selectedPlaylist?.id ?? null,
    offset,
    50
  );

  useEffect(() => {
    refetchPlaylists();
  }, [refetchPlaylists]);

  useEffect(() => {
    if (selectedPlaylist) {
      setOffset(0);
      refetchTracks();
    }
  }, [selectedPlaylist?.id]);

  useEffect(() => {
    if (selectedPlaylist) {
      refetchTracks();
    }
  }, [offset]);

  if (selectedPlaylist) {
    return (
      <div>
        <button
          className="flex items-center gap-2 text-white/60 hover:text-white mb-4 transition-colors text-sm"
          onClick={() => { setSelectedPlaylist(null); setOffset(0); }}
        >
          <ChevronLeft className="w-4 h-4" />
          Back to playlists
        </button>

        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl bg-white/5">
          {selectedPlaylist.thumbnailUrl && (
            <img src={selectedPlaylist.thumbnailUrl} alt={selectedPlaylist.name} className="w-14 h-14 rounded-lg object-cover" />
          )}
          <div>
            <h3 className="font-semibold text-white">{selectedPlaylist.name}</h3>
            <p className="text-white/50 text-sm">{selectedPlaylist.trackCount} tracks · by {selectedPlaylist.owner}</p>
          </div>
        </div>

        {loadingTracks ? (
          <LoadingState label="Loading tracks..." />
        ) : tracksError ? (
          <ErrorState message={(tracksError as Error).message} />
        ) : tracksData ? (
          <>
            <div className="space-y-1">
              {tracksData.tracks.map((track, i) => (
                <SpotifyTrackItem
                  key={track.id}
                  track={track}
                  index={offset + i}
                  onSearchVariants={onSearchVariants}
                />
              ))}
            </div>
            <Pagination offset={offset} limit={50} total={tracksData.total} onPageChange={setOffset} />
          </>
        ) : null}
      </div>
    );
  }

  if (loadingPlaylists) return <LoadingState label="Loading playlists..." />;
  if (playlistsError) return <ErrorState message={(playlistsError as Error).message} />;
  if (!playlistsData) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {playlistsData.playlists.map((playlist, i) => (
        <motion.button
          key={playlist.id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: Math.min(i * 0.04, 0.5) }}
          onClick={() => setSelectedPlaylist(playlist)}
          className="flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all text-left group"
        >
          {playlist.thumbnailUrl ? (
            <img src={playlist.thumbnailUrl} alt={playlist.name} className="w-12 h-12 rounded-md object-cover shrink-0" />
          ) : (
            <div className="w-12 h-12 rounded-md bg-white/10 flex items-center justify-center shrink-0">
              <List className="w-6 h-6 text-white/30" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white text-sm truncate">{playlist.name}</p>
            <p className="text-white/40 text-xs">{playlist.trackCount} tracks</p>
          </div>
          <ChevronLeft className="w-4 h-4 text-white/20 group-hover:text-white/60 rotate-180 shrink-0 transition-colors" />
        </motion.button>
      ))}
    </div>
  );
}

function TopTracksTab({ onSearchVariants }: { onSearchVariants: (track: SpotifyTrack) => void }) {
  const [timeRange, setTimeRange] = useState<"short_term" | "medium_term" | "long_term">("medium_term");
  const { data, isFetching, error, refetch } = useSpotifyTopTracks(timeRange);

  useEffect(() => {
    refetch();
  }, [timeRange, refetch]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const ranges = [
    { id: "short_term" as const, label: "Last 4 weeks" },
    { id: "medium_term" as const, label: "Last 6 months" },
    { id: "long_term" as const, label: "All time" },
  ];

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {ranges.map((r) => (
          <button
            key={r.id}
            onClick={() => setTimeRange(r.id)}
            className="px-3 py-1.5 rounded-full text-sm font-medium transition-all"
            style={
              timeRange === r.id
                ? { background: SPOTIFY_GREEN, color: "#000" }
                : { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.6)" }
            }
          >
            {r.label}
          </button>
        ))}
      </div>

      {isFetching ? (
        <LoadingState label="Loading top tracks..." />
      ) : error ? (
        <ErrorState message={(error as Error).message} />
      ) : data ? (
        <div className="space-y-1">
          {data.tracks.map((track, i) => (
            <SpotifyTrackItem key={track.id} track={track} index={i} onSearchVariants={onSearchVariants} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-white/40">
      <Loader2 className="w-8 h-8 animate-spin" style={{ color: SPOTIFY_GREEN }} />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-red-400/70">
      <AlertCircle className="w-8 h-8" />
      <p className="text-sm text-center max-w-xs">{message}</p>
    </div>
  );
}

export default function Favorites() {
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<TabId>("liked");
  const { data: status, isLoading: statusLoading } = useSpotifyStatus();
  const logout = useSpotifyLogout();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("spotify_connected") === "1") {
      queryClient.invalidateQueries({ queryKey: ["spotify", "status"] });
      window.history.replaceState({}, "", window.location.pathname);
      toast({ title: "Spotify connected!", description: "Your library is ready to browse." });
    }
    if (params.get("spotify_error")) {
      toast({
        title: "Spotify connection failed",
        description: params.get("spotify_error") ?? "Unknown error",
        variant: "destructive",
      });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleSearchVariants = (track: SpotifyTrack) => {
    const params = new URLSearchParams({
      artist: track.artist,
      title: track.title,
    });
    navigate(`/?${params}`);
  };

  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "liked", label: "Liked Songs", icon: <Heart className="w-4 h-4" /> },
    { id: "playlists", label: "Playlists", icon: <List className="w-4 h-4" /> },
    { id: "top", label: "Top Tracks", icon: <TrendingUp className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen pb-32">
      <div className="relative overflow-hidden border-b border-white/5 bg-black/20">
        <div className="max-w-5xl mx-auto px-4 pt-8 pb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center shadow-lg"
                style={{ background: SPOTIFY_GREEN }}
              >
                <Music2 className="w-5 h-5 text-black" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-white">Favorites</h1>
                {status?.connected && status.displayName && (
                  <p className="text-white/40 text-sm">Logged in as {status.displayName}</p>
                )}
              </div>
            </div>

            {status?.connected && (
              <button
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/50 hover:text-white text-sm transition-all"
              >
                <LogOut className="w-3.5 h-3.5" />
                Disconnect
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {statusLoading ? (
          <LoadingState label="Checking Spotify connection..." />
        ) : !status?.connected ? (
          <ConnectPrompt />
        ) : (
          <>
            <div className="flex gap-1 mb-6 p-1 rounded-xl bg-white/5 w-fit">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                  style={
                    activeTab === tab.id
                      ? { background: "rgba(255,255,255,0.12)", color: "#fff" }
                      : { color: "rgba(255,255,255,0.45)" }
                  }
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.15 }}
              >
                {activeTab === "liked" && <LikedTracksTab onSearchVariants={handleSearchVariants} />}
                {activeTab === "playlists" && <PlaylistsTab onSearchVariants={handleSearchVariants} />}
                {activeTab === "top" && <TopTracksTab onSearchVariants={handleSearchVariants} />}
              </motion.div>
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  );
}
