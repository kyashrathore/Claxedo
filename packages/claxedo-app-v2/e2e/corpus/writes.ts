import type { Page } from "@playwright/test"
import { expect, type AppChoice } from "../harness"

export type WriteScope = "thumb" | "timeline"

const SCOPES: Record<WriteScope, string> = {
  thumb: '[data-slot="session-timeline-scroll"] > [data-visible]',
  timeline: '[data-slot="session-screen-timeline"]',
}

const COUNTER = "__corpusWrites"

export async function watchWrites(app: Page, appChoice: AppChoice, scope: WriteScope) {
  if (appChoice === "v1") return
  const watched = await app.evaluate(
    ({ selector, counter }) => {
      const target = document.querySelector(selector)
      if (!target) return false
      const record = { count: 0 }
      Object.assign(window, { [counter]: record })
      new MutationObserver((list) => (record.count += list.length)).observe(target, { subtree: true, attributes: true, childList: true, characterData: true })
      return true
    },
    { selector: SCOPES[scope], counter: COUNTER },
  )
  expect(watched, `the ${scope} is on the page to watch`).toBe(true)
}

export async function expectWritesAtMost(app: Page, appChoice: AppChoice, max: number) {
  if (appChoice === "v1") return
  const count = await app.evaluate((counter) => (window as unknown as Record<string, { count: number } | undefined>)[counter]?.count, COUNTER)
  if (count === undefined) throw new Error("writesAtMost needs a watchWrites interaction before it")
  expect(count, "DOM writes in the watched region").toBeLessThanOrEqual(max)
}
