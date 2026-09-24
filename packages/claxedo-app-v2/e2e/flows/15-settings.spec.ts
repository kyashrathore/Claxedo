import type { Page } from "@playwright/test"
import { expect, sessionRoute, test, UI } from "../harness"

const SECTIONS = [
  ["General", "General"],
  ["Shortcuts", "Keyboard shortcuts"],
  ["Terminals", "Terminals"],
  ["Machines", "Machines"],
  ["Orgs & Teams", "Orgs & Teams"],
  ["Models", "Models"],
] as const

function picker(app: Page, label: string) {
  return app.getByRole("group", { name: label }).getByRole("button")
}

async function choose(app: Page, label: string, option: string) {
  await picker(app, label).click()
  await app.getByRole("option", { name: option, exact: true }).click()
}

type Credential = { readonly id: string; readonly provider_id: string; readonly label?: string; readonly is_active?: boolean }

async function credentials(url: string): Promise<readonly Credential[]> {
  const response = await fetch(new URL("/api/claxedo/credentials", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { readonly credentials: readonly Credential[] }).credentials
}

async function credentialNamed(url: string, label: string): Promise<Credential | undefined> {
  return (await credentials(url)).find((row) => row.provider_id === "cursor-sdk" && row.label === label)
}

async function revealRail(app: Page, isMobile: boolean) {
  if (isMobile) await app.getByRole("button", { name: UI.openRail }).click()
}

async function openSettings(app: Page, isMobile: boolean) {
  await revealRail(app, isMobile)
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await app.getByRole("menuitem", { name: "Settings" }).click()
  await expect(app.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
}

async function openSection(app: Page, isMobile: boolean, row: string, heading: string) {
  await revealRail(app, isMobile)
  await app.getByRole("button", { name: row, exact: true }).click()
  await expect(app.getByRole("heading", { level: 1, name: heading })).toBeVisible()
}

test("15 settings: color scheme, a rebound shortcut and its reset, every section", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("settings", "Settings")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(app, isMobile)
  const html = app.locator("html")
  await expect(html).toHaveAttribute("data-theme", "codex")
  await expect(picker(app, "Theme")).toHaveText("Codex")
  await choose(app, "Color scheme", "Dark")
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await app.goto(draft)
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await openSettings(app, isMobile)
  await expect(picker(app, "Color scheme")).toHaveText("Dark")
  await choose(app, "Color scheme", "Light")
  await expect(html).toHaveAttribute("data-color-scheme", "light")

  await openSection(app, isMobile, "Shortcuts", "Keyboard shortcuts")
  const reset = app.getByRole("button", { name: "Reset to defaults" })
  const binding = app.locator('[data-keybind-id="command.palette"]')
  const original = (await binding.textContent()) ?? ""
  await expect(reset).toBeDisabled()
  await binding.click()
  await expect(binding).toHaveText("Press keys")
  await app.keyboard.press("ControlOrMeta+Alt+KeyK")
  await expect(binding).not.toHaveText("Press keys")
  await expect(binding).not.toHaveText(original)
  const rebound = (await binding.textContent()) ?? ""
  await expect(reset).toBeEnabled()

  await app.goto(draft)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const palette = app.getByRole("dialog", { name: UI.palette })
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(palette).toHaveCount(0)
  await app.keyboard.press("ControlOrMeta+Alt+KeyK")
  await expect(palette).toBeVisible()
  await app.keyboard.press("Escape")
  await expect(palette).toHaveCount(0)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Shortcuts", "Keyboard shortcuts")
  await expect(binding).toHaveText(rebound)
  await reset.click()
  await expect(app.getByText("Shortcuts reset")).toBeVisible()
  await expect(binding).toHaveText(original)
  await expect(reset).toBeDisabled()

  for (const [row, heading] of SECTIONS) {
    await openSection(app, isMobile, row, heading)
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }

  await app.goto(draft)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(palette).toBeVisible()
})

test("15 settings: accounts per agent and this computer's logins", async ({ stack, app }) => {
  test.skip(stack.app === "v1", "the v1 path of this baseline flow is not written yet")
  await app.goto(`${stack.url}/settings/accounts`)
  await expect(app.getByRole("heading", { level: 1, name: "Accounts" })).toBeVisible()
  await expect(app.getByRole("radiogroup", { name: "Claude Code" }).getByRole("radio", { name: "This computer's login" })).toBeChecked()
  const card = app.getByRole("group", { name: "Cursor" })
  const cursor = app.getByRole("radiogroup", { name: "Cursor" })
  const machineLogin = cursor.getByRole("radio", { name: /^This computer's login/ })
  await expect(machineLogin).toBeChecked()

  const addKey = async (label: string) => {
    await card.getByRole("button", { name: "Add an API key" }).click()
    const form = card.getByRole("form", { name: "Add an API key" })
    await form.getByRole("textbox", { name: "Name" }).fill(label)
    await form.getByLabel("API key").fill(`cursor-key-${label.replaceAll(" ", "-")}`)
    await form.getByRole("button", { name: "Save key" }).click()
    await expect(form).toHaveCount(0)
  }
  const first = cursor.getByRole("radio", { name: /^Flow fifteen A/ })
  const second = cursor.getByRole("radio", { name: /^Flow fifteen B/ })
  await addKey("Flow fifteen A")
  await expect(first).toBeChecked()
  await expect(machineLogin).toBeDisabled()
  await addKey("Flow fifteen B")
  await expect(second).not.toBeChecked()
  await expect.poll(async () => (await credentialNamed(stack.url, "Flow fifteen B"))?.is_active).toBe(false)

  await cursor.getByText("Flow fifteen B", { exact: true }).click()
  await expect(second).toBeChecked()
  await expect(first).not.toBeChecked()
  await expect.poll(async () => (await credentialNamed(stack.url, "Flow fifteen B"))?.is_active).toBe(true)
  expect((await credentialNamed(stack.url, "Flow fifteen A"))?.is_active).toBe(false)

  for (const label of ["Flow fifteen B", "Flow fifteen A"]) {
    await cursor.getByRole("button", { name: `Remove ${label}` }).click()
    await cursor.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(cursor.getByRole("radio", { name: new RegExp(`^${label}`) })).toHaveCount(0)
    await expect.poll(async () => credentialNamed(stack.url, label)).toBeUndefined()
  }
  await expect(machineLogin).toBeChecked()
  await expect(machineLogin).toBeEnabled()
})
