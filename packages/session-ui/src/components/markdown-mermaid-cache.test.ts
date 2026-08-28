import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearMermaidSvgCache,
  getCachedMermaidSvg,
  mermaidSvgCacheLimits,
  mermaidSvgCacheStats,
  touchCachedMermaidSvg,
} from "./markdown-cache"

beforeEach(() => {
  clearMermaidSvgCache()
})

describe("mermaid SVG remount cache", () => {
  test("serves a sanitized diagram synchronously on the second read", () => {
    const source = "graph TD; A-->B"
    const svg = "<svg><g>ok</g></svg>"
    touchCachedMermaidSvg(source, svg)
    expect(getCachedMermaidSvg(source)).toBe(svg)
    expect(getCachedMermaidSvg(source)).toBe(svg)
    expect(mermaidSvgCacheStats().entries).toBe(1)
  })

  test("refuses to store an empty sanitizer result", () => {
    touchCachedMermaidSvg("graph TD; A-->B", "")
    expect(getCachedMermaidSvg("graph TD; A-->B")).toBeUndefined()
    expect(mermaidSvgCacheStats().entries).toBe(0)
  })

  test("evicts oldest entries when the entry cap is exceeded", () => {
    const limit = mermaidSvgCacheLimits.entries
    for (let index = 0; index < limit + 2; index++) {
      touchCachedMermaidSvg(`source-${index}`, `<svg>${index}</svg>`)
    }
    expect(getCachedMermaidSvg("source-0")).toBeUndefined()
    expect(getCachedMermaidSvg("source-1")).toBeUndefined()
    expect(getCachedMermaidSvg(`source-${limit + 1}`)).toBe(`<svg>${limit + 1}</svg>`)
    expect(mermaidSvgCacheStats().entries).toBe(limit)
  })
})
