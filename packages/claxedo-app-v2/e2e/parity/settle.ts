import type { Page } from "@playwright/test"

const FRAME_GAP_MS = 250
const MAX_FRAMES = 16

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function settledShot(page: Page): Promise<Buffer> {
  await page.waitForLoadState("load")
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  let previous = await page.screenshot({ animations: "disabled" })
  for (let frame = 0; frame < MAX_FRAMES; frame += 1) {
    await pause(FRAME_GAP_MS)
    const next = await page.screenshot({ animations: "disabled" })
    if (next.equals(previous)) return next
    previous = next
  }
  return previous
}
