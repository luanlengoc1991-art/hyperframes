import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri serves the dev build from this fixed port and loads ../dist in release.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "chrome110", outDir: "dist" },
});
