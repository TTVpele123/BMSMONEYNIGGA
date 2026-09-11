import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    pool: "forks",
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
