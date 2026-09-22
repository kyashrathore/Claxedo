import { describe, expect, test, vi } from "vitest"

// S-2: every mermaid sink — the documents editor preview and fullscreen plus
// the session timeline — must run the same strict renderer configuration and
// the session-ui SVG sanitizer. These tests pin the shared module behind both.

const state = vi.hoisted(() => ({
  svg: "",
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: state.svg })),
}))

vi.mock("mermaid", () => ({
  default: { initialize: state.initialize, render: state.render },
}))

import { renderMermaidSvg, renderSafeMermaidSvg } from "./mermaid"

describe("shared mermaid renderer", () => {
  test("initializes once with the strict, htmlLabels-off configuration", async () => {
    state.svg = "<svg><rect width='1' height='1'/></svg>"
    await renderMermaidSvg("graph TD; A-->B")
    await renderMermaidSvg("graph TD; B-->C")
    expect(state.initialize).toHaveBeenCalledTimes(1)
    expect(state.initialize.mock.calls[0]?.[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      htmlLabels: false,
    })
  })

  test("renderMermaidSvg returns the renderer's raw output for downstream sanitizers", async () => {
    state.svg = "<svg><text>raw</text></svg>"
    await expect(renderMermaidSvg("graph TD; A-->B")).resolves.toBe("<svg><text>raw</text></svg>")
  })

  test("renderSafeMermaidSvg drops markup the SVG policy forbids", async () => {
    state.svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><foreignObject><body>owned</body></foreignObject><rect width="4" height="4"/></svg>'
    const safe = await renderSafeMermaidSvg("graph TD; A-->B")
    expect(safe).toContain("<rect")
    expect(safe).not.toContain("script")
    expect(safe).not.toContain("foreignObject")
  })

  test("renderSafeMermaidSvg fails closed on empty output", async () => {
    state.svg = ""
    await expect(renderSafeMermaidSvg("graph TD; A-->B")).rejects.toThrow("sanitization")
  })
})
