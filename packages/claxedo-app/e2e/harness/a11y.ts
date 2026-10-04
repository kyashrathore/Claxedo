import AxeBuilder from "@axe-core/playwright"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, type Page } from "@playwright/test"

export type Surface = "home" | "session-page" | "settings-surface" | "command-palette" | "prompt-input-focused"

const BASELINE = fileURLToPath(new URL("./a11y-baseline.json", import.meta.url))
const SETTLE_WITHIN_MS = 5_000

function endingAnimations(page: Page): Promise<number> {
  return page.evaluate((within) => {
    return document.getAnimations().filter((animation) => {
      const timing = animation.effect?.getComputedTiming()
      if (animation.playState !== "running" || !timing) return false
      return Number(timing.endTime) - Number(timing.localTime ?? 0) <= within
    }).length
  }, SETTLE_WITHIN_MS)
}

export async function settled(page: Page): Promise<void> {
  await expect.poll(() => endingAnimations(page), { message: "entry animations finish" }).toBe(0)
}

export async function expectWithinBaseline(page: Page, surface: Surface): Promise<void> {
  await settled(page)
  const allowed = (JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, readonly string[] | undefined>)[surface]
  expect(allowed, `a11y-baseline.json lists ${surface}`).toBeDefined()
  const results = await new AxeBuilder({ page }).analyze()
  const added = [...new Set(results.violations.map((violation) => violation.id))].filter((id) => !allowed?.includes(id))
  expect(added.map((id) => `${surface}: ${id}`)).toEqual([])
}
