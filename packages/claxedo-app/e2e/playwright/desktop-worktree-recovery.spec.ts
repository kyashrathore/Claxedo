import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { shutdownPackagedTestDaemon } from "../helpers/desktop-daemon"

test("recovered worktree runs a real shell in its checkout across desktop restart @live @surface-desktop", async () => {
  test.setTimeout(150_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-desktop-recovery-"))
  const directory = path.join(root, "workspace")
  const home = path.join(root, "home")
  const profile = path.join(root, "profile")
  await fs.mkdir(directory)
  await fs.mkdir(home)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  const original = "Recovery checkout: café 日本語\n"
  await fs.writeFile(path.join(directory, "README.md"), original)
  git("add", "README.md")
  git("-c", "user.name=Recovery Test", "-c", "user.email=recovery@example.invalid", "commit", "-m", "Initial checkout")
  const head = git("rev-parse", "HEAD")
  let packaged: PackagedApp | undefined
  let ptyUrl: string | undefined
  const launch = () => launchPackagedApp({ userDataDir: profile, preserveUserDataDir: true, env: { HOME: home } })
  try {
    packaged = await launch()
    const server = new URL(await expectServerReachable(packaged)).origin
    const registered = await fetch(`${server}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`)
    expect(registered.ok).toBe(true)
    const creation = await fetch(`${server}/experimental/worktree?directory=${encodeURIComponent(directory)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "missing" }),
    })
    expect(creation.ok, await creation.clone().text()).toBe(true)
    const missing = await creation.json() as { directory: string }
    await expect.poll(() => fs.readFile(path.join(missing.directory, "README.md"), "utf8").catch(() => "")).toBe(original)
    const missingPath = await fs.realpath(missing.directory)
    expect(missingPath.startsWith(await fs.realpath(profile) + path.sep)).toBe(true)
    await fs.rm(missingPath, { recursive: true })
    await packaged.page.evaluate(async (worktree) => {
      const api = (window as unknown as { api: { storeSet(name: string, key: string, value: string): Promise<void> } }).api
      await api.storeSet("claxedo.global.dat", "server", JSON.stringify({
        list: [], projects: { local: [{ worktree, expanded: true }] }, lastProject: {}, workspaceServer: {}, closedProjects: {},
      }))
      localStorage.setItem("claxedo.terminal.renderer", "dom")
    }, directory)
    await packaged.page.reload()
    await packaged.page.getByTestId("rail-account-trigger").click()
    await packaged.page.getByRole("menuitem", { name: "View options" }).hover()
    await packaged.page.getByRole("menuitemradio", { name: "Workspace" }).click()
    await expect.poll(async () => {
      await packaged!.page.keyboard.press("Escape")
      return packaged!.page.getByRole("menu").count()
    }).toBe(0)
    const row = packaged.page.locator(`[data-testid="workspace-header"][data-workspace-id="${missing.directory}"]`)
    await row.hover()
    await row.getByRole("button", { name: /^New session in / }).click()
    await expect(packaged.page.locator('[data-slot="dialog-title"]')).toHaveText("Worktree not found")
    const recoveredResponse = packaged.page.waitForResponse((item) => item.request().method() === "POST" && new URL(item.url()).pathname.endsWith("/experimental/worktree"))
    await packaged.page.getByRole("button", { name: "Continue in new worktree", exact: true }).click()
    const recoveredResult = await recoveredResponse
    expect(recoveredResult.ok(), await recoveredResult.text()).toBe(true)
    const recovered = await recoveredResult.json() as { directory: string; branch: string }
    expect(recovered.directory).not.toBe(missing.directory)
    await expect(packaged.page.locator('[data-slot="dialog-title"]')).toHaveCount(0, { timeout: 20_000 })
    await expect(packaged.page.locator(`[data-testid="workspace-header"][data-workspace-id="${recovered.directory}"]`)).toHaveCount(1)
    await packaged.page.getByTestId("workspace-scope-new-terminal").click()
    const ptyResponse = packaged.page.waitForResponse((item) => item.request().method() === "POST" && new URL(item.url()).pathname.endsWith("/pty"))
    await packaged.page.locator('[data-launcher-id="shell"]').click()
    const ptyResult = await ptyResponse
    expect(ptyResult.ok(), await ptyResult.text()).toBe(true)
    const pty = await ptyResult.json() as { id: string; pid: number }
    const url = new URL(ptyResult.url())
    url.pathname += `/${pty.id}`
    ptyUrl = url.toString()
    const terminal = () => packaged!.page.locator(`[data-testid="terminal-pane"][data-terminal-id="${pty.id}"]`)
    const check = async (phase: string) => {
      await terminal().locator(".xterm-helper-textarea").fill(`pwd -P > ${phase}-cwd.txt; git branch --show-current > ${phase}-branch.txt`)
      await packaged!.page.keyboard.press("Enter")
      await expect.poll(() => fs.readFile(path.join(recovered.directory, `${phase}-cwd.txt`), "utf8").catch(() => "")).toBe(await fs.realpath(recovered.directory) + "\n")
      await expect.poll(() => fs.readFile(path.join(recovered.directory, `${phase}-branch.txt`), "utf8").catch(() => "")).toBe(recovered.branch + "\n")
      expect(await fs.access(path.join(directory, `${phase}-cwd.txt`)).then(() => true, () => false)).toBe(false)
      expect(await fs.readFile(path.join(recovered.directory, "README.md"), "utf8")).toBe(original)
      expect(git("rev-parse", "HEAD")).toBe(head)
      expect(await fs.readFile(path.join(directory, "README.md"), "utf8")).toBe(original)
      const state = await (await fetch(ptyUrl!)).json() as { pid: number; status: string }
      expect(state.pid).toBe(pty.pid)
      expect(state.status).toBe("running")
    }
    await check("before")
    const process = packaged.app.process()
    await packaged.close()
    await expect.poll(() => process.exitCode !== null || process.signalCode !== null).toBe(true)
    packaged = await launch()
    await check("after")
    await expect(packaged.page.locator(`[data-testid="workspace-header"][data-workspace-id="${recovered.directory}"]`)).toHaveCount(1)
    await packaged.page.screenshot({ path: test.info().outputPath("recovered-desktop-restarted.png") })
  } finally {
    if (packaged && !packaged.page.isClosed()) await packaged.page.screenshot({ path: test.info().outputPath("final.png") }).catch(() => undefined)
    await packaged?.close()
    await shutdownPackagedTestDaemon(profile, async () => {
      if (ptyUrl) expect((await fetch(ptyUrl, { method: "DELETE" })).ok).toBe(true)
    })
    await fs.rm(root, { recursive: true, force: true })
  }
})
