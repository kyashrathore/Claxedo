import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { shutdownPackagedTestDaemon } from "../helpers/desktop-daemon"

test("repository document survives desktop restart and protects competing disk edits @live @surface-desktop", async () => {
  test.setTimeout(150_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-desktop-document-"))
  const directory = path.join(root, "workspace")
  const home = path.join(root, "home")
  const profile = path.join(root, "profile")
  await fs.mkdir(directory)
  await fs.mkdir(home)
  execFileSync("git", ["init"], { cwd: directory })
  const file = path.join(directory, "repository.md")
  const original = "Heading\n=======\n\nOriginal repository file\n"
  const saved = "Heading\n=======\n\nDesktop saved: café 日本語 🚀\n"
  await fs.writeFile(file, original)
  let packaged: PackagedApp | undefined
  const diagnostics: string[] = []
  const launch = () => launchPackagedApp({ userDataDir: profile, preserveUserDataDir: true, env: { HOME: home } })
  try {
    packaged = await launch()
    packaged.page.on("console", (message) => { if (message.type() === "error") diagnostics.push(message.text()) })
    packaged.page.on("pageerror", (error) => diagnostics.push(error.message))
    packaged.page.on("requestfailed", (request) => diagnostics.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`))
    packaged.page.on("response", (response) => { if (response.status() >= 400) diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`) })
    const server = new URL(await expectServerReachable(packaged)).origin
    const response = await fetch(`${server}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
    expect(response.ok).toBe(true)
    const { workspaceId } = await response.json() as { workspaceId: string }
    await packaged.page.evaluate(async (worktree) => {
      const api = (window as unknown as { api: { storeSet(name: string, key: string, value: string): Promise<void> } }).api
      await api.storeSet("claxedo.global.dat", "server", JSON.stringify({
        list: [], projects: { local: [{ worktree, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {},
      }))
    }, directory)
    await packaged.page.reload()
    const project = packaged.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)
    await expect(project).toBeVisible({ timeout: 30_000 })
    await project.locator('[data-testid="project-header"]').hover()
    await project.locator('[aria-label="New session in main"]').click()
    await packaged.page.locator('[data-testid="workbench-shell-header"] [data-testid="workspace-panel-toggle"]').click()
    const files = packaged.page.getByRole("button", { name: "Open Files", exact: true }).last()
    if (await files.isVisible()) await files.click()
    await packaged.page.locator('[data-file-tree-path="repository.md"]').click()
    await packaged.page.evaluate(() => {
      const notes: string[] = []
      Object.assign(window, { documentAuditNotifications: notes })
      new MutationObserver(() => {
        const text = document.querySelector('[aria-label="Notifications (alt+T)"]')?.textContent?.trim()
        if (text && notes.at(-1) !== text) notes.push(text)
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await packaged.page.getByRole("button", { name: "Add to Documents", exact: true }).click()
    const source = () => packaged!.page.getByLabel("Document Markdown source")
    await expect(source()).toHaveValue(original)
    await source().fill(saved)
    await packaged.page.keyboard.press("ControlOrMeta+s")
    await expect.poll(() => fs.readFile(file, "utf8")).toBe(saved)
    const process = packaged.app.process()
    await packaged.close()
    await expect.poll(() => process.exitCode !== null || process.signalCode !== null).toBe(true)
    packaged = await launch()
    await expect(source()).toHaveValue(saved, { timeout: 30_000 })
    expect(await fs.readFile(file, "utf8")).toBe(saved)

    const external = "Heading\n=======\n\nCompeting disk edit after desktop restart\n"
    const draft = "Heading\n=======\n\nHuman draft after desktop restart\n"
    await fs.writeFile(file, external)
    await source().fill(draft)
    await packaged.page.keyboard.press("ControlOrMeta+s")
    await expect(packaged.page.getByRole("heading", { name: "Document changed on disk" })).toBeVisible()
    await expect(source()).toHaveValue(draft)
    expect(await fs.readFile(file, "utf8")).toBe(external)
    await packaged.page.getByRole("button", { name: "Reload disk", exact: true }).click()
    await expect(source()).toHaveValue(external)
    await source().fill(saved)
    await packaged.page.keyboard.press("ControlOrMeta+s")
    await expect.poll(() => fs.readFile(file, "utf8")).toBe(saved)
    await packaged.page.reload()
    await expect(source()).toHaveValue(saved)
    await packaged.page.screenshot({ path: test.info().outputPath("desktop-document-restarted.png") })
  } finally {
    if (packaged && !packaged.page.isClosed()) diagnostics.push(await packaged.page.evaluate(() => JSON.stringify((window as unknown as { documentAuditNotifications?: string[] }).documentAuditNotifications)))
    await test.info().attach("document-diagnostics", { body: diagnostics.join("\n"), contentType: "text/plain" })
    if (packaged && !packaged.page.isClosed()) {
      await packaged.page.screenshot({ path: test.info().outputPath("final.png") }).catch(() => undefined)
    }
    await packaged?.close()
    await shutdownPackagedTestDaemon(profile)
    await fs.rm(root, { recursive: true, force: true })
  }
})
