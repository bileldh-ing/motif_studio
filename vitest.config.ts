import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts"], testTimeout: 180000, hookTimeout: 120000, fileParallelism: false },
});
