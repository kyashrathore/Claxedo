import type { Page } from "@playwright/test"
import { expect, UI } from "./index"

export async function sidebarSectionFilter(app: Page, touch: boolean): Promise<void> {
  const trigger = app.getByRole("button", { name: "Session options", exact: true })
  const header = app.locator('[data-slot="session-sidebar-heading"]')
  await expect(header.getByRole("button", { name: "Session options", exact: true })).toHaveCount(1)
  expect(await trigger.evaluate((element) => !!element.closest('[data-slot="session-sidebar-heading"]'))).toBe(true)
  await expect(app.locator("[data-sidebar-header]").getByRole("button", { name: "Session options", exact: true })).toHaveCount(0)
  const box = await trigger.boundingBox()
  const frame = await header.boundingBox()
  expect(box!.x + box!.width).toBeGreaterThanOrEqual(frame!.x + frame!.width - 16)
  expect(box!.y).toBeLessThanOrEqual(frame!.y + 5)
  if (touch) {
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
}

export async function coarseFilterChoices(app: Page): Promise<void> {
  await app.getByRole("button", { name: "Session options", exact: true }).click()
  for (const choice of ["Projects", "Activity"]) {
    const option = app.getByRole("menuitemradio", { name: choice, exact: true })
    await expect.poll(async () => (await option.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    const box = await option.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
  await app.getByRole("menu").press("Escape")
}

export async function coarseFooterTargets(app: Page): Promise<void> {
  for (const name of [UI.signedOutAccount, "Usage", "Open Tasks", "Open Marketplace"]) {
    const box = await app.getByRole("button", { name, exact: true }).boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  }
}


export async function shortActivityViewport(app: Page): Promise<void> {
  await app.setViewportSize({ width: 1024, height: 350 })
  const area = app.getByTestId("activity-sidebar")
  await expect(area.getByRole("region", { name: "Activity", exact: true })).toBeVisible()
  await expect.poll(() => area.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(44)
  await coarseFooterTargets(app)
}
