import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/renderer/**/*.test.{ts,tsx}"],
    globals: false,
    css: false,
  },
});
