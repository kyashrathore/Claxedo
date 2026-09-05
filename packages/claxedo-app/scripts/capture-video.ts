import type { BrowserContext, Page } from "playwright-core"

/** Close the page and its context, then move the recorded video to `target`. */
export async function closeContextAndSaveVideo(context: BrowserContext, page: Page, target: string) {
  const video = page.video()
  await page.close().catch(() => {})
  await context.close().catch(() => {})
  const raw = video ? await video.path().catch(() => undefined) : undefined
  if (!raw) return undefined
  await Bun.$`mv ${raw} ${target}`
  return target
}
