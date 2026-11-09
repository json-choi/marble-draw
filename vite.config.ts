import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static app: built to dist/ and served by Cloudflare static assets (no Worker code).
export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
});
