import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { assistantText, expect, gitFolder, installedCli, sendPrompt, test } from "../harness"

const MARKER = "FIRSTRUN1"

async function serverProjects(url: string): Promise<{ id: string; name: string; directory?: string | null }[]> {
  const response = await fetch(new URL("/api/claxedo/projects", url))
  expect(response.status).toBe(200)
  return ((await response.json()) as { projects: { id: string; name: string; directory?: string | null }[] }).projects
}

function pageOverflows(app: Page) {
  return app.evaluate(() => {
    const page = document.scrollingElement ?? document.documentElement
    return page.scrollHeight > window.innerHeight || page.scrollWidth > window.innerWidth
  })
}

async function onboard(app: Page, fromHome: string) {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  expect(new URL(app.url()).pathname).toBe("/")
  await app.getByRole("button", { name: "Choose folder" }).click()
  await app.getByRole("textbox", { name: "Search folders" }).fill(fromHome)
  await app.getByRole("dialog", { name: "New Project" }).getByRole("button", { name: /first/ }).click()
  await app.getByRole("button", { name: "Continue" }).click()
  await expect(app.getByRole("heading", { level: 1, name: "Connect an AI" })).toBeVisible()
  await expect(app.getByRole("radiogroup", { name: "Claude Code" })).toBeVisible()
  await app.getByRole("button", { name: "Next", exact: true }).click()
  await expect(app.getByRole("radiogroup", { name: "Where work runs" }).getByRole("radio", { name: /^Just this machine/ })).toBeChecked()
  expect(await pageOverflows(app)).toBe(false)
  await app.getByRole("button", { name: "Open project" }).click()
}

test("01 first run: onboarding detects the agents, adds a folder project, and the first prompt runs", async ({ stack, api, app }) => {
  const claude = await installedCli("claude")
  test.skip(!claude.available, claude.available ? "" : claude.reason)
  const folder = await gitFolder(path.join(stack.dataDir, "folders"), "first")
  await onboard(app, path.join("folders", "first"))
  await sendPrompt(app, `Reply with exactly this one token: ${MARKER}`)
  await expect(app.getByText(MARKER, { exact: true })).toBeVisible()

  const projects = await serverProjects(stack.url)
  expect(projects).toHaveLength(1)
  const directory = projects[0]?.directory ?? ""
  expect(await fs.realpath(directory)).toBe(folder)
  const sessions = await api.sessions(directory)
  expect(sessions).toHaveLength(1)
  expect(assistantText(await api.messages(directory, sessions[0]?.id ?? ""))).toContain(MARKER)
})
