import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const isReplit = !!process.env.REPL_ID;
const rawPort = process.env.PORT || "3000";
const port = Number(rawPort);
const basePath = process.env.BASE_PATH || "/";

const replitPlugins: any[] = [];
if (isReplit) {
  try {
    const errorOverlay = await import("@replit/vite-plugin-runtime-error-modal");
    replitPlugins.push(errorOverlay.default());
  } catch {}
  if (process.env.NODE_ENV !== "production") {
    try {
      const cart = await import("@replit/vite-plugin-cartographer");
      replitPlugins.push(cart.cartographer({ root: path.resolve(import.meta.dirname, "..") }));
      const banner = await import("@replit/vite-plugin-dev-banner");
      replitPlugins.push(banner.devBanner());
    } catch {}
  }
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    ...replitPlugins,
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
