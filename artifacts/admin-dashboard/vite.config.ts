import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "motion-vendor": ["framer-motion"],
          "topology-vendor": ["@xyflow/react", "dagre"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
