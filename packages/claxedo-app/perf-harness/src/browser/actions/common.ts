import type { BrowserTarget } from "../environment"
import type { fixtureFor } from "../fixtures"
import type { Page } from "playwright-core"

export function roundMs(value: number) {
  return Math.round(value * 100) / 100
}

export async function launchTo(page: Page, app: BrowserTarget, pathName: string) {
  const started = performance.now()
  await page.goto(`${app.baseUrl}${pathName}`, { waitUntil: "domcontentloaded" })
  const domContentLoaded = performance.now() - started
  await waitForUsefulScreen(page)
  const useful = performance.now() - started
  await waitForLaunchStable(page)
  const ready = performance.now() - started
  return { domContentLoaded, useful, ready }
}

export async function waitForLaunchStable(page: Page) {
  await page.evaluate(() =>
    new Promise<void>((resolve) => {
      const ready = document.fonts?.ready?.catch(() => undefined) ?? Promise.resolve()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            void ready.then(() => resolve())
          })
        })
      })
    }),
  )
}

export async function waitForUsefulScreen(page: Page) {
  await page.waitForFunction(() => {
    if (document.body?.innerText.trim()) return true
    const root = document.querySelector("#root") ?? document.body
    const visible = (el: Element) => {
      if (el.closest("[aria-hidden='true']")) return false
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden"
    }
    return Array.from(root.querySelectorAll("button, input, textarea, [role], [data-component], [data-testid], a, main, aside, nav"))
      .some(visible)
  }, undefined, { timeout: 30_000 })
}

export async function waitForText(page: Page, text: string, timeout: number) {
  await page.waitForFunction(
    (expected) => document.body.textContent?.includes(expected) ?? false,
    text,
    { timeout },
  ).catch(() => undefined)
}

export async function countTitlesInBody(page: Page, titles: string[]) {
  return await page.evaluate((titles) => {
    const text = document.body.textContent ?? ""
    return titles.filter((title) => text.includes(title)).length
  }, titles).catch(() => 0)
}

export function recordVisualFailure(fixture: ReturnType<typeof fixtureFor>, message: string) {
  if (!fixture.visualFailures.includes(message)) fixture.visualFailures.push(message)
}

export async function settleForVideo(page: Page) {
  await waitForAnimationFrame(page, 2)
  await page.waitForTimeout(250)
}

export async function waitForAnimationFrame(page: Page, count: number) {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (remaining: number) => {
          if (remaining <= 0) {
            resolve()
            return
          }
          requestAnimationFrame(() => step(remaining - 1))
        }
        step(count)
      }),
    count,
  )
}
