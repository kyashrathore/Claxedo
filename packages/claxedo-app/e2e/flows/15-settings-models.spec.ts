import type { Page, Route } from "@playwright/test"
import { apiRequests, expect, sessionRoute, test, type Stack } from "../harness"
import { harnessSection, openSection, openSettings } from "./15-settings.navigation"

type Credential = { readonly id: string; readonly provider_id: string; readonly label?: string; readonly is_active?: boolean; readonly scope?: string; readonly secret_hint?: string | null }

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
  const pi = harnessSection(app, "Pi")
  await expect(pi.getByRole("tab", { name: "Models" })).toBeVisible()
  const disconnect = pi.getByRole("button", { name: "Disconnect" })
  const connected = await disconnect.count()
  const confirm = app.getByRole("dialog").filter({ hasText: /^Disconnect .+ from Pi\?/ })
  await disconnect.first().click()
  await expect(confirm).toContainText("keys you saved for Pi. Other harnesses keep their own accounts.")
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect(disconnect).toHaveCount(connected)
  for (let remaining = connected; remaining > 0; remaining--) {
    await disconnect.first().click()
    await confirm.getByRole("button", { name: "Disconnect", exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(disconnect).toHaveCount(remaining - 1)
  }
  await expect(pi.getByRole("tab")).toHaveCount(0)
  await expect(pi.getByRole("button", { name: "Connect" }).first()).toBeVisible()
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
  await expect(cursor.getByText("Models appear here once you have a project. Your accounts are in the Accounts tab.", { exact: true })).toBeVisible()
  await cursor.getByRole("tab", { name: "Accounts" }).click()
  await expect(cursor.getByRole("radio", { name: /^Before workspace/ })).toBeVisible()
})

test("15 settings: Models lists each agent's accounts and this computer's logins", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("models", "Models")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Models")
  const claude = app.getByRole("radiogroup", { name: "Claude Code" })
  const claudeMachineLogin = claude.getByRole("radio", { name: /^Claude Code login on / })
  const storedClaudeKey = (await credentials(stack.url)).some((row) => row.provider_id === "anthropic" && row.is_active)
  if (storedClaudeKey) {
    await expect(claudeMachineLogin).not.toBeChecked()
    await expect(claude.getByRole("radio", { checked: true })).toHaveCount(1)
  } else {
    await expect(claudeMachineLogin).toBeChecked()
  }
  const section = harnessSection(app, "Cursor")
  const cursor = app.getByRole("radiogroup", { name: "Cursor" })
  const machineLogin = cursor.getByRole("radio", { name: /^Cursor login on .+ CLI login · / })
  await expect(machineLogin).toBeChecked()
  const machineRow = cursor.locator('[data-slot="account-row"][data-account="machine"]')
  await expect(section.getByText(/^(Allow in cloud workspaces|Works only on this computer|Works on this computer and in cloud workspaces)$/)).toHaveCount(0)
  await expect(machineRow.getByText("This computer", { exact: true })).toHaveCount(0)
  await expect(cursor.getByText("This computer's login", { exact: true })).toHaveCount(0)

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
  await expect(first).toHaveAccessibleName(/^Flow fifteen A API key · cursor-•••••en-A$/)
  expect((await credentialNamed(stack.url, "Flow fifteen A"))?.secret_hint).toBe("cursor-…en-A")
  await expect(cursor.getByText("Saved in Claxedo", { exact: true })).toBeVisible()
  await expect(cursor.getByText("This computer's login", { exact: true })).toBeVisible()
  await expect(row("Flow fifteen A").getByText("This computer", { exact: true })).toBeVisible()
  const cloud = row("Flow fifteen A").getByRole("checkbox", { name: "Cloud workspaces", exact: true })
  const cloudLabel = row("Flow fifteen A").getByText("Cloud workspaces", { exact: true })
  await expect(cloud).not.toBeChecked()
  await cloudLabel.click()
  await expect(cloud).toBeChecked()
  await expect.poll(async () => (await credentialNamed(stack.url, "Flow fifteen A"))?.scope).toBe("shared")
  await cloudLabel.click()
  await expect(cloud).not.toBeChecked()
  await expect.poll(async () => (await credentialNamed(stack.url, "Flow fifteen A"))?.scope).toBe("local")
  await expect(machineLogin).toBeDisabled()
  await addKey("Flow fifteen B")
  await expect(second).not.toBeChecked()
  await expect(section.getByRole("button", { name: /^How cloud workspaces choose/ })).toHaveCount(0)
  await expect.poll(async () => (await credentialNamed(stack.url, "Flow fifteen B"))?.is_active).toBe(false)

  await cursor.getByText("Flow fifteen B", { exact: true }).click()
  await expect(second).toBeChecked()
  await expect(first).not.toBeChecked()
  await expect.poll(async () => (await credentialNamed(stack.url, "Flow fifteen B"))?.is_active).toBe(true)
  expect((await credentialNamed(stack.url, "Flow fifteen A"))?.is_active).toBe(false)

  for (const label of ["Flow fifteen B", "Flow fifteen A"]) {
    await row(label).getByRole("button", { name: "Remove", exact: true }).click()
    const confirm = app.getByRole("dialog").filter({ hasText: `Remove ${label}?` })
    await confirm.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await expect(cursor.getByRole("radio", { name: new RegExp(`^${label}`) })).toHaveCount(0)
    await expect.poll(async () => credentialNamed(stack.url, label)).toBeUndefined()
  }
  await expect(machineLogin).toBeChecked()
  await expect(machineLogin).toBeEnabled()
})

test("15 settings: Check runs for its own account alone, spins only its own icon, and says when it last ran", async ({ stack, app }) => {
  await stack.daemon.makeWorkspace("checks", "Checks")
  for (const [label, ending] of [["Check one", "one"], ["Check two", "two"]] as const) {
    const saved = await fetch(new URL("/api/claxedo/credentials", stack.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "cursor-sdk", kind: "api_key", source: "managed", label, secret: JSON.stringify({ unread: ending }) }),
    })
    expect(saved.status).toBe(200)
  }
  const held: Route[] = []
  await app.route("**/api/claxedo/credentials/*/verify", (route) => void held.push(route))
  await app.goto(`${stack.url}/settings/models`)
  const cursor = app.getByRole("radiogroup", { name: "Cursor", exact: true })
  const row = (label: string) => cursor.locator('[data-slot="account-row"]').filter({ hasText: label })
  const check = (label: string) => row(label).getByRole("button", { name: "Check now", exact: true })
  await check("Check one").click()
  await expect(check("Check one")).toHaveAttribute("aria-busy", "true")
  await expect(check("Check one")).toBeDisabled()
  await expect(check("Check two")).toBeEnabled()
  await expect(check("Check two")).not.toHaveAttribute("aria-busy", "true")
  await check("Check two").click()
  await expect(check("Check two")).toHaveAttribute("aria-busy", "true")
  await expect.poll(() => held.length).toBe(2)
  const answers = await Promise.all(held.map(async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response })
    const body = await response.json() as { readonly error?: { readonly code?: string } }
    return [response.status(), body.error?.code]
  }))
  for (const label of ["Check one", "Check two"]) {
    await expect(check(label)).toBeEnabled()
    await expect(check(label)).not.toHaveAttribute("aria-busy", "true")
    await expect(row(label)).toContainText("Couldn't check")
  }
  expect(answers).toEqual([[502, "credential_verification_failed"], [502, "credential_verification_failed"]])
  await check("Check one").hover()
  await expect(app.getByRole("tooltip")).toHaveText(/^Check now · last checked /)
})

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
