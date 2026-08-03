import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": path.resolve(__dirname, "src/renderer"),
    },
  },
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
});
