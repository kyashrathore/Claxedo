import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  test: {
    // Wall-clock-sensitive suites (intake winner races, effect leases) pass in
    // ms locally but starve past vitest's 5s default on 2-core CI runners
    // sharing the machine with a concurrent turbo task. Budget for starvation.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@claxedo/workgraph/contracts": fileURLToPath(new URL("./src/contracts/index.ts", import.meta.url)),
      "@claxedo/workgraph/domain": fileURLToPath(new URL("./src/domain/index.ts", import.meta.url)),
      "@claxedo/workgraph/hosted": fileURLToPath(new URL("./src/hosted.ts", import.meta.url)),
      "@claxedo/workgraph/ports": fileURLToPath(new URL("./src/ports/index.ts", import.meta.url)),
      "@claxedo/workgraph/conformance": fileURLToPath(new URL("./src/conformance/index.ts", import.meta.url)),
    },
  },
})
