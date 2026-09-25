import type { Page } from "@playwright/test"
import { expect, test, UI, type Stack } from "../harness"

export type Section = { readonly v1Row: string; readonly heading: string; readonly v2Link?: string; readonly v2Step?: string }

const V2_SETTINGS = "v2 approved: v2's settings sidebar and layout (DECISIONS Owner, 16:45)"
const NO_GENERAL = "v2 approved: no General section; its rows live in Language and Appearance (DECISIONS Owner, 00:55)"
export const GENERAL: Section = { v1Row: "General", heading: "General", v2Link: "Appearance", v2Step: NO_GENERAL }
export const SHORTCUTS: Section = { v1Row: "Shortcuts", heading: "Keyboard shortcuts", v2Link: "Keyboard shortcuts" }
export const MODELS: Section = { v1Row: "Models", heading: "Models", v2Link: "Models" }
export const SECTIONS: readonly Section[] = [
  GENERAL,
  SHORTCUTS,
  { v1Row: "Orgs & Teams", heading: "Orgs & Teams", v2Link: "Organization" },
  MODELS,
  { v1Row: "Terminals", heading: "Terminals", v2Step: "v2 approved: no Terminals section (DECISIONS Owner, 00:50)" },
  { v1Row: "Machines", heading: "Machines", v2Link: "Machines" },
]
export function picker(app: Page, label: string) {
  return app.getByRole("group", { name: label }).getByRole("button")
}

export async function choose(app: Page, label: string, option: string) {
  await picker(app, label).click()
  await app.getByRole("option", { name: option, exact: true }).click()
}

export async function revealRail(stack: Stack, app: Page, isMobile: boolean) {
  if (!isMobile) return
  const open = app.getByRole("button", { name: UI.openRail })
  if (stack.app === "v1" || (await open.isVisible())) await open.click()
}

async function showSettingsNav(app: Page, isMobile: boolean) {
  const nav = app.getByRole("group", { name: "App" })
  await expect(async () => {
    const open = app.getByRole("button", { name: UI.openRail })
    if (isMobile && (await open.isVisible())) await open.click()
    await expect(nav).toBeInViewport({ timeout: 1000 })
  }).toPass()
}

export async function openSection(stack: Stack, app: Page, isMobile: boolean, section: Section) {
  if (stack.app === "v2") {
    const link = section.v2Link
    await test.step(section.v2Step ?? V2_SETTINGS, async () => {
      await showSettingsNav(app, isMobile)
      if (!link) {
        await expect(app.getByRole("link", { name: section.v1Row, exact: true })).toHaveCount(0)
        return
      }
      await app.getByRole("link", { name: link, exact: true }).click()
      await expect(app.getByRole("heading", { level: 1, name: link })).toBeVisible()
    })
    return
  }
  await revealRail(stack, app, isMobile)
  await app.getByRole("button", { name: section.v1Row, exact: true }).click()
  await expect(app.getByRole("heading", { level: 1, name: section.heading })).toBeVisible()
}

export async function openSettings(stack: Stack, app: Page, isMobile: boolean) {
  await revealRail(stack, app, isMobile)
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await app.getByRole("menuitem", { name: "Settings" }).click()
  if (stack.app === "v2") await openSection(stack, app, isMobile, GENERAL)
  else await expect(app.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
}
