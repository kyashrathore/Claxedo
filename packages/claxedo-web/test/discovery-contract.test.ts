import { describe, expect, test } from "bun:test"
import { currentComparisons } from "../src/content/competitors"
import { routes } from "../src/content/routes"

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

  test("publishes the agent runtime study to answer-engine discovery", async () => {
    const source = await Bun.file(new URL("../src/pages/llms.txt.ts", import.meta.url)).text()
    expect(source).toContain("Agent runtime study")
    expect(source).toContain("routes.agentRuntimeStudy")
    expect(routes.agentRuntimeStudy).toBe("/how-often-do-coding-agents-need-a-full-machine")
  })
})
