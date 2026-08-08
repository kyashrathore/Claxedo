import { describe, expect, test } from "bun:test"
import { createMermaidBackend } from "./mermaid-backend"

describe("timeline Mermaid backend selection", () => {
  test("uses the native desktop capability", async () => {
    let request: { source: string; theme?: Record<string, string> } | undefined
    const render = createMermaidBackend({
      nativeRenderer: async (source, theme) => {
        request = { source, theme }
        return "<svg></svg>"
      },
      fallback: async () => "fallback",
      theme: () => ({ primaryColor: "#181818" }),
    })
    await expect(render("flowchart LR\nA --> B")).resolves.toBe("<svg></svg>")
    expect(request).toEqual({ source: "flowchart LR\nA --> B", theme: { primaryColor: "#181818" } })
  })

  test("uses the lazy JavaScript fallback after a native failure", async () => {
    const render = createMermaidBackend({
      nativeRenderer: async () => {
        throw new Error("unsupported")
      },
      fallback: async (source) => `<svg data-fallback="${source.length}"></svg>`,
      theme: () => ({}),
    })
    await expect(render("invalid native diagram")).resolves.toBe('<svg data-fallback="22"></svg>')
  })
})
