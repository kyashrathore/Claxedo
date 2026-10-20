/// <reference types="bun" />
import { expect, test } from "bun:test"
import { renderMermaidSvg } from "./mermaid"

test("a diagram draws on demand into an SVG whose colors are the theme's CSS variables", async () => {
  const svg = await renderMermaidSvg("sequenceDiagram\n  App->>Daemon: prompt\n  Daemon-->>App: reply")
  expect(svg).toStartWith("<svg")
  expect(svg).toContain('class="pele pele-sequence"')
  expect(svg).toContain("var(--pele-line")
  expect(svg).toContain(">prompt</text>")
})

test("a source pele cannot draw rejects, so its code block stays", async () => {
  await expect(renderMermaidSvg("flowchart LR\n  A --> \n  B -->> (((")).rejects.toMatchObject({ code: "syntax" })
  await expect(renderMermaidSvg("not a diagram")).rejects.toMatchObject({ code: "unsupported-diagram" })
})
