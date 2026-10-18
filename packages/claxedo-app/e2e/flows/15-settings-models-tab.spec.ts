import type { Page } from "@playwright/test"
import { apiRequests, expect, sessionRoute, test, type Stack } from "../harness"
import { harnessSection, openSection, openSettings } from "./15-settings.navigation"

const CLOUD_WORDS = /cloud workspace|sandbox/i
const modelRead = (path: string) => path.startsWith("/api/claxedo/credentials/harness-models") || path.startsWith("/api/claxedo/agent-config/harness/options")

test("15 settings: with no project, Claude Code and Codex list the server's models and Cursor on this computer's login says why it lists none, and nothing reads a workspace", async ({ stack, app }) => {
  const projects = await fetch(new URL("/api/claxedo/projects", stack.url))
  expect(await projects.json()).toMatchObject({ projects: [] })
  const connections: string[] = []
  app.on("request", (request) => {
    if (/^\/api\/workspace\/[^/]+\/connection$/.test(new URL(request.url()).pathname)) connections.push(request.method())
  })
  await app.goto(`${stack.url}/settings/models`)
  const settled = apiRequests(app, stack.url)
  await settled()
  const claude = harnessSection(app, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  for (const model of ["Opus", "Sonnet", "Haiku"]) await expect(claude.getByRole("switch", { name: model, exact: true })).toBeVisible()
  const codex = harnessSection(app, "Codex")
  await codex.getByRole("tab", { name: "Models" }).click()
  for (const model of ["GPT-6.1-Sol", "GPT-6-Luna"]) await expect(codex.getByRole("switch", { name: model, exact: true })).toBeVisible()
  const cursor = harnessSection(app, "Cursor")
  await cursor.getByRole("tab", { name: "Models" }).click()
  await expect(cursor.getByText("Couldn't list Cursor's models: Cursor's models are listed with a Cursor API key, and this computer's Cursor login has none. Add a Cursor API key in Settings → Models.", { exact: true })).toBeVisible()
  await expect(cursor.getByRole("switch")).toHaveCount(0)
  for (const section of [claude, codex, cursor]) await expect(section, "a desktop's Models tab says nothing that applies only to the web").not.toHaveText(CLOUD_WORDS)
  const reads = await settled()
  expect(reads.filter(modelRead).sort()).toEqual([
    "/api/claxedo/credentials/harness-models?claude",
    "/api/claxedo/credentials/harness-models?codex",
    "/api/claxedo/credentials/harness-models?cursor",
  ])
  expect(connections, "no workspace is started").toEqual([])
})

test("15 settings: with no project, Pi and OpenCode list their models from the server's catalogs, and nothing names or starts a workspace", async ({ stack, app }) => {
  const projects = await fetch(new URL("/api/claxedo/projects", stack.url))
  expect(await projects.json()).toMatchObject({ projects: [] })
  const workspaceReads: string[] = []
  app.on("request", (request) => {
    const url = new URL(request.url())
    if (/^\/api\/workspace\/[^/]+\/connection$/.test(url.pathname) || url.searchParams.has("workspaceId")) workspaceReads.push(`${request.method()} ${url.pathname}${url.search}`)
  })
  await app.goto(`${stack.url}/settings/models`)
  const settled = apiRequests(app, stack.url)
  await settled()
  const pi = harnessSection(app, "Pi")
  await pi.getByRole("tab", { name: "Models" }).click()
  const anthropic = pi.getByRole("region", { name: "Anthropic", exact: true })
  await expect(anthropic.getByRole("switch").first()).toBeVisible()
  await expect(pi.getByText(/once you have (a project|one)/)).toHaveCount(0)
  const opencode = harnessSection(app, "OpenCode")
  await opencode.getByRole("tab", { name: "Models" }).click()
  await expect(opencode.getByRole("region", { name: "Scripted anthropic", exact: true }).getByRole("switch", { name: "Scripted", exact: true })).toBeVisible()
  await expect(opencode.getByText(/once you have (a project|one)/)).toHaveCount(0)
  await expect(opencode.getByText("Providers OpenCode finds on this computer by itself, from its own sign-ins, environment keys or a project's opencode config, are listed only in that project's model picker.", { exact: true })).toBeVisible()
  const reads = await settled()
  expect(reads.filter((path) => path.startsWith("/api/claxedo/agent-config/harness/options")), "no harness options read, which names a workspace").toEqual([])
  expect(workspaceReads, "nothing names a workspace or asks for its connection").toEqual([])
})

async function claudeModels(app: Page) {
  return await harnessModels(app, "Claude Code")
}

async function harnessModels(app: Page, harnessName: string) {
  const trigger = app.getByRole("button", { name: /^Select harness and model/ })
  await expect(trigger).toBeEnabled()
  await trigger.click()
  const picker = app.getByRole("dialog", { name: "Select harness, model and effort" })
  const harness = picker.getByRole("button", { name: /^Harness/ })
  await expect(harness).toBeVisible()
  if (!((await harness.textContent()) ?? "").includes(harnessName)) {
    if (!(await picker.getByText(new RegExp(`^${harnessName}`)).first().isVisible())) await harness.click()
    await picker.getByText(new RegExp(`^${harnessName}`)).first().click()
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

test("15 settings: a Pi model switched off in Models leaves the composer's picker", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("pi-picker", "Pi picker")
  const draft = `${stack.url}${sessionRoute(workspace.id)}`
  await app.goto(`${stack.url}/settings/models`)
  const pi = harnessSection(app, "Pi")
  await pi.getByRole("tab", { name: "Models" }).click()
  const anthropic = pi.getByRole("region", { name: "Anthropic", exact: true })
  const name = "Claude Haiku 4.5"
  const haiku = anthropic.getByRole("switch", { name, exact: true })
  await expect(haiku).toBeChecked()
  await haiku.click({ force: true })
  await expect(haiku).not.toBeChecked()

  await app.goto(draft)
  const picker = await harnessModels(app, "Pi")
  await expect(picker.getByText(name, { exact: true })).toHaveCount(0)
  await app.keyboard.press("Escape")

  await app.goto(`${stack.url}/settings/models`)
  await harnessSection(app, "Pi").getByRole("tab", { name: "Models" }).click()
  await harnessSection(app, "Pi").getByRole("region", { name: "Anthropic", exact: true }).getByRole("switch", { name, exact: true }).click({ force: true })
  await app.goto(draft)
  await expect((await harnessModels(app, "Pi")).getByText(name, { exact: true }).first()).toBeVisible()
})

test("15 settings: Models reads account catalogs once and discovers only the opened harness's models", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("reads", "Reads")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(app, isMobile)
  const settled = apiRequests(app, stack.url)
  await settled()
  await openSection(app, isMobile, "Models")
  const claude = harnessSection(app, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  await expect(claude.getByRole("switch", { name: "Sonnet", exact: true })).toBeVisible()
  const reads = await settled()
  expect(reads.filter((path, index) => reads.indexOf(path) !== index), "read twice").toEqual([])
  expect(reads.filter(modelRead).sort(), "no model read asks the workspace").toEqual(["/api/claxedo/credentials/harness-models?claude"])
})
