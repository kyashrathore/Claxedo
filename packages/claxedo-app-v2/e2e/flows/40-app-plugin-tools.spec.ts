import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import {
  APP_PLUGIN_WARNING,
  approveAppPlugin,
  expect,
  installedCli,
  listLivePlugins,
  sendPrompt,
  sessionRoute,
  test,
  type ScriptedModelRequest,
  type Stack,
} from "../harness"

const TOOL_PREFIX = "mcp__claxedo__"

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; text?: string }

function blocks(request: ScriptedModelRequest): Block[] {
  if (request.dialect !== "messages" || !("messages" in request.body)) return []
  return request.body.messages.flatMap((message) => (Array.isArray(message.content) ? (message.content as Block[]) : []))
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  return Array.isArray(content) ? (content as Block[]).map((block) => block.text ?? "").join("") : ""
}

function toolResults(requests: readonly ScriptedModelRequest[], tool: string): string[] {
  const latest = requests.findLast((request) => blocks(request).some((block) => block.type === "tool_result"))
  if (!latest) return []
  const all = blocks(latest)
  const ids = all.filter((block) => block.type === "tool_use" && block.name === `${TOOL_PREFIX}${tool}`).map((block) => block.id)
  return all.filter((block) => block.type === "tool_result" && ids.includes(block.tool_use_id)).map((block) => resultText(block.content))
}

async function callTool(stack: Stack, app: Page, tool: string, input: Record<string, unknown>, token: string): Promise<string> {
  const before = toolResults(stack.scripted.requests, tool).length
  stack.scripted.scriptTool({ name: `${TOOL_PREFIX}${tool}`, input, whenPromptIncludes: token })
  await sendPrompt(app, `Run ${tool}. Reply with exactly this one token: ${token}`)
  await expect.poll(() => toolResults(stack.scripted.requests, tool).length, { timeout: 60_000 }).toBe(before + 1)
  await expect(app.getByText(token, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
  return toolResults(stack.scripted.requests, tool).at(-1) ?? ""
}

test("40 a session makes an app plugin with the Claxedo MCP tools: create, a red then green check, add, and the person turns it on", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "the plugin's sidebar row is asserted at desktop width")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("plugin-tools", "Plugin tools")
  const model = await api.defaultModel(workspace.directory, "claude")
  const session = await api.createSession(workspace.directory, {
    title: "Make a plugin",
    harness: { id: "claude", access: "native" },
    permissionMode: "bypassPermissions",
    model,
  })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)

  const created = await callTool(stack, app, "app_plugin_create", { name: "Standup notes" }, "CREATED")
  const directory = path.join(await fs.realpath(workspace.directory), ".claxedo", "plugins", "standup-notes")
  expect(created).toContain(`Created the app plugin Standup notes (standup-notes) at ${directory}: package.json, src/app.tsx.`)
  expect(created).toContain("## Only when the person asked")
  const offered = stack.scripted.requests.flatMap((request) => request.tools.map((tool) => tool.name))
  for (const tool of ["app_plugin_create", "app_plugin_check", "app_plugin_add", "app_plugin_guide"]) expect(offered).toContain(`${TOOL_PREFIX}${tool}`)

  const entry = path.join(directory, "src", "app.tsx")
  const scaffold = await fs.readFile(entry, "utf8")
  await fs.writeFile(entry, scaffold.replace(`label: "Standup notes"`, "label: 42"))
  const red = JSON.parse(await callTool(stack, app, "app_plugin_check", { directory }, "CHECKED_RED")) as { ok: boolean; diagnostics: Record<string, unknown>[] }
  expect(red.ok).toBe(false)
  expect(red.diagnostics).toEqual([expect.objectContaining({ stage: "typecheck", file: "src/app.tsx", code: "TS2322" })])

  await fs.writeFile(entry, scaffold)
  const green = JSON.parse(await callTool(stack, app, "app_plugin_check", { directory }, "CHECKED_GREEN")) as { ok: boolean; pluginId: string; diagnostics: unknown[] }
  expect(green).toMatchObject({ ok: true, pluginId: "standup-notes", diagnostics: [] })
  expect((await listLivePlugins(stack.url)).plugins).toEqual([])

  const added = JSON.parse(await callTool(stack, app, "app_plugin_add", { directory }, "ADDED")) as Record<string, unknown>
  expect(added).toMatchObject({ id: "standup-notes", name: "Standup notes", directory, status: "ready" })
  expect((await listLivePlugins(stack.url)).plugins.map((row) => row.id)).toEqual(["standup-notes"])

  const navigation = app.getByTestId("global-navigation")
  await expect(navigation.getByRole("button", { name: "Standup notes", exact: true })).toHaveCount(0)
  await approveAppPlugin(app, "Turn on the app plugin Standup notes?", APP_PLUGIN_WARNING.web)
  await navigation.getByRole("button", { name: "Standup notes", exact: true }).click()
  const page = app.getByTitle("Standup notes", { exact: true }).contentFrame()
  await expect(page.getByRole("heading", { name: "Standup notes" })).toBeVisible()
})

test("40 the app plugin tools refuse a folder outside the session's workspace and register nothing", async ({ stack, api, app, isMobile }) => {
  test.skip(isMobile, "flow 40 runs at desktop width")
  const availability = await installedCli("claude")
  test.skip(!availability.available, availability.available ? "" : availability.reason)
  const workspace = await stack.daemon.makeWorkspace("plugin-tools-outside")
  const model = await api.defaultModel(workspace.directory, "claude")
  const session = await api.createSession(workspace.directory, { title: "Outside", harness: { id: "claude", access: "native" }, permissionMode: "bypassPermissions", model })
  await app.goto(`${stack.url}${sessionRoute(workspace.id, session.id)}`)

  const outside = path.join(stack.dataDir, "outside-plugin")
  const refused = await callTool(stack, app, "app_plugin_create", { name: "Escape", directory: outside }, "REFUSED")
  expect(refused).toContain("is outside this session's workspace")
  await expect(fs.access(outside)).rejects.toThrow()
  const addRefused = await callTool(stack, app, "app_plugin_add", { directory: stack.dataDir }, "ADD_REFUSED")
  expect(addRefused).toContain("is outside this session's workspace")
  expect((await listLivePlugins(stack.url)).plugins).toEqual([])
})
