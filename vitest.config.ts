import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/types.ts", "src/index.ts"],
      // Gate set just below current coverage so regressions fail CI while
      // normal noise doesn't. Raise these as coverage improves.
      thresholds: {
        statements: 68,
        branches: 63,
        functions: 66,
        lines: 68,
      },
    },
  },
});
