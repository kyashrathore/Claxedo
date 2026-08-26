import { beforeEach, expect, test } from "bun:test"
import {
  clearMarkdownCache,
  getCachedMarkdown,
  inspectMarkdownCache,
  MARKDOWN_CACHE_BYTE_LIMIT,
  touchCachedMarkdown,
} from "./markdown-cache"

beforeEach(clearMarkdownCache)

test("evicts least-recently-used markdown by encoded bytes", () => {
  const body = "x".repeat(1536 * 1024)
  touchCachedMarkdown("one", { raw: body, hash: "1", html: body })
  touchCachedMarkdown("two", { raw: body, hash: "2", html: body })
  const one = getCachedMarkdown("one")!
  touchCachedMarkdown("one", one)
  touchCachedMarkdown("three", { raw: body, hash: "3", html: body })

  expect(getCachedMarkdown("one")).toBe(one)
  expect(getCachedMarkdown("two")).toBeUndefined()
  expect(getCachedMarkdown("three")).toBeDefined()
  expect(inspectMarkdownCache().bytes).toBeLessThanOrEqual(MARKDOWN_CACHE_BYTE_LIMIT)
})

test("does not retain one entry larger than the whole budget", () => {
  const body = "x".repeat(MARKDOWN_CACHE_BYTE_LIMIT / 2 + 1)
  touchCachedMarkdown("huge", { raw: body, hash: "huge", html: body })
  expect(getCachedMarkdown("huge")).toBeUndefined()
  expect(inspectMarkdownCache()).toEqual({ entries: 0, bytes: 0, limit: MARKDOWN_CACHE_BYTE_LIMIT })
})
