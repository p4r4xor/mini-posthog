import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API runs on :3000. Proxy the API routes so the SPA can call them
// same-origin during local dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/capture": "http://localhost:3000",
      "/query": "http://localhost:3000",
      "/traces": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
