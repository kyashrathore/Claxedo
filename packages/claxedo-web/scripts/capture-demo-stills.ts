import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"

/**
 * Captures the home page demo in each story state for the reduced-motion page,
 * which shows these stills instead of the pinned, scroll-driven demo.
 * Run against a dev or preview server after the demo changes (the dev toolbar is removed first):
 *   bun scripts/capture-demo-stills.ts http://127.0.0.1:4321
 */
const origin = process.argv[2] ?? "http://127.0.0.1:4321"
const out = new URL("../public/home/", import.meta.url)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
for (const scheme of ["dark", "light"] as const) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
  await page.goto(origin, { waitUntil: "networkidle" })
  await page.evaluate(() => {
    document.querySelector("astro-dev-toolbar")?.remove()
    return document.fonts.ready
  })
  const ids = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-stage-line]"), (line) => line.dataset.stageLine!))
  await page.evaluate(() => scrollTo({ top: innerHeight * 0.9 * 0.99, behavior: "instant" }))
  await page.waitForTimeout(400)
  for (const id of ids) {
    await page.evaluate((spot) => {
      const demo = document.querySelector("[data-demo]")!
      demo.dispatchEvent(new CustomEvent("demo:spot", { detail: { spot, open: true } }))
      demo.dispatchEvent(new CustomEvent("demo:progress", { detail: { spot, progress: 1 } }))
      delete (demo as HTMLElement).dataset.spot
    }, id)
    await page.waitForTimeout(450)
    await page.locator("[data-app-replica]").screenshot({ path: new URL(`demo-${id}-${scheme}.jpg`, out).pathname, type: "jpeg", quality: 80 })
  }
  await page.close()
}
await browser.close()
