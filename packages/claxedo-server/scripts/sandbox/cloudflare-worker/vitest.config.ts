import { defineConfig } from "vitest/config"

/**
 * Anchors this Worker's suite so it stops at this directory instead of
 * inheriting `claxedo-server`'s config, whose setup file redirects that
 * package's data roots and imports its SQLite owner — neither of which this
 * Worker has, and which vitest resolves against this package's root.
 */
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
})
