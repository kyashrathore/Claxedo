import { beforeEach, describe, expect, test } from "bun:test"
import {
  cacheCodeHighlight,
  clearCodeHighlightCache,
  codeHighlightCacheLimits,
  codeHighlightCacheStats,
  getCachedCodeHighlight,
  highlightCodeThroughCache,
  type CodeHighlight,
} from "./markdown-code-cache"

function highlightOf(text: string, style = "color:var(--syntax-keyword)"): CodeHighlight {
  return { language: "typescript", generation: 1, stable: [[text, style]], unstable: [] }
}

beforeEach(() => {
  clearCodeHighlightCache()
})

describe("highlightCodeThroughCache", () => {
  // The remount scenario from docs/perf/HANDOFF.md: session switches remount
  // <Markdown>, and `code()` in markdown.tsx runs this exact read-through per
  // block. Two mounts of the same completed block must cost ONE worker trip.
  test("second render of the same completed block hits the cache (highlight runs once)", async () => {
    const src = "const answer = 42"
    let calls = 0
    const highlight = async () => {
      calls++
      return highlightOf(src)
    }

    const first = await highlightCodeThroughCache(src, "typescript", "OpenCode", true, highlight)
    const second = await highlightCodeThroughCache(src, "typescript", "OpenCode", true, highlight)

    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(second.stable).toEqual([[src, "color:var(--syntax-keyword)"]])
  })

  test("streaming (incomplete) blocks are never cached mid-stream", async () => {
    const src = "const partial ="
    let calls = 0
    const highlight = async () => {
      calls++
      return highlightOf(src)
    }

    await highlightCodeThroughCache(src, "typescript", "OpenCode", false, highlight)
    await highlightCodeThroughCache(src, "typescript", "OpenCode", false, highlight)

    expect(calls).toBe(2)
    expect(getCachedCodeHighlight(src, "typescript", "OpenCode")).toBeUndefined()
    expect(codeHighlightCacheStats().entries).toBe(0)
  })

  test("a failed highlight is not cached, so the next mount retries", async () => {
    const src = "const x = 1"
    let calls = 0
    const failing = async (): Promise<CodeHighlight> => {
      calls++
      throw new Error("worker down")
    }

    await expect(highlightCodeThroughCache(src, "typescript", "OpenCode", true, failing)).rejects.toThrow("worker down")
    expect(getCachedCodeHighlight(src, "typescript", "OpenCode")).toBeUndefined()

    const recovered = await highlightCodeThroughCache(src, "typescript", "OpenCode", true, async () => {
      calls++
      return highlightOf(src)
    })
    expect(calls).toBe(2)
    expect(getCachedCodeHighlight(src, "typescript", "OpenCode")).toBe(recovered)
  })
})

describe("cache keying", () => {
  test("theme is part of the key — a different theme never serves stale colors", () => {
    const src = "let a = 1"
    cacheCodeHighlight(src, "typescript", "OpenCode", highlightOf(src))
    expect(getCachedCodeHighlight(src, "typescript", "OpenCode")).toBeDefined()
    expect(getCachedCodeHighlight(src, "typescript", "OtherTheme")).toBeUndefined()
  })

  test("language is part of the key", () => {
    const src = "print('hi')"
    cacheCodeHighlight(src, "python", "OpenCode", { ...highlightOf(src), language: "python" })
    expect(getCachedCodeHighlight(src, "python", "OpenCode")).toBeDefined()
    expect(getCachedCodeHighlight(src, "text", "OpenCode")).toBeUndefined()
  })

  test("a hash-bucket hit with different source degrades to a miss, never wrong code", () => {
    // Same length forces the length component of the key to match; the stored
    // src comparison is the collision guard being exercised here.
    cacheCodeHighlight("aaaa", "text", "OpenCode", highlightOf("aaaa"))
    expect(getCachedCodeHighlight("bbbb", "text", "OpenCode")).toBeUndefined()
  })
})

describe("cache bounds", () => {
  test("entry cap evicts least-recently-used, reads refresh recency", () => {
    const limit = codeHighlightCacheLimits.entries
    for (let i = 0; i < limit; i++) {
      cacheCodeHighlight(`code-${i}`, "text", "OpenCode", highlightOf(`code-${i}`))
    }
    // Touch the oldest entry so it becomes most recently used.
    expect(getCachedCodeHighlight("code-0", "text", "OpenCode")).toBeDefined()

    cacheCodeHighlight("overflow", "text", "OpenCode", highlightOf("overflow"))

    expect(codeHighlightCacheStats().entries).toBe(limit)
    expect(getCachedCodeHighlight("code-0", "text", "OpenCode")).toBeDefined()
    expect(getCachedCodeHighlight("code-1", "text", "OpenCode")).toBeUndefined()
    expect(getCachedCodeHighlight("overflow", "text", "OpenCode")).toBeDefined()
  })

  test("byte cap evicts before the budget is exceeded", () => {
    // Each entry counts src + token content, so ~2 chunks of bytes; four
    // entries then total ~2x the budget regardless of the configured limit.
    const chunk = "x".repeat(Math.ceil(codeHighlightCacheLimits.bytes / 4))
    for (let i = 0; i < 4; i++) {
      const src = `${i}:${chunk}`
      cacheCodeHighlight(src, "text", "OpenCode", { language: "text", generation: 1, stable: [], unstable: [[src, ""]] })
    }
    const stats = codeHighlightCacheStats()
    expect(stats.bytes).toBeLessThanOrEqual(codeHighlightCacheLimits.bytes)
    expect(stats.entries).toBeLessThan(4)
    expect(getCachedCodeHighlight(`0:${chunk}`, "text", "OpenCode")).toBeUndefined()
    expect(getCachedCodeHighlight(`3:${chunk}`, "text", "OpenCode")).toBeDefined()
  })

  test("an entry larger than the whole budget is skipped instead of flushing the cache", () => {
    cacheCodeHighlight("keep", "text", "OpenCode", highlightOf("keep"))
    const huge = "y".repeat(codeHighlightCacheLimits.bytes + 1)
    cacheCodeHighlight(huge, "text", "OpenCode", { language: "text", generation: 1, stable: [], unstable: [[huge, ""]] })
    expect(getCachedCodeHighlight(huge, "text", "OpenCode")).toBeUndefined()
    expect(getCachedCodeHighlight("keep", "text", "OpenCode")).toBeDefined()
  })

  test("re-caching the same block replaces the entry without double-counting bytes", () => {
    const src = "const a = 1"
    cacheCodeHighlight(src, "text", "OpenCode", highlightOf(src))
    const once = codeHighlightCacheStats()
    cacheCodeHighlight(src, "text", "OpenCode", highlightOf(src))
    expect(codeHighlightCacheStats()).toEqual(once)
    expect(once.entries).toBe(1)
  })
})
