import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow importing shared rule engine from `../functions/src` (see PlaylistOrganizer).
    fs: { allow: [".."] },
  },
});
