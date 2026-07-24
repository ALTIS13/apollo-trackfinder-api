import { Link, useLocation } from "wouter";
import { Music2, Search, Heart, ListMusic, X, Sparkles, LogOut } from "lucide-react";
import { useTfAuth } from "@/auth/tf-auth";
import { usePlayer } from "@/hooks/use-player";
import { formatDuration } from "@/lib/utils";

interface SidebarProps {
  onClose?: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const [location] = useLocation();
  const { queue, queueIndex, currentTrack, playFromQueue, removeFromQueue } = usePlayer();
  const { session, logout } = useTfAuth();

  const navItems = [
    { to: "/", label: "Поиск", icon: <Search className="w-4 h-4" />, exact: true },
    { to: "/discover", label: "Рекомендации", icon: <Sparkles className="w-4 h-4" />, exact: false },
    { to: "/queue", label: "Очередь", icon: <ListMusic className="w-4 h-4" />, exact: false },
    { to: "/favorites", label: "Избранное", icon: <Heart className="w-4 h-4" />, exact: false },
  ];

  return (
    <div className="flex flex-col h-full py-4">
      {/* Logo */}
      <div className="px-4 pb-6 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shadow-lg">
            <Music2 className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-white tracking-wide text-sm">Apollo</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors md:hidden">
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="px-2 space-y-0.5">
        {navItems.map((item) => {
          const isActive = item.exact ? location === "/" : location.startsWith(item.to);
          return (
            <Link
              key={item.to}
              href={item.to}
              onClick={onClose}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? "bg-white/10 text-white"
                  : "text-white/50 hover:text-white hover:bg-white/5"
              }`}
            >
              <span className={isActive ? "text-white" : "text-white/40"}>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Queue section */}
      <div className="mt-6 px-2 flex-1 min-h-0 flex flex-col">
        <div className="flex items-center gap-2 px-3 mb-2">
          <ListMusic className="w-4 h-4 text-white/30" />
          <span className="text-xs font-semibold text-white/30 uppercase tracking-widest">Очередь</span>
          {queue.length > 0 && (
            <span className="ml-auto text-xs text-white/25">{queue.length}</span>
          )}
        </div>

        {queue.length === 0 ? (
          <div className="px-3 py-4 text-center">
            <p className="text-white/20 text-xs">Очередь пуста</p>
            <p className="text-white/12 text-[10px] mt-1">Добавляйте треки через&nbsp;+</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-0.5 pr-1 scrollbar-thin">
            {queue.map((track, i) => {
              const isCurrent = i === queueIndex && currentTrack?.id === track.id;
              return (
                <div
                  key={`${track.id}-${i}`}
                  className={`group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all ${
                    isCurrent
                      ? "bg-white/10 text-white"
                      : "text-white/45 hover:text-white hover:bg-white/5"
                  }`}
                  onClick={() => playFromQueue(i)}
                >
                  <div className="w-7 h-7 rounded-md overflow-hidden bg-white/8 flex-shrink-0">
                    {track.thumbnailUrl ? (
                      <img src={track.thumbnailUrl} alt={track.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music2 className="w-3 h-3 text-white/25" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium truncate ${isCurrent ? "text-white" : ""}`}>{track.title}</p>
                    <p className="text-[10px] text-white/30 truncate">{track.artist}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-[10px] text-white/20 hidden group-hover:block">
                      {formatDuration(track.duration)}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeFromQueue(i); }}
                      className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-400 transition-all"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-white/5 px-4 pt-3 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[10px] text-white/30">
          {session?.accountId.slice(0, 8)}...
        </span>
        <button
          type="button"
          title="Выйти"
          aria-label="Выйти"
          onClick={() => void logout()}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center text-white/40 transition-colors hover:text-white"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
