import type { Page } from "@playwright/test"
import { expect, test } from "../harness"

function picker(app: Page, label: string) {
  return app.getByRole("group", { name: label }).getByRole("button")
}

async function choose(app: Page, label: string, option: string): Promise<void> {
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
