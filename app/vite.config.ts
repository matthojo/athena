import { defineConfig } from "vite";
import { resolve } from "node:path";

// Athena PWA build config. Root is app/ so index.html + src/** resolve naturally;
// output goes to app/dist which netlify.toml publishes and Vite's own dev/preview
// servers already expect.
export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, "public"),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
