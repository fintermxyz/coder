import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// The Preact + TypeScript renderer. Builds to gui/renderer/dist, which the
// Electron main process loads in production; `npm run gui:dev` serves it with HMR.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "../renderer/dist",
    emptyOutDir: true,
  },
  server: { port: 5178 },
});
