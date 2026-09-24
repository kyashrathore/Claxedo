import AxeBuilder from "@axe-core/playwright"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, type Page } from "@playwright/test"

export type V1Surface = "home" | "session-page" | "settings-surface" | "command-palette" | "prompt-input-focused"

const V1_BASELINE = fileURLToPath(new URL("../../../claxedo-app/e2e/playwright/a11y-baseline.json", import.meta.url))
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

export async function expectNoAxeViolations(page: Page, screen: string): Promise<void> {
  await settled(page)
  const results = await new AxeBuilder({ page }).analyze()
  const found = results.violations.map((violation) => `${screen}: ${violation.id} ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)
  expect(found).toEqual([])
}

export async function expectWithinV1Baseline(page: Page, surface: V1Surface): Promise<void> {
  await settled(page)
  const allowed = (JSON.parse(readFileSync(V1_BASELINE, "utf8")) as Record<string, readonly string[] | undefined>)[surface]
  expect(allowed, `v1's a11y-baseline.json lists ${surface}`).toBeDefined()
  const results = await new AxeBuilder({ page }).analyze()
  const added = [...new Set(results.violations.map((violation) => violation.id))].filter((id) => !allowed?.includes(id))
  expect(added.map((id) => `${surface}: ${id}`)).toEqual([])
}
