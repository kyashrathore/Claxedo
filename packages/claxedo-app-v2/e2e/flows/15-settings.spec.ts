import type { Page } from "@playwright/test"
import { expect, test } from "../harness"

function picker(app: Page, label: string) {
  return app.getByRole("group", { name: label }).getByRole("button")
}

async function choose(app: Page, label: string, option: string): Promise<void> {
  await picker(app, label).click()
  await app.getByRole("option", { name: option, exact: true }).click()
}

const SECTIONS = [
  ["accounts", "Accounts"],
  ["usage", "Usage"],
  ["organization", "Organization"],
  ["connections", "Connections"],
  ["appearance", "Appearance"],
  ["keybindings", "Keyboard shortcuts"],
] as const

test("15 settings: theme and keyboard shortcuts", async ({ stack, app }) => {
  test.skip(stack.app === "v1", "the v1 path of this baseline flow is not written yet")
  await app.goto(`${stack.url}/settings/appearance`)
  await expect(app.getByRole("heading", { level: 1, name: "Appearance" })).toBeVisible()
  const html = app.locator("html")

  await expect(html).toHaveAttribute("data-theme", "claxedo")
  await expect(picker(app, "Theme")).toHaveText("Claxedo")
  await choose(app, "Color scheme", "Dark")
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await app.reload()
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await expect(picker(app, "Color scheme")).toHaveText("Dark")
  await choose(app, "Color scheme", "Light")
  await expect(html).toHaveAttribute("data-color-scheme", "light")

  await app.goto(`${stack.url}/settings/keybindings`)
  await expect(app.getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeVisible()
  const palette = app.getByRole("button", { name: /^Command palette: / })
  await palette.click()
  await expect(palette).toHaveAttribute("aria-pressed", "true")
  await app.keyboard.press("ControlOrMeta+Alt+KeyK")
  await expect(palette).toHaveAttribute("aria-pressed", "false")
  await expect(palette).not.toHaveAccessibleName(/⇧P|Shift\+P/)

  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: "Command palette" })).toHaveCount(0)
  await app.keyboard.press("ControlOrMeta+Alt+KeyK")
  await expect(app.getByRole("dialog", { name: "Command palette" })).toBeVisible()
  await app.keyboard.press("Escape")

  await app.reload()
  await expect(app.getByRole("button", { name: /^Command palette: / })).not.toHaveAccessibleName(/⇧P|Shift\+P/)
  await app.getByRole("button", { name: "Reset to defaults" }).click()
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(app.getByRole("dialog", { name: "Command palette" })).toBeVisible()

  for (const [path, heading] of SECTIONS) {
    await app.goto(`${stack.url}/settings/${path}`)
    await expect(app.getByRole("heading", { level: 1, name: heading })).toBeVisible()
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})
