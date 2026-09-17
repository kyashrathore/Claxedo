import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import { globToRegexPattern } from "../../src/architecture/mock-route-shadowing"

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

test("the static route matcher agrees with actual Playwright interception", async () => {
  const cases: Array<[string, string, boolean]> = [
    ["**/session/*", "http://routes.test/session/status", true],
    ["**/session/*", "http://routes.test/session/ses_a/config", false],
    ["**/session/status**", "http://routes.test/session/status?directory=%2Ftmp", true],
    ["**/session/status", "http://routes.test/session/status?directory=%2Ftmp", false],
    ["**/events?**", "http://routes.test/wr/events?x=1", true],
    ["**/wr/events?**", "http://routes.test/events?x=1", false],
    ["**/api/claxedo/agent-config/harness**", "http://routes.test/api/claxedo/agent-config/harness/options", true],
  ]
  const page = await browser.newPage()
  try {
    for (const [pattern, url, expected] of cases) {
      await page.route("**/*", (route) => route.fulfill({ body: "unmatched" }))
      await page.route(pattern, (route) => route.fulfill({ body: "matched" }))
      const response = await page.goto(url)
      expect(await response!.text()).toBe(expected ? "matched" : "unmatched")
      expect(new RegExp(globToRegexPattern(pattern)).test(url)).toBe(expected)
      await page.unrouteAll({ behavior: "wait" })
    }
  } finally {
    await page.close()
  }
})
