import type { Page } from "@playwright/test"
import { acpScriptToken, expect, SCRIPTED_ACP_HARNESS, sessionRoute, test, UI, type Stack } from "../harness"

type Section = { readonly v1Row: string; readonly heading: string; readonly v2Link: string }

const GENERAL: Section = { v1Row: "General", heading: "General", v2Link: "Appearance" }
const TRANSCRIPT: Section = { v1Row: "General", heading: "General", v2Link: "General" }
const SHORTCUTS: Section = { v1Row: "Shortcuts", heading: "Keyboard shortcuts", v2Link: "Keyboard shortcuts" }
const MODELS: Section = { v1Row: "Models", heading: "Models", v2Link: "Models" }
const SECTIONS: readonly Section[] = [
  GENERAL,
  SHORTCUTS,
  { v1Row: "Orgs & Teams", heading: "Orgs & Teams", v2Link: "Organization" },
  MODELS,
  { v1Row: "Terminals", heading: "Terminals", v2Link: "Terminals" },
  { v1Row: "Machines", heading: "Machines", v2Link: "Machines" },
]
const V2_SETTINGS = "v2 approved: v2's settings sidebar and layout (DECISIONS Owner, 16:45)"

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

async function openSection(stack: Stack, app: Page, isMobile: boolean, section: Section) {
  await revealRail(app, isMobile)
  if (stack.app === "v2") {
    await test.step(V2_SETTINGS, async () => {
      await app.getByRole("link", { name: section.v2Link, exact: true }).click()
      await expect(app.getByRole("heading", { level: 1, name: section.v2Link })).toBeVisible()
    })
    return
  }
  await app.getByRole("button", { name: section.v1Row, exact: true }).click()
  await expect(app.getByRole("heading", { level: 1, name: section.heading })).toBeVisible()
}

async function openSettings(stack: Stack, app: Page, isMobile: boolean) {
  await revealRail(app, isMobile)
  await app.getByRole("button", { name: UI.signedOutAccount }).click()
  await app.getByRole("menuitem", { name: "Settings" }).click()
  if (stack.app === "v2") await openSection(stack, app, isMobile, GENERAL)
  else await expect(app.getByRole("heading", { level: 1, name: "General" })).toBeVisible()
}

test("15 settings: color scheme, a rebound shortcut and its reset, every section", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("settings", "Settings")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(stack, app, isMobile)
  const html = app.locator("html")
  await expect(html).toHaveAttribute("data-theme", "codex")
  await expect(picker(app, "Theme")).toHaveText("Codex")
  await choose(app, "Color scheme", "Dark")
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await app.goto(draft)
  await expect(html).toHaveAttribute("data-color-scheme", "dark")
  await openSettings(stack, app, isMobile)
  await expect(picker(app, "Color scheme")).toHaveText("Dark")
  await choose(app, "Color scheme", "Light")
  await expect(html).toHaveAttribute("data-color-scheme", "light")

  await openSection(stack, app, isMobile, SHORTCUTS)
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
  await openSettings(stack, app, isMobile)
  await openSection(stack, app, isMobile, SHORTCUTS)
  await expect(binding).toHaveText(rebound)
  await reset.click()
  await expect(app.getByText("Shortcuts reset")).toBeVisible()
  await expect(binding).toHaveText(original)
  await expect(reset).toBeDisabled()

  for (const section of SECTIONS) {
    await openSection(stack, app, isMobile, section)
    expect(await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }

  await app.goto(draft)
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  await app.keyboard.press("ControlOrMeta+Shift+KeyP")
  await expect(palette).toBeVisible()
})

test("15 settings: Expand shell tool parts opens a turn's shell output in the transcript", async ({ stack, api, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("transcript-settings")
  await stack.acp.write("shell", {
    steps: [
      { kind: "tool", tool: "execute", title: "git status", input: { command: "git status" }, text: "shell-output-clean" },
      { kind: "tool", tool: "read", title: "Read README.md", locations: [{ path: `${workspace.directory}/README.md` }], text: "readme\n" },
      { kind: "text", text: "The shell ran" },
    ],
  })
  const session = await api.createSession(workspace.directory, { title: "Shell", harness: SCRIPTED_ACP_HARNESS })
  await api.prompt(workspace.directory, session.id, `Run it. ${acpScriptToken("shell")}`)
  const route = `${stack.url}${sessionRoute(workspace.id, session.id)}`
  await app.goto(route)
  await openSettings(stack, app, isMobile)
  await openSection(stack, app, isMobile, TRANSCRIPT)
  const toggle = app.locator('[data-action="settings-feed-shell-tool-parts-expanded"]')
  await expect(toggle.getByRole("switch")).not.toBeChecked()
  await toggle.click()
  await expect(toggle.getByRole("switch")).toBeChecked()
  await app.goto(route)
  await expect(app.getByText("The shell ran")).toBeVisible()
  await app.getByRole("button", { name: UI.workedFor }).click()
  await expect(app.getByText("shell-output-clean")).toBeVisible()
})

test("15 settings: a code font applies at once, and the files navigator side is kept", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("appearance-settings")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(stack, app, isMobile)
  await app.locator('[data-action="settings-code-font"]').first().fill("Courier New")
  await expect.poll(() => app.evaluate(() => document.documentElement.style.getPropertyValue("--font-family-mono"))).toContain('"Courier New"')
  await app.locator('[data-action="settings-navigator-side"]').first().click()
  await app.getByRole("option", { name: "Left", exact: true }).click()
  await app.goto(draft)
  await openSettings(stack, app, isMobile)
  await expect(app.locator('[data-action="settings-navigator-side"]').first()).toContainText("Left")
  await expect(app.locator('[data-action="settings-code-font"]').first()).toHaveValue("Courier New")
})

