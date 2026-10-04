import type { Page } from "@playwright/test"
import { expect, expectNothingAnimating, UI } from "../harness"

export type Section = "Appearance" | "Keyboard shortcuts" | "Organization" | "Models" | "Machines" | "Connections" | "Usage"

export const SECTIONS: readonly Section[] = ["Appearance", "Keyboard shortcuts", "Organization", "Models", "Machines"]

export function picker(app: Page, label: string) {
  return app.getByRole("group", { name: label }).getByRole("button")
}

export async function choose(app: Page, label: string, option: string) {
  await picker(app, label).click()
  await app.getByRole("option", { name: option, exact: true }).click()
}

export async function revealRail(app: Page, isMobile: boolean) {
  if (!isMobile) return
  const open = app.getByRole("button", { name: UI.openRail })
  if (await open.isVisible()) await open.click()
}

async function showSettingsNav(app: Page, isMobile: boolean) {
  const nav = app.getByRole("group", { name: "App" })
  await expect(async () => {
    await expectNothingAnimating(app)
    const open = app.getByRole("button", { name: UI.openRail })
    if (isMobile && (await open.isVisible())) await open.click()
    await expect(nav).toBeInViewport({ ratio: 1, timeout: 1000 })
  }).toPass()
}

export async function openSection(app: Page, isMobile: boolean, section: Section) {
  await showSettingsNav(app, isMobile)
  await app.getByRole("link", { name: section, exact: true }).click()
  await expect(app.getByRole("heading", { level: 1, name: section })).toBeVisible()
}

export async function leaveSettings(app: Page, isMobile: boolean) {
  await showSettingsNav(app, isMobile)
  await app.getByRole("link", { name: "Back", exact: true }).click()
  await expect(app.getByTestId("settings-sidebar")).toHaveCount(0)
}

export async function openSettings(app: Page, isMobile: boolean) {
  await revealRail(app, isMobile)
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await app.getByRole("menuitem", { name: "Settings" }).click()
  await openSection(app, isMobile, "Appearance")
}
