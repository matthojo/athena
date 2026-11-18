import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { version } = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string };

// Athena PWA build config. Root is app/ so index.html + src/** resolve naturally;
// output goes to app/dist which netlify.toml publishes and Vite's own dev/preview
// servers already expect.
export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(__dirname, "public"),
  // Shown in Settings → About you (components/version-setting.ts).
  define: { __ATHENA_VERSION__: JSON.stringify(version) },
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
