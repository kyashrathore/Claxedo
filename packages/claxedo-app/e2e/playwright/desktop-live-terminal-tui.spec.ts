import { expect, test } from "@playwright/test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"

const exec = promisify(execFile)

test("packaged Codex terminal completes a real TUI turn and survives app restart @live @surface-desktop", async () => {
  test.setTimeout(240_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-tui-desktop-"))
  const home = path.join(root, "home")
  const directory = path.join(root, "workspace")
  const profile = path.join(root, "profile")
  await fs.mkdir(path.join(home, ".codex"), { recursive: true })
  await fs.mkdir(directory)
  // Reuse the existing account in an isolated CLI home; hooks and config written
  // by the app must not change the operator's own provider settings.
  await fs.copyFile(path.join(os.homedir(), ".codex/auth.json"), path.join(home, ".codex/auth.json"))
  await fs.chmod(path.join(home, ".codex/auth.json"), 0o600)
  await exec("git", ["init"], { cwd: directory })
  let packaged: PackagedApp | undefined
  let ptyUrl: string | undefined
  const launch = () => launchPackagedApp({
    userDataDir: profile,
    preserveUserDataDir: true,
    env: { HOME: home, CODEX_HOME: path.join(home, ".codex") },
  })
  try {
    packaged = await launch()
    const server = new URL(await expectServerReachable(packaged)).origin
    const response = await fetch(`${server}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
    expect(response.ok).toBe(true)
    const { workspaceId } = await response.json() as { workspaceId: string }
    await packaged.page.evaluate(async (worktree) => {
      const api = (window as unknown as { api: { storeSet(name: string, key: string, value: string): Promise<void> } }).api
      await api.storeSet("claxedo.global.dat", "server", JSON.stringify({
        list: [], projects: { local: [{ worktree, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {},
      }))
      localStorage.setItem("claxedo.terminal.renderer", "dom")
    }, directory)
    await packaged.page.reload()
    const project = packaged.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)
    await expect(project).toBeVisible({ timeout: 30_000 })
    await project.locator('[data-testid="project-header"]').hover()
    await project.locator('[aria-label="New session in main"]').click()
    await packaged.page.locator('[data-testid="workspace-scope-new-terminal"]').click()
    const created = packaged.page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/pty"))
    await packaged.page.locator('[data-component="terminal-new-launchers"] [data-launcher-id="codex"]').click()
    const creation = await created
    expect(creation.ok()).toBe(true)
    const pty = await creation.json() as { id: string; pid: number }
    const url = new URL(creation.url())
    url.pathname += `/${pty.id}`
    ptyUrl = url.toString()
    const selector = `[data-testid="terminal-pane"][data-terminal-id="${pty.id}"]`
    const rows = packaged.page.locator(`${selector} .xterm-rows`)
    await expect(rows).toContainText(/Codex|trust the contents/i, { timeout: 45_000 })
    await packaged.page.screenshot({ path: test.info().outputPath("codex-tui-launched.png") })
    if (/trust|allow Codex to work/i.test(await rows.innerText())) {
      await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
      await packaged.page.keyboard.press("Enter")
    }
    await expect(rows).toContainText(/OpenAI Codex/, { timeout: 30_000 })
    await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
    await packaged.page.keyboard.type("Reply with the concatenation of DESKTOP and _TUI_OK, nothing else.", { delay: 20 })
    await expect(rows).not.toContainText(/model:\s+loading|Booting MCP server/, { timeout: 45_000 })
    await packaged.page.keyboard.press("Enter")
    await expect(rows).toContainText("DESKTOP_TUI_OK", { timeout: 90_000 })
    await packaged.page.screenshot({ path: test.info().outputPath("codex-tui-completed.png") })
    const before = await (await fetch(ptyUrl)).json() as { pid: number; status: string }
    expect(before.status).toBe("running")
    expect(Number.isInteger(before.pid) && before.pid > 0).toBe(true)
    const previousApp = packaged.app.process()
    await packaged.close()
    await expect.poll(() => previousApp.exitCode !== null || previousApp.signalCode !== null).toBe(true)
    packaged = await launch()
    await expect(packaged.page.locator(selector)).toBeVisible({ timeout: 45_000 })
    await expect(packaged.page.locator(`${selector} .xterm-rows`)).toContainText("DESKTOP_TUI_OK", { timeout: 30_000 })
    const after = await (await fetch(ptyUrl)).json() as { pid: number; status: string }
    expect(after).toMatchObject({ pid: before.pid, status: "running" })
    await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
    await packaged.page.keyboard.type("Reply with the concatenation of RESTART and _TUI_OK, nothing else.", { delay: 20 })
    await packaged.page.keyboard.press("Enter")
    await expect(packaged.page.locator(`${selector} .xterm-rows`)).toContainText("RESTART_TUI_OK", { timeout: 90_000 })
    await packaged.page.screenshot({ path: test.info().outputPath("codex-tui-restarted.png") })
  } finally {
    if (packaged && !packaged.page.isClosed()) await packaged.page.screenshot({ path: test.info().outputPath("terminal-final-state.png") }).catch(() => undefined)
    if (packaged) await test.info().attach("desktop-log", { body: packaged.appLog.join(""), contentType: "text/plain" })
    if (ptyUrl) await fetch(ptyUrl, { method: "DELETE" }).catch(() => undefined)
    await packaged?.close()
    await fs.rm(root, { recursive: true, force: true })
  }
})
