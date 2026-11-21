import { defineConfig } from "vite";

// One static page with everything inlined into a single JS file: no server, no CDN, no third-party requests.
// Upload dist/ anywhere (e.g. cyphosguard.com/recover/) or open it locally.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 1_000_000, modulePreload: false },
});