test("15 settings: Models lists each agent's accounts and this computer's logins", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("models", "Models")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(stack, app, isMobile)
  await openSection(stack, app, isMobile, MODELS)
  const claude = app.getByRole("radiogroup", { name: "Claude Code" })
  const claudeMachineLogin = claude.getByRole("radio", { name: /^This computer's login/ })
  const storedClaudeKey = (await credentials(stack.url)).some((row) => row.provider_id === "anthropic" && row.is_active)
  if (storedClaudeKey) {
    await expect(claudeMachineLogin).not.toBeChecked()
    await expect(claude.getByRole("radio", { checked: true })).toHaveCount(1)
  } else {
    await expect(claudeMachineLogin).toBeChecked()
  }
  const section = app.locator('[data-component^="models-section-"]').filter({ has: app.getByRole("heading", { level: 2, name: "Cursor", exact: true }) })
  const cursor = app.getByRole("radiogroup", { name: "Cursor" })
  const machineLogin = cursor.getByRole("radio", { name: /^This computer's login/ })
  await expect(machineLogin).toBeChecked()

  const addKey = async (label: string) => {
    await section.getByRole("button", { name: "Add an account" }).click()
    const dialog = app.getByRole("dialog").filter({ hasText: "Connect Cursor" })
    await dialog.getByRole("textbox", { name: "Cursor API key" }).fill(`cursor-key-${label.replaceAll(" ", "-")}`)
    await dialog.getByRole("textbox", { name: "Label" }).fill(label)
    await dialog.getByRole("button", { name: "Continue" }).click()
    await expect(dialog).toHaveCount(0)
  }
  const row = (label: string) => cursor.locator('[data-component="agent-account"]').filter({ hasText: label })
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
    await row(label).getByRole("button", { name: "Remove", exact: true }).click()
    await row(label).getByRole("button", { name: "Remove", exact: true }).click()
    await expect(cursor.getByRole("radio", { name: new RegExp(`^${label}`) })).toHaveCount(0)
    await expect.poll(async () => credentialNamed(stack.url, label)).toBeUndefined()
  }
  await expect(machineLogin).toBeChecked()
  await expect(machineLogin).toBeEnabled()
})

async function claudeModels(app: Page) {
  await expect(app.getByRole("textbox", { name: UI.composer })).toBeVisible()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  await expect(async () => {
    if (!(await picker.isVisible())) await app.getByRole("button", { name: /^Select harness and model/ }).click()
    const harness = picker.getByRole("button", { name: /^Harness/ })
    if (!((await harness.textContent({ timeout: 2000 })) ?? "").includes("Claude Code")) {
      if (!(await picker.getByText(/^Claude Code/).first().isVisible())) await harness.click()
      await picker.getByText(/^Claude Code/).first().click()
    }
    const models = picker.getByRole("button", { name: /^Model/ })
    if ((await models.getAttribute("aria-expanded", { timeout: 2000 })) !== "true") await models.click()
    await expect(picker.getByText("Sonnet", { exact: true }).first()).toBeVisible({ timeout: 2000 })
  }).toPass()
  return picker
}

test("15 settings: a model switched off in Models leaves the composer's picker", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("picker", "Picker")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  await openSettings(stack, app, isMobile)
  await openSection(stack, app, isMobile, MODELS)
  const claude = app.locator('[data-component="models-section-claude"]')
  await claude.getByRole("tab", { name: "Models" }).click()
  const haiku = claude.getByRole("switch", { name: "Haiku" })
  await expect(haiku).toBeChecked()
  await haiku.click({ force: true })
  await expect(haiku).not.toBeChecked()

  await app.goto(draft)
  let picker = await claudeModels(app)
  await expect(picker.getByText("Haiku", { exact: true })).toHaveCount(0)
  await app.keyboard.press("Escape")

  await openSettings(stack, app, isMobile)
  await openSection(stack, app, isMobile, MODELS)
  await claude.getByRole("tab", { name: "Models" }).click()
  await haiku.click({ force: true })
  await expect(haiku).toBeChecked()
  await app.goto(draft)
  picker = await claudeModels(app)
  await expect(picker.getByText("Haiku", { exact: true }).first()).toBeVisible()
})
