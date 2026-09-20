import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Tauri + Vite setup: fixed port so tauri.conf.json's devUrl matches,
// and we tell Vite to ignore src-tauri so Rust rebuilds don't trigger HMR loops.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
