import { describe, expect, test } from "bun:test"
import { currentComparisons } from "../src/content/competitors"

describe("discovery contract", () => {
  test("allows public search and answer-engine crawlers", async () => {
    const robots = await Bun.file(new URL("../public/robots.txt", import.meta.url)).text()
    expect(robots).toContain("User-agent: OAI-SearchBot")
    expect(robots).toContain("Allow: /")
    expect(robots).toContain("Sitemap: https://claxedo.com/sitemap-index.xml")
  })

  test("keeps the reviewed comparison inventory bounded", () => {
    expect(currentComparisons).toHaveLength(6)
  })
})
