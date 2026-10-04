import type { Page } from "@playwright/test"
import { apiRequests, expect, sessionRoute, test, type Stack } from "../harness"
import { openSection, openSettings } from "./15-settings.navigation"

type Credential = { readonly id: string; readonly provider_id: string; readonly label?: string; readonly is_active?: boolean }

async function credentials(url: string): Promise<readonly Credential[]> {
  const response = await fetch(new URL("/api/claxedo/credentials", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { readonly credentials: readonly Credential[] }).credentials
}

async function credentialNamed(url: string, label: string): Promise<Credential | undefined> {
  return (await credentials(url)).find((row) => row.provider_id === "cursor-sdk" && row.label === label)
}

test("15 settings: accounts can be connected before any workspace exists", async ({ stack, app }) => {
  const projects = await fetch(new URL("/api/claxedo/projects", stack.url))
  expect(projects.status).toBe(200)
  expect(await projects.json()).toMatchObject({ projects: [] })
  await app.goto(`${stack.url}/settings/models`)
  const cursor = harnessSection(app, "Cursor")
  await cursor.getByRole("button", { name: "Add an account" }).click()
  const dialog = app.getByRole("dialog").filter({ hasText: "Connect Cursor" })
  await dialog.getByRole("textbox", { name: "Cursor API key" }).fill("cursor-key-before-workspace")
  await dialog.getByRole("textbox", { name: "Label" }).fill("Before workspace")
  await dialog.getByRole("button", { name: "Continue" }).click()
  await expect(dialog).toHaveCount(0)
  await expect(cursor.getByRole("radio", { name: /^Before workspace/ })).toBeVisible()
  expect(await credentialNamed(stack.url, "Before workspace")).toBeDefined()
  await cursor.getByRole("tab", { name: "Models" }).click()
  await expect(cursor.getByText("Open a workspace to discover this harness's models. Your connected accounts are available in the Accounts tab.")).toBeVisible()
  await cursor.getByRole("tab", { name: "Accounts" }).click()
  await expect(cursor.getByRole("radio", { name: /^Before workspace/ })).toBeVisible()
})

test("15 settings: Models lists each agent's accounts and this computer's logins", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("models", "Models")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Models")
  const claude = app.getByRole("radiogroup", { name: "Claude Code" })
  const claudeMachineLogin = claude.getByRole("radio", { name: /^Login on / })
  const storedClaudeKey = (await credentials(stack.url)).some((row) => row.provider_id === "anthropic" && row.is_active)
  if (storedClaudeKey) {
    await expect(claudeMachineLogin).not.toBeChecked()
    await expect(claude.getByRole("radio", { checked: true })).toHaveCount(1)
  } else {
    await expect(claudeMachineLogin).toBeChecked()
  }
  const section = harnessSection(app, "Cursor")
  const cursor = app.getByRole("radiogroup", { name: "Cursor" })
  const machineLogin = cursor.getByRole("radio", { name: /^Login on / })
  await expect(machineLogin).toBeChecked()

  const addKey = async (label: string) => {
    await section.getByRole("button", { name: "Add an account" }).click()
    const dialog = app.getByRole("dialog").filter({ hasText: "Connect Cursor" })
    await dialog.getByRole("textbox", { name: "Cursor API key" }).fill(`cursor-key-${label.replaceAll(" ", "-")}`)
    await dialog.getByRole("textbox", { name: "Label" }).fill(label)
    await dialog.getByRole("button", { name: "Continue" }).click()
    await expect(dialog).toHaveCount(0)
  }
  const row = (label: string) => cursor.locator('[data-slot="account-row"]').filter({ hasText: label })
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

function harnessSection(app: Page, name: string) {
  return app.locator("section").filter({ has: app.getByRole("heading", { level: 2, name, exact: true }) }).last()
}

async function claudeModels(app: Page) {
  const trigger = app.getByRole("button", { name: /^Select harness and model/ })
  await expect(trigger).toBeEnabled()
  await trigger.click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  const harness = picker.getByRole("button", { name: /^Harness/ })
  await expect(harness).toBeVisible()
  if (!((await harness.textContent()) ?? "").includes("Claude Code")) {
    if (!(await picker.getByText(/^Claude Code/).first().isVisible())) await harness.click()
    await picker.getByText(/^Claude Code/).first().click()
  }
  const models = picker.getByRole("button", { name: /^Model/ })
  await expect(models).toHaveAttribute("aria-busy", "false")
  if ((await models.getAttribute("aria-expanded")) !== "true") await models.click()
  await expect(models).toHaveAttribute("aria-expanded", "true")
  return picker
}

async function openClaudeModelsTab(stack: Stack, app: Page) {
  await test.step("a cold /settings/<section> link stays on that section (DECISIONS 3)", async () => {
    await app.goto(`${stack.url}/settings/models`)
    await expect(app.getByRole("heading", { level: 1, name: "Models" })).toBeVisible()
  })
  const claude = harnessSection(app, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  return claude
}

test("15 settings: a model switched off in Models leaves the composer's picker", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("picker", "Picker")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(draft)
  let claude = await openClaudeModelsTab(stack, app)
  const haiku = claude.getByRole("switch", { name: "Haiku" })
  await expect(haiku).toBeChecked()
  await haiku.click({ force: true })
  await expect(haiku).not.toBeChecked()

  await app.goto(draft)
  let picker = await claudeModels(app)
  await expect(picker.getByText("Sonnet", { exact: true }).first()).toBeVisible()
  await expect(picker.getByText("Haiku", { exact: true })).toHaveCount(0)
  await app.keyboard.press("Escape")

  claude = await openClaudeModelsTab(stack, app)
  await haiku.click({ force: true })
  await expect(haiku).toBeChecked()
  await app.goto(draft)
  picker = await claudeModels(app)
  await expect(picker.getByText("Haiku", { exact: true }).first()).toBeVisible()
  await app.keyboard.press("Escape")

  await test.step("the picker honors a group's Enable all / Disable all (DECISIONS Orchestrator, 02:25)", async () => {
    claude = await openClaudeModelsTab(stack, app)
    await claude.getByRole("button", { name: "Disable all" }).click()
    await expect(claude.getByRole("switch", { name: "Sonnet", exact: true })).not.toBeChecked()
    await app.goto(draft)
    picker = await claudeModels(app)
    await expect(picker.getByText("Sonnet", { exact: true })).toHaveCount(0)
    await expect(picker.getByText("Haiku", { exact: true })).toHaveCount(0)
    await app.keyboard.press("Escape")
    claude = await openClaudeModelsTab(stack, app)
    await claude.getByRole("button", { name: "Enable all" }).click()
    await app.goto(draft)
    picker = await claudeModels(app)
    await expect(picker.getByText("Haiku", { exact: true }).first()).toBeVisible()
  })
})

test("15 settings: Models reads account catalogs once and discovers only the opened harness's models", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("reads", "Reads")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(app, isMobile)
  const settled = apiRequests(app, stack.url)
  await settled()
  await openSection(app, isMobile, "Models")
  const cursor = harnessSection(app, "Cursor")
  await cursor.getByRole("tab", { name: "Models" }).click()
  await expect(cursor.getByText(/^Loading/)).toBeHidden()
  const reads = await settled()
  expect(reads.filter((path, index) => reads.indexOf(path) !== index), "read twice").toEqual([])
  expect(reads.filter((path) => path.startsWith("/api/claxedo/agent-config/harness/options")).sort()).toEqual(
    ["/api/claxedo/agent-config/harness/options?cursor"],
  )
})
