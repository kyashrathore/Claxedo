import fs from "node:fs/promises"
import { expect, sessionRoute, test } from "../harness"
import { harnessSection, openSection, openSettings } from "./15-settings.navigation"

async function listedProject(url: string, id: string) {
  const response = await fetch(new URL("/api/claxedo/projects", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { readonly projects: readonly { readonly id: string; readonly available: boolean }[] }).projects.find((project) => project.id === id)
}

test("15 settings: a project whose folder is gone names itself and its folder in the Models tab", async ({ stack, app }) => {
  const workspace = await stack.daemon.makeWorkspace("gone", "Gone")
  await fs.rm(workspace.directory, { recursive: true, force: true })
  expect(await listedProject(stack.url, workspace.projectId)).toMatchObject({ available: false })

  await app.goto(`${stack.url}/settings/models`)
  const claude = harnessSection(app, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  await expect(claude.getByText(`Gone can't list models: its folder ${workspace.directory} is missing.`, { exact: true })).toBeVisible()
  await expect(claude.getByRole("switch")).toHaveCount(0)
})

test("15 settings: a workspace that cannot list a harness's models names itself and the failure", async ({ stack, app, isMobile }) => {
  const workspace = await stack.daemon.makeWorkspace("vanishing", "Vanishing")
  await app.goto(`${stack.url}${sessionRoute(workspace.id)}`)
  await openSettings(app, isMobile)
  await openSection(app, isMobile, "Models")
  await fs.rm(workspace.directory, { recursive: true, force: true })
  const options = await fetch(new URL(`/api/claxedo/agent-config/harness/options?workspaceId=${workspace.id}&nativeHarness=claude`, stack.url))
  expect(options.ok, "the workspace's runtime refuses to list Claude Code's models").toBe(false)

  const claude = harnessSection(app, "Claude Code")
  await claude.getByRole("tab", { name: "Models" }).click()
  await expect(claude.getByText(/^Vanishing couldn't list Claude Code's models: \S/)).toBeVisible()
  await expect(claude.getByText(/^Loading/)).toHaveCount(0)
  await expect(claude.getByRole("switch")).toHaveCount(0)
})
