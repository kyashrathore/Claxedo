import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
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
