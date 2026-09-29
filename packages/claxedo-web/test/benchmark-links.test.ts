import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { benchmark } from "../src/config"

const page = new URL("../dist/index.html", import.meta.url)

describe("benchmark links", () => {
  test.skipIf(!existsSync(page))("every link to the benchmark on / opens in a new tab", () => {
    const anchors = [...readFileSync(page, "utf8").matchAll(/<a\b[^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes(`href="${benchmark}`))
    expect(anchors.length).toBeGreaterThanOrEqual(2)
    for (const tag of anchors) {
      expect(tag).toContain('target="_blank"')
      expect(tag).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/)
    }
  })
})
