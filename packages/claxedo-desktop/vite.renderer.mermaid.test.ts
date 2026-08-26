import { describe, expect, test } from "bun:test"
import { createElectronRenderer } from "./vite.renderer"

describe("desktop Mermaid chunking", () => {
  test("keeps manual Mermaid chunks from absorbing startup helpers", () => {
    const config = createElectronRenderer("production")
    const output = config.build?.rollupOptions?.output
    expect(Array.isArray(output)).toBe(false)
    if (!output || Array.isArray(output)) throw new Error("expected one renderer output")

    expect(output.onlyExplicitManualChunks).toBe(true)
    expect(typeof output.manualChunks).toBe("function")
    if (typeof output.manualChunks !== "function") throw new Error("expected manual chunk function")
    expect(output.manualChunks("/node_modules/mermaid/dist/diagrams/class/classDiagram.js", {} as never)).toBe(
      "mermaid-classDiagram",
    )
    expect(output.manualChunks("/node_modules/vite/modulepreload-polyfill.js", {} as never)).toBeUndefined()
  })
})
