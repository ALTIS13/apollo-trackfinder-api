import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PlayerProvider } from "@/hooks/use-player";
import { Player } from "@/components/Player";
import { Music2, Heart } from "lucide-react";
import Home from "@/pages/Home";
import Favorites from "@/pages/Favorites";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function NavBar() {
  const [location] = useLocation();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  const links = [
    { to: "/", label: "Discover", icon: <Music2 className="w-4 h-4" /> },
    { to: "/favorites", label: "Favorites", icon: <Heart className="w-4 h-4" /> },
  ];

  return (
    <nav className="sticky top-0 z-40 border-b border-white/5 bg-black/60 backdrop-blur-xl">
      <div className="max-w-5xl mx-auto px-4 flex items-center gap-6 h-14">
        <Link href="/" className="flex items-center gap-2 font-bold text-white mr-4">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
            <Music2 className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm tracking-wide">TrackFinder</span>
        </Link>

        {links.map((link) => {
          const isActive = link.to === "/" ? location === "/" : location.startsWith(link.to);
          return (
            <Link
              key={link.to}
              href={link.to}
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                isActive ? "text-white" : "text-white/40 hover:text-white/70"
              }`}
            >
              {link.icon}
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/favorites" component={Favorites} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <PlayerProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <main className="min-h-screen relative flex flex-col">
              <NavBar />
              <Router />
              <Player />
            </main>
          </WouterRouter>
          <Toaster />
        </PlayerProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
