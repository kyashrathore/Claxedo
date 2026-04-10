import { test, expect, type Page } from "@playwright/test"

const DIR = process.env.PLAYWRIGHT_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"
const LIVE = process.env.PLAYWRIGHT_LIVE_TERMINAL === "1"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function paint(page: Page) {
  return await page.evaluate(() => {
    const root = document.querySelector('[data-component="terminal"]')
    if (!(root instanceof HTMLElement)) return false
    const host = root.querySelector(".xterm")
    const canvas = root.querySelector(".xterm-screen canvas")
    if (!(host instanceof HTMLElement)) return false
    if (!(canvas instanceof HTMLCanvasElement)) return false
    const rect = host.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
}

async function more(page: Page, item: string) {
  await page.locator("[data-component='workspace-more-menu']").first().click()
  const option = page.getByRole("menuitem", { name: item }).first()
  if (await option.isVisible().catch(() => false)) {
    await option.click()
    return
  }
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
}

test.describe("Terminal reactivation smoke", () => {
  test.skip(!LIVE, "Set PLAYWRIGHT_LIVE_TERMINAL=1 with a live claxedo backend to run terminal paint smoke tests")

  test("keeps terminal paintable after tab reactivation", async ({ page }) => {
    await page.goto(`/${slug(DIR)}/session`)
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    if (!await page.locator('[data-component="terminal"]').first().isVisible().catch(() => false)) {
      await more(page, "New Terminal")
    }

    await expect.poll(() => paint(page), { timeout: 40_000 }).toBe(true)
    await page.locator('[data-component="terminal"]').first().click()
    await page.keyboard.type("echo __playwright_reactivation__")
    await page.keyboard.press("Enter")

    await more(page, "New Terminal")
    await page.locator("[data-tab-id]").filter({ hasText: /Terminal|Claude|Codex/i }).first().click()
    await expect.poll(() => paint(page), { timeout: 20_000 }).toBe(true)

    await page.evaluate(() => window.dispatchEvent(new Event("resize")))
    await expect.poll(() => paint(page), { timeout: 20_000 }).toBe(true)
  })
})
