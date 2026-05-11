import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out-player/main",
      rollupOptions: {
        input: resolve(__dirname, "src/player/main/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out-player/preload",
      rollupOptions: {
        input: resolve(__dirname, "src/player/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/player/renderer"),
    plugins: [react()],
    build: {
      outDir: "out-player/renderer",
      rollupOptions: { input: resolve(__dirname, "src/player/renderer/index.html") },
    },
  },
});
