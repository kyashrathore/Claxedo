import fs from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { assistantText, cloudWorkspaceNames, expect, gitFolder, installedCli, revokeOwnerMachines, sendPrompt, servingMachineName, showHarnesses, storeOwnerKey, test } from "../harness"
import { HOSTED_CODE_HOST_REPOSITORY, HOSTED_CODE_HOST_TOKEN } from "../../../harness/e2e/harness/hosted-scripted-github"

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

async function onboard(app: Page, fromHome: string, machine: string) {
  await expect(app.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await expect(app.getByText(`Folder on ${machine}`, { exact: true })).toBeVisible()
  await app.getByRole("button", { name: "Choose folder" }).click()
  await app.getByRole("textbox", { name: "Search folders" }).fill(fromHome)
  await app.getByRole("dialog", { name: "New Project" }).getByRole("button", { name: /first/ }).click()
  await app.getByRole("button", { name: "Continue" }).click()
  await expect(app.getByRole("heading", { level: 1, name: "Connect an AI" })).toBeVisible()
  await expect(app.getByRole("radiogroup", { name: "Claude Code" })).toBeVisible()
  await app.getByRole("button", { name: "Next", exact: true }).click()
  const where = app.getByRole("radiogroup", { name: "Where work runs" })
  await expect(where.getByRole("radio", { name: new RegExp(`^${machine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toBeChecked()
  await expect(where.getByRole("radio")).toHaveCount(1)
  await expect(app.getByText(/this machine|this computer/i).filter({ visible: true })).toHaveCount(0)
  await expect(app.getByRole("button", { name: "Connect a machine…" })).toHaveCount(0)
  expect(await pageOverflows(app)).toBe(false)
  await app.getByRole("button", { name: "Open project" }).click()
}

test("01 first run: onboarding detects the agents, adds a folder project, and the first prompt runs", async ({ stack, api, app }) => {
  const claude = await installedCli("claude")
  test.skip(!claude.available, claude.available ? "" : claude.reason)
  const folder = await gitFolder(path.join(stack.dataDir, "folders"), "first")
  await onboard(app, path.join("folders", "first"), await servingMachineName(stack.url))
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

test("01 first run on the web: where it runs, a connected repository, the AI, then the first prompt runs in the workspace named after the repository", async ({ signedCloud: signed, page }) => {
  test.setTimeout(240_000)
  await revokeOwnerMachines(signed)
  await storeOwnerKey(signed, "openai", "first-run-key")
  await signed.signIn(page, signed.owner)
  await expect(page.getByRole("heading", { level: 1, name: "Where it runs" })).toBeVisible()
  const where = page.getByRole("radiogroup", { name: "Where work runs" })
  await expect(where.getByRole("radio", { name: /^Claxedo's machines/ })).toBeChecked()
  await expect(where.getByRole("radio")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Add your provider key…" })).toBeVisible()
  await expect(page.getByText(/this machine|this computer/i).filter({ visible: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Connect a machine…" }).click()
  const drawer = page.getByRole("dialog", { name: "Connect a machine" })
  await expect(drawer.getByRole("button", { name: "Copy invite command" })).toBeVisible()
  await drawer.getByRole("button", { name: "Done" }).click()
  await expect(drawer).toHaveCount(0)
  expect(await pageOverflows(page)).toBe(false)
  await page.getByRole("button", { name: "Next", exact: true }).click()

  await expect(page.getByRole("heading", { level: 1, name: "Start with a project" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0)
  await page.getByRole("textbox", { name: "Fine-grained personal access token" }).fill(HOSTED_CODE_HOST_TOKEN)
  await page.getByRole("button", { name: "Connect with token" }).click()
  await page.getByRole("radiogroup", { name: "Repositories" }).getByRole("radio", { name: HOSTED_CODE_HOST_REPOSITORY }).click()
  await page.getByRole("button", { name: "Continue", exact: true }).click()

  await expect(page.getByRole("heading", { level: 1, name: "Connect an AI" })).toBeVisible()
  const finish = page.getByRole("button", { name: "Create workspace" })
  await expect(finish).toBeEnabled()
  await expect(page.getByText("Name the cloud workspace to create it.")).toHaveCount(0)
  await finish.click()

  await expect(page).toHaveURL(/\/w\/[^/]+\/session$/, { timeout: 90_000 })
  await expect(page.getByRole("button", { name: "Where it runs", exact: true })).toHaveText("widgets")
  expect(await cloudWorkspaceNames(signed)).toEqual(["widgets"])
  await expect(page.getByText("This workspace is asleep. Your next message wakes it.")).toHaveCount(0)
  await page.getByRole("button", { name: /^Select harness and model/ }).click()
  const picker = page.getByRole("dialog", { name: "Select harness, model and effort" })
  await showHarnesses(picker)
  await page.getByRole("button", { name: "Pi", exact: true }).click()
  await picker.getByRole("button", { name: "GPT-4.1", exact: true }).click()
  await page.keyboard.press("Escape")
  await sendPrompt(page, "Reply with exactly this one token: FIRSTWEB1")
  await expect(page.getByText("FIRSTWEB1", { exact: true })).toBeVisible({ timeout: 120_000 })
})
