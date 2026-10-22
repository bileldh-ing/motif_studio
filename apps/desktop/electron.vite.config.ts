import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Workspace packages ship TypeScript sources, so they are bundled rather than externalized.
const bundled = ["@motif/editor-core", "@motif/project-schema", "@motif/render-engine", "@motif/cloud-client", "zod"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } } },
  },
});
