import fs from "node:fs/promises"
import { expect, SCRIPTED_ACP_CONNECTION_ID, sessionRoute, test } from "../harness"
import { harnessSection, openSection, openSettings } from "./15-settings.navigation"

async function listedProject(url: string, id: string) {
  const response = await fetch(new URL("/api/claxedo/projects", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { readonly projects: readonly { readonly id: string; readonly available: boolean }[] }).projects.find((project) => project.id === id)
}

test("15 settings: a project whose folder is gone names itself and its folder in a connection's Models tab, while Claude Code, Pi and OpenCode still list their models", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("gone", "Gone")
  await fs.rm(workspace.directory, { recursive: true, force: true })
  expect(await listedProject(stack.url, workspace.projectId)).toMatchObject({ available: false })

  await app.goto(`${stack.url}/settings/models`)
  const acp = harnessSection(app, "Scripted ACP")
  await acp.getByRole("tab", { name: "Models" }).click()
  await expect(acp.getByText(`Gone can't list models: its folder ${workspace.directory} is missing.`, { exact: true })).toBeVisible()
  await expect(acp.getByRole("switch")).toHaveCount(0)
  const claude = harnessSection(app, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  await expect(claude.getByRole("switch", { name: "Sonnet", exact: true })).toBeVisible()
  await expect(claude.getByText(/can't list|couldn't list/)).toHaveCount(0)
  const pi = harnessSection(app, "Pi")
  await pi.getByRole("tab", { name: "Models" }).click()
  await expect(pi.getByRole("region", { name: "Anthropic", exact: true }).getByRole("switch").first()).toBeVisible()
  const opencode = harnessSection(app, "OpenCode")
  await opencode.getByRole("tab", { name: "Models" }).click()
  await expect(opencode.getByRole("region", { name: "Scripted anthropic", exact: true }).getByRole("switch", { name: "Scripted", exact: true })).toBeVisible()
  for (const section of [pi, opencode]) await expect(section.getByText(/can't list|couldn't list/)).toHaveCount(0)
})

test("15 settings: a workspace that cannot list a connection's models names itself and the failure", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("vanishing", "Vanishing")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Models")
  await fs.rm(workspace.directory, { recursive: true, force: true })
  const options = await fetch(new URL(`/api/claxedo/agent-config/harness/options?workspaceId=${workspace.id}&connectionId=${SCRIPTED_ACP_CONNECTION_ID}`, stack.url))
  expect(options.ok, "the workspace's runtime refuses to list Scripted ACP's models").toBe(false)

  const acp = harnessSection(app, "Scripted ACP")
  await acp.getByRole("tab", { name: "Models" }).click()
  await expect(acp.getByText(/^Vanishing couldn't list Scripted ACP's models: \S/)).toBeVisible()
  await expect(acp.getByText(/^Loading/)).toHaveCount(0)
  await expect(acp.getByRole("switch")).toHaveCount(0)
})
