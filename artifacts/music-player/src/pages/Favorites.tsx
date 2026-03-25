import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  Music2,
  LogIn,
  LogOut,
  ChevronLeft,
  ChevronRight,
  List,
  Heart,
  TrendingUp,
  Loader2,
  AlertCircle,
  ExternalLink,
  Play,
  Key,
  Eye,
  EyeOff,
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
import {
  useYandexStatus,
  useYandexSaveToken,
  useYandexLogout,
  useYandexLiked,
  useYandexPlaylists,
  useYandexPlaylistTracks,
  type YandexTrack,
  type YandexPlaylist,
} from "@/hooks/use-yandex";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const SPOTIFY_GREEN = "#1DB954";
const YANDEX_YELLOW = "#FFCC00";

type ServiceTab = "spotify" | "yandex";
type CatalogTab = "liked" | "playlists" | "top";

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function LoadingState({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-white/40">
      <Loader2 className="w-8 h-8 animate-spin" style={{ color }} />
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

function Pagination({
  offset, limit, total, onPageChange,
}: { offset: number; limit: number; total: number; onPageChange: (o: number) => void }) {
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

type GenericTrack = { id: string; title: string; artist: string; album: string; durationMs: number; thumbnailUrl: string | null; externalUrl: string };

function TrackList({ tracks, offset, accentColor, onSearchVariants }: {
  tracks: GenericTrack[];
  offset: number;
  accentColor: string;
  onSearchVariants: (title: string, artist: string) => void;
}) {
  return (
    <div className="space-y-1">
      {tracks.map((track, i) => (
        <motion.div
          key={track.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: Math.min(i * 0.025, 0.4) }}
          className="group flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all"
        >
          <span className="w-6 text-center text-white/25 text-xs shrink-0 group-hover:hidden">{offset + i + 1}</span>
          <button
            className="w-6 h-6 shrink-0 hidden group-hover:flex items-center justify-center text-white/50 hover:text-white transition-colors"
            onClick={() => onSearchVariants(track.title, track.artist)}
            title="Find variants"
          >
            <Play className="w-3.5 h-3.5" />
          </button>

          {track.thumbnailUrl ? (
            <img src={track.thumbnailUrl} alt={track.album} className="w-10 h-10 rounded-md object-cover shrink-0" />
          ) : (
            <div className="w-10 h-10 rounded-md bg-white/10 flex items-center justify-center shrink-0">
              <Music2 className="w-4 h-4 text-white/25" />
            </div>
          )}

          <div className="flex-1 min-w-0">
            <p className="font-medium text-white truncate text-sm">{track.title}</p>
            <p className="text-white/45 text-xs truncate">{track.artist}</p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-white/25 text-xs hidden sm:block">{formatDuration(track.durationMs)}</span>
            <a
              href={track.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="opacity-0 group-hover:opacity-100 text-white/35 hover:text-white/70 transition-opacity"
              onClick={(e) => e.stopPropagation()}
              title="Open in streaming service"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold transition-all hover:scale-105 active:scale-95"
              style={{ background: accentColor, color: "#000" }}
              onClick={() => onSearchVariants(track.title, track.artist)}
            >
              Find variants
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function SpotifyConnectPrompt() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-6 py-16 px-4"
    >
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center shadow-xl"
        style={{ background: `radial-gradient(circle at 35% 35%, #1ed760, ${SPOTIFY_GREEN})` }}
      >
        <Music2 className="w-10 h-10 text-black" />
      </div>
      <div className="text-center max-w-sm">
        <h2 className="text-2xl font-bold text-white mb-2">Connect Spotify</h2>
        <p className="text-white/55 text-base">Browse your liked songs, playlists, and top tracks — then find every version.</p>
      </div>
      <a
        href={spotifyLoginUrl()}
        className="flex items-center gap-2.5 px-7 py-3.5 rounded-full font-semibold text-black shadow-lg transition-all hover:scale-105 hover:brightness-110 active:scale-95"
        style={{ background: SPOTIFY_GREEN }}
      >
        <LogIn className="w-4 h-4" />
        Connect with Spotify
      </a>
      <p className="text-white/25 text-xs text-center max-w-xs">
        Read-only access — we never modify your library or post on your behalf.
      </p>
    </motion.div>
  );
}

function YandexConnectPrompt({ onConnected }: { onConnected: () => void }) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const saveToken = useYandexSaveToken();
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await saveToken.mutateAsync(token);
      toast({ title: "Yandex Music connected!", description: "Your library is ready to browse." });
      onConnected();
    } catch (err) {
      toast({
        title: "Connection failed",
        description: (err as Error).message ?? "Check your token and try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-6 py-16 px-4"
    >
      <div
        className="w-20 h-20 rounded-full flex items-center justify-center shadow-xl"
        style={{ background: `radial-gradient(circle at 35% 35%, #ffe033, ${YANDEX_YELLOW})` }}
      >
        <Music2 className="w-10 h-10 text-black" />
      </div>

      <div className="text-center max-w-sm">
        <h2 className="text-2xl font-bold text-white mb-2">Connect Yandex Music</h2>
        <p className="text-white/55 text-base">Paste your OAuth token to browse your Yandex Music library.</p>
      </div>

      <div className="w-full max-w-md space-y-3">
        <div className="bg-white/5 rounded-xl p-4 text-xs text-white/55 space-y-2 border border-white/8">
          <p className="font-semibold text-white/70 flex items-center gap-1.5"><Key className="w-3.5 h-3.5" />How to get your token:</p>
          <ol className="space-y-1 list-decimal list-inside">
            <li>Open <a href="https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/80">this Yandex OAuth link</a></li>
            <li>Log in and grant access</li>
            <li>Copy the <code className="bg-white/10 px-1 rounded">access_token</code> from the URL</li>
          </ol>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="relative">
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your OAuth token here..."
              className="w-full bg-white/8 border border-white/12 rounded-xl px-4 py-3 text-white text-sm placeholder-white/30 focus:outline-none focus:border-white/30 pr-10"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/35 hover:text-white/70"
              onClick={() => setShowToken(!showToken)}
            >
              {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <button
            type="submit"
            disabled={!token.trim() || saveToken.isPending}
            className="flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-black disabled:opacity-50 disabled:cursor-not-allowed transition-all hover:brightness-110 active:scale-98"
            style={{ background: YANDEX_YELLOW }}
          >
            {saveToken.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            Connect Yandex Music
          </button>
        </form>
      </div>
    </motion.div>
  );
}

function SpotifyCatalog({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [activeTab, setActiveTab] = useState<CatalogTab>("liked");

  const tabs = [
    { id: "liked" as CatalogTab, label: "Liked Songs", icon: <Heart className="w-4 h-4" /> },
    { id: "playlists" as CatalogTab, label: "Playlists", icon: <List className="w-4 h-4" /> },
    { id: "top" as CatalogTab, label: "Top Tracks", icon: <TrendingUp className="w-4 h-4" /> },
  ];

  return (
    <div>
      <div className="flex gap-1 mb-5 p-1 rounded-xl bg-white/5 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={activeTab === tab.id ? { background: "rgba(255,255,255,0.12)", color: "#fff" } : { color: "rgba(255,255,255,0.45)" }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === "liked" && <SpotifyLikedTab onSearchVariants={onSearchVariants} />}
          {activeTab === "playlists" && <SpotifyPlaylistsTab onSearchVariants={onSearchVariants} />}
          {activeTab === "top" && <SpotifyTopTab onSearchVariants={onSearchVariants} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function SpotifyLikedTab({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [offset, setOffset] = useState(0);
  const { data, isFetching, error, refetch } = useSpotifyLiked(offset, 50);
  useEffect(() => { refetch(); }, [offset]);
  useEffect(() => { refetch(); }, []);

  if (isFetching) return <LoadingState label="Loading liked songs..." color={SPOTIFY_GREEN} />;
  if (error) return <ErrorState message={(error as Error).message} />;
  if (!data) return null;

  const tracks: GenericTrack[] = data.tracks.map((t: SpotifyTrack) => ({
    id: t.id, title: t.title, artist: t.artist, album: t.album,
    durationMs: t.durationMs, thumbnailUrl: t.thumbnailUrl, externalUrl: t.spotifyUrl,
  }));

  return (
    <>
      <TrackList tracks={tracks} offset={offset} accentColor={SPOTIFY_GREEN} onSearchVariants={onSearchVariants} />
      <Pagination offset={offset} limit={50} total={data.total} onPageChange={setOffset} />
    </>
  );
}

function SpotifyPlaylistsTab({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [selected, setSelected] = useState<SpotifyPlaylist | null>(null);
  const [offset, setOffset] = useState(0);
  const { data: pData, isFetching: loadingP, error: pErr, refetch: refetchP } = useSpotifyPlaylists();
  const { data: tData, isFetching: loadingT, error: tErr, refetch: refetchT } = useSpotifyPlaylistTracks(selected?.id ?? null, offset, 50);

  useEffect(() => { refetchP(); }, []);
  useEffect(() => { if (selected) { setOffset(0); } }, [selected?.id]);
  useEffect(() => { if (selected) refetchT(); }, [selected?.id, offset]);

  if (selected) {
    const tracks: GenericTrack[] = (tData?.tracks ?? []).map((t: SpotifyTrack) => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      durationMs: t.durationMs, thumbnailUrl: t.thumbnailUrl, externalUrl: t.spotifyUrl,
    }));
    return (
      <div>
        <button className="flex items-center gap-2 text-white/50 hover:text-white mb-4 text-sm transition-colors" onClick={() => { setSelected(null); setOffset(0); }}>
          <ChevronLeft className="w-4 h-4" /> Back to playlists
        </button>
        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl bg-white/5">
          {selected.thumbnailUrl && <img src={selected.thumbnailUrl} alt={selected.name} className="w-12 h-12 rounded-lg object-cover" />}
          <div>
            <h3 className="font-semibold text-white text-sm">{selected.name}</h3>
            <p className="text-white/40 text-xs">{selected.trackCount} tracks</p>
          </div>
        </div>
        {loadingT ? <LoadingState label="Loading tracks..." color={SPOTIFY_GREEN} /> :
          tErr ? <ErrorState message={(tErr as Error).message} /> : (
            <>
              <TrackList tracks={tracks} offset={offset} accentColor={SPOTIFY_GREEN} onSearchVariants={onSearchVariants} />
              {tData && <Pagination offset={offset} limit={50} total={tData.total} onPageChange={setOffset} />}
            </>
          )}
      </div>
    );
  }

  if (loadingP) return <LoadingState label="Loading playlists..." color={SPOTIFY_GREEN} />;
  if (pErr) return <ErrorState message={(pErr as Error).message} />;
  if (!pData) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {pData.playlists.map((p: SpotifyPlaylist, i: number) => (
        <motion.button
          key={p.id}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: Math.min(i * 0.03, 0.4) }}
          onClick={() => setSelected(p)}
          className="flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all text-left group"
        >
          {p.thumbnailUrl
            ? <img src={p.thumbnailUrl} alt={p.name} className="w-12 h-12 rounded-md object-cover shrink-0" />
            : <div className="w-12 h-12 rounded-md bg-white/8 flex items-center justify-center shrink-0"><List className="w-5 h-5 text-white/25" /></div>
          }
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white text-sm truncate">{p.name}</p>
            <p className="text-white/35 text-xs">{p.trackCount} tracks</p>
          </div>
          <ChevronLeft className="w-4 h-4 text-white/15 group-hover:text-white/50 rotate-180 shrink-0 transition-colors" />
        </motion.button>
      ))}
    </div>
  );
}

function SpotifyTopTab({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [timeRange, setTimeRange] = useState<"short_term" | "medium_term" | "long_term">("medium_term");
  const { data, isFetching, error, refetch } = useSpotifyTopTracks(timeRange);
  useEffect(() => { refetch(); }, [timeRange]);
  useEffect(() => { refetch(); }, []);

  const ranges = [
    { id: "short_term" as const, label: "Last 4 weeks" },
    { id: "medium_term" as const, label: "Last 6 months" },
    { id: "long_term" as const, label: "All time" },
  ];

  const tracks: GenericTrack[] = (data?.tracks ?? []).map((t: SpotifyTrack) => ({
    id: t.id, title: t.title, artist: t.artist, album: t.album,
    durationMs: t.durationMs, thumbnailUrl: t.thumbnailUrl, externalUrl: t.spotifyUrl,
  }));

  return (
    <div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {ranges.map((r) => (
          <button key={r.id} onClick={() => setTimeRange(r.id)}
            className="px-3 py-1.5 rounded-full text-sm font-medium transition-all"
            style={timeRange === r.id ? { background: SPOTIFY_GREEN, color: "#000" } : { background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.55)" }}
          >{r.label}</button>
        ))}
      </div>
      {isFetching ? <LoadingState label="Loading top tracks..." color={SPOTIFY_GREEN} /> :
        error ? <ErrorState message={(error as Error).message} /> :
          <TrackList tracks={tracks} offset={0} accentColor={SPOTIFY_GREEN} onSearchVariants={onSearchVariants} />}
    </div>
  );
}

function YandexCatalog({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [activeTab, setActiveTab] = useState<"liked" | "playlists">("liked");

  const tabs = [
    { id: "liked" as const, label: "Liked Songs", icon: <Heart className="w-4 h-4" /> },
    { id: "playlists" as const, label: "Playlists", icon: <List className="w-4 h-4" /> },
  ];

  return (
    <div>
      <div className="flex gap-1 mb-5 p-1 rounded-xl bg-white/5 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={activeTab === tab.id ? { background: "rgba(255,255,255,0.12)", color: "#fff" } : { color: "rgba(255,255,255,0.45)" }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === "liked" && <YandexLikedTab onSearchVariants={onSearchVariants} />}
          {activeTab === "playlists" && <YandexPlaylistsTab onSearchVariants={onSearchVariants} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function YandexLikedTab({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [offset, setOffset] = useState(0);
  const { data, isFetching, error, refetch } = useYandexLiked(offset, 50);
  useEffect(() => { refetch(); }, [offset]);
  useEffect(() => { refetch(); }, []);

  if (isFetching) return <LoadingState label="Loading liked tracks..." color={YANDEX_YELLOW} />;
  if (error) return <ErrorState message={(error as Error).message} />;
  if (!data) return null;

  const tracks: GenericTrack[] = data.tracks.map((t: YandexTrack) => ({
    id: t.id, title: t.title, artist: t.artist, album: t.album,
    durationMs: t.durationMs, thumbnailUrl: t.thumbnailUrl, externalUrl: t.trackUrl,
  }));

  return (
    <>
      <TrackList tracks={tracks} offset={offset} accentColor={YANDEX_YELLOW} onSearchVariants={onSearchVariants} />
      <Pagination offset={offset} limit={50} total={data.total} onPageChange={setOffset} />
    </>
  );
}

function YandexPlaylistsTab({ onSearchVariants }: { onSearchVariants: (title: string, artist: string) => void }) {
  const [selected, setSelected] = useState<YandexPlaylist | null>(null);
  const [offset, setOffset] = useState(0);
  const { data: pData, isFetching: loadingP, error: pErr, refetch: refetchP } = useYandexPlaylists();
  const { data: tData, isFetching: loadingT, error: tErr, refetch: refetchT } = useYandexPlaylistTracks(
    selected?.uid ?? null, selected?.kind ?? null, offset, 50
  );

  useEffect(() => { refetchP(); }, []);
  useEffect(() => { if (selected) { setOffset(0); } }, [selected?.kind, selected?.uid]);
  useEffect(() => { if (selected) refetchT(); }, [selected?.kind, selected?.uid, offset]);

  if (selected) {
    const tracks: GenericTrack[] = (tData?.tracks ?? []).map((t: YandexTrack) => ({
      id: t.id, title: t.title, artist: t.artist, album: t.album,
      durationMs: t.durationMs, thumbnailUrl: t.thumbnailUrl, externalUrl: t.trackUrl,
    }));
    return (
      <div>
        <button className="flex items-center gap-2 text-white/50 hover:text-white mb-4 text-sm transition-colors" onClick={() => { setSelected(null); setOffset(0); }}>
          <ChevronLeft className="w-4 h-4" /> Back to playlists
        </button>
        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl bg-white/5">
          {selected.thumbnailUrl && <img src={selected.thumbnailUrl} alt={selected.title} className="w-12 h-12 rounded-lg object-cover" />}
          <div>
            <h3 className="font-semibold text-white text-sm">{selected.title}</h3>
            <p className="text-white/40 text-xs">{selected.trackCount} tracks</p>
          </div>
        </div>
        {loadingT ? <LoadingState label="Loading tracks..." color={YANDEX_YELLOW} /> :
          tErr ? <ErrorState message={(tErr as Error).message} /> : (
            <>
              <TrackList tracks={tracks} offset={offset} accentColor={YANDEX_YELLOW} onSearchVariants={onSearchVariants} />
              {tData && <Pagination offset={offset} limit={50} total={tData.total} onPageChange={setOffset} />}
            </>
          )}
      </div>
    );
  }

  if (loadingP) return <LoadingState label="Loading playlists..." color={YANDEX_YELLOW} />;
  if (pErr) return <ErrorState message={(pErr as Error).message} />;
  if (!pData) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {pData.playlists.map((p: YandexPlaylist, i: number) => (
        <motion.button
          key={`${p.uid}-${p.kind}`}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: Math.min(i * 0.03, 0.4) }}
          onClick={() => setSelected(p)}
          className="flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all text-left group"
        >
          {p.thumbnailUrl
            ? <img src={p.thumbnailUrl} alt={p.title} className="w-12 h-12 rounded-md object-cover shrink-0" />
            : <div className="w-12 h-12 rounded-md bg-white/8 flex items-center justify-center shrink-0"><List className="w-5 h-5 text-white/25" /></div>
          }
          <div className="min-w-0 flex-1">
            <p className="font-medium text-white text-sm truncate">{p.title}</p>
            <p className="text-white/35 text-xs">{p.trackCount} tracks</p>
          </div>
          <ChevronLeft className="w-4 h-4 text-white/15 group-hover:text-white/50 rotate-180 shrink-0 transition-colors" />
        </motion.button>
      ))}
    </div>
  );
}

export default function Favorites() {
  const [, navigate] = useLocation();
  const [service, setService] = useState<ServiceTab>("spotify");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: spotifyStatus, isLoading: spotifyLoading } = useSpotifyStatus();
  const spotifyLogout = useSpotifyLogout();
  const { data: yandexStatus, isLoading: yandexLoading } = useYandexStatus();
  const yandexLogout = useYandexLogout();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("spotify_connected") === "1") {
      queryClient.invalidateQueries({ queryKey: ["spotify", "status"] });
      window.history.replaceState({}, "", window.location.pathname);
      toast({ title: "Spotify connected!", description: "Your library is ready to browse." });
    }
    if (params.get("spotify_error")) {
      toast({ title: "Spotify connection failed", description: params.get("spotify_error") ?? "Unknown error", variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handleSearchVariants = (title: string, artist: string) => {
    navigate(`/?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
  };

  const services = [
    { id: "spotify" as ServiceTab, label: "Spotify", color: SPOTIFY_GREEN, connected: spotifyStatus?.connected },
    { id: "yandex" as ServiceTab, label: "Yandex Music", color: YANDEX_YELLOW, connected: yandexStatus?.connected },
  ];

  const activeService = services.find((s) => s.id === service)!;
  const activeStatus = service === "spotify" ? spotifyStatus : yandexStatus;
  const activeLoading = service === "spotify" ? spotifyLoading : yandexLoading;
  const displayName = activeStatus?.connected ? activeStatus.displayName : undefined;

  return (
    <div className="min-h-screen pb-32">
      <div className="border-b border-white/5 bg-black/20">
        <div className="max-w-5xl mx-auto px-4 pt-6 pb-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-colors"
                style={{ background: activeService.color }}
              >
                <Music2 className="w-4 h-4 text-black" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white">Favorites</h1>
                {displayName && <p className="text-white/35 text-xs">{displayName}</p>}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex gap-1 p-1 rounded-xl bg-white/5">
                {services.map((svc) => (
                  <button
                    key={svc.id}
                    onClick={() => setService(svc.id)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all relative"
                    style={service === svc.id ? { background: "rgba(255,255,255,0.12)", color: "#fff" } : { color: "rgba(255,255,255,0.4)" }}
                  >
                    {svc.connected && (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: svc.color }} />
                    )}
                    {svc.label}
                  </button>
                ))}
              </div>

              {activeStatus?.connected && (
                <button
                  onClick={() => service === "spotify" ? spotifyLogout.mutate() : yandexLogout.mutate()}
                  disabled={spotifyLogout.isPending || yandexLogout.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/40 hover:text-white text-xs transition-all"
                >
                  <LogOut className="w-3 h-3" />
                  Disconnect
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={service}
            initial={{ opacity: 0, x: service === "spotify" ? -12 : 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {activeLoading ? (
              <LoadingState label="Checking connection..." color={activeService.color} />
            ) : service === "spotify" ? (
              spotifyStatus?.connected
                ? <SpotifyCatalog onSearchVariants={handleSearchVariants} />
                : <SpotifyConnectPrompt />
            ) : (
              yandexStatus?.connected
                ? <YandexCatalog onSearchVariants={handleSearchVariants} />
                : <YandexConnectPrompt onConnected={() => queryClient.invalidateQueries({ queryKey: ["yandex"] })} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
