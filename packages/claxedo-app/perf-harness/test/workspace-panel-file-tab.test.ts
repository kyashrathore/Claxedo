import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser } from "playwright-core"
import { FILE_TAB_SELECTOR, fileTabActivator } from "../src/public-workspace-panel"

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  await browser.close()
})

const TAB = `
  <div data-slot="workspace-tab" data-workspace-tab-kind="file">
    <button type="button" onclick="window.tabActivated = true">README.md</button>
    <div><div data-testid="workspace-tab-close"><button type="button" aria-label="Close README.md tab" onclick="window.tabClosed = true">x</button></div></div>
  </div>
`

test("a file tab's activator is its own button, not the close button inside it", async () => {
  const page = await browser.newPage()
  await page.setContent(TAB)
  await fileTabActivator(page.locator(FILE_TAB_SELECTOR).nth(0)).click({ timeout: 2_000 })
  expect(await page.evaluate(() => [Reflect.get(window, "tabActivated"), Reflect.get(window, "tabClosed")])).toEqual([true, undefined])
  await page.close()
}, 30_000)
