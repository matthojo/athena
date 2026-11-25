import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOOT_MARKER, BOOT_SCRIPT } from "./src/lib/appearance-boot";

const { version } = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { version: string };

// Athena PWA build config. Root is app/ so index.html + src/** resolve naturally;
// output goes to app/dist which netlify.toml publishes and Vite's own dev/preview
// servers already expect.
export default defineConfig({
  root: resolve(__dirname),
  // The appearance (Light, Dark or the system's) is applied before the first paint (src/lib/appearance-boot.ts).
  plugins: [{ name: "athena-appearance", transformIndexHtml: (html) => html.replace(BOOT_MARKER, `<script>${BOOT_SCRIPT}</script>`) }],
  publicDir: resolve(__dirname, "public"),
  // Shown in Settings → About (components/about-settings.ts).
  define: {
    __ATHENA_VERSION__: JSON.stringify(version),
    __ATHENA_COMMIT__: JSON.stringify(process.env.COMMIT_REF ?? ""),
    __ATHENA_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
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
