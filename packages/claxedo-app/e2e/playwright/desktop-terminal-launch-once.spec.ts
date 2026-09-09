import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { shutdownPackagedTestDaemon } from "../helpers/desktop-daemon"

test("custom terminal launches exactly once across reload and desktop restart @live @surface-desktop", async () => {
  test.setTimeout(150_000)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-launch-once-"))
  const directory = path.join(root, "workspace")
  const home = path.join(root, "home")
  const profile = path.join(root, "profile")
  const count = path.join(root, "launches")
  const script = path.join(directory, "launch.sh")
  // A real shell remains interactive after recording its launch. No provider or
  // PTY transport is mocked; this also works without any provider subscription.
  await fs.mkdir(directory)
  await fs.mkdir(home)
  execFileSync("git", ["init"], { cwd: directory })
  await fs.writeFile(script, `#!/bin/bash\nprintf 'launch\\n' >> '${count}'\nsleep 2\nprintf 'SHELL_READY\\n'\nexec /bin/bash --noprofile --norc\n`, { mode: 0o755 })
  const customLauncher = { name: "Launch once", command: "bash ./launch.sh" }
  let packaged: PackagedApp | undefined
  let ptyUrl: string | undefined
  const launch = () => launchPackagedApp({ userDataDir: profile, preserveUserDataDir: true, env: { HOME: home } })
  const launches = () => fs.readFile(count, "utf8").catch(() => "")
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
      if (customLauncher) {
        await packaged.page.locator('[data-component="workspace-more-menu"]').click()
        await packaged.page.getByRole("menuitem", { name: "Configure..." }).click()
        await packaged.page.getByRole("tab", { name: "Terminals" }).click()
        await packaged.page.getByRole("button", { name: "Add", exact: true }).click()
        await packaged.page.getByPlaceholder("Command name (e.g., Aider)").fill(customLauncher.name)
        await packaged.page.getByPlaceholder("Command to run (e.g., aider --model gpt-4)").fill(customLauncher.command)
        await packaged.page.getByRole("button", { name: "Save Changes" }).click()
        await expect(packaged.page.getByText("Terminal commands saved")).toBeVisible()
        await packaged.page.keyboard.press("Escape")
      }
      await packaged.page.locator('[data-testid="workspace-scope-new-terminal"]').click()
      const launchers = packaged.page.locator('[data-component="terminal-new-launchers"]')
      const launcher = launchers.getByRole("button", { name: /^Launch once / })
      await expect(launcher).toBeVisible()
      const [creation] = await Promise.all([
        packaged.page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/pty")),
        launcher.click(),
      ])
      expect(creation.ok(), await creation.text()).toBe(true)
      const pty = await creation.json() as { id: string; pid: number }
      const url = new URL(creation.url())
      url.pathname += `/${pty.id}`
      ptyUrl = url.toString()


    const selector = `[data-testid="terminal-pane"][data-terminal-id="${pty.id}"]`
    const check = async () => {
      const rows = packaged!.page.locator(`${selector} .xterm-rows`)
      await expect(rows).toContainText("SHELL_READY", { timeout: 15_000 })
      const token = `LIVE_${Date.now()}`
      await packaged!.page.locator(`${selector} .xterm-helper-textarea`).fill(`printf '%s\\n' '${token}'`)
      await packaged!.page.keyboard.press("Enter")
      await expect(rows).toContainText(token)
      // The round trip must have completed, not merely echoed the command.
      await expect.poll(async () => (await rows.innerText()).split(token).length - 1).toBeGreaterThanOrEqual(2)
      expect(await launches()).toBe("launch\n")
      const state = await (await fetch(ptyUrl!)).json() as { pid: number; status: string }
      expect(state.pid).toBe(pty.pid)
      expect(state.status).toBe("running")
    }
    await expect.poll(launches).toBe("launch\n")
    await check()
    await packaged.page.reload()
    await check()
    const armed = path.join(root, "offline-armed")
    const release = path.join(root, "offline-release")
    const produced = path.join(root, "offline-produced")
    await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
    await packaged.page.keyboard.type(`touch '${armed}'; while [ ! -f '${release}' ]; do sleep 0.2; done; printf '\\x44URING_DESKTOP_CLOSED\\n'; touch '${produced}'`)
    await packaged.page.keyboard.press("Enter")
    await expect.poll(() => fs.access(armed).then(() => true, () => false)).toBe(true)
    const process = packaged.app.process()
    await packaged.close()
    await expect.poll(() => process.exitCode !== null || process.signalCode !== null).toBe(true)
    await fs.writeFile(release, "done")
    await expect.poll(() => fs.access(produced).then(() => true, () => false)).toBe(true)
    packaged = await launch()
    const restoredRows = packaged.page.locator(`${selector} .xterm-rows`)
    await expect(restoredRows).toContainText("DURING_DESKTOP_CLOSED")
    expect((await restoredRows.innerText()).split("DURING_DESKTOP_CLOSED").length - 1).toBe(1)
    await check()
    await packaged.page.screenshot({ path: test.info().outputPath("launch-once-restarted.png") })
  } finally {
    await test.info().attach("launch-count", { body: await launches(), contentType: "text/plain" })
    if (packaged && !packaged.page.isClosed()) await packaged.page.screenshot({ path: test.info().outputPath("final.png") }).catch(() => undefined)
    await packaged?.close()
    await shutdownPackagedTestDaemon(profile, async () => {
      if (ptyUrl) {
        const removed = await fetch(ptyUrl, { method: "DELETE" })
        expect(removed.ok, "Final teardown must remove the test terminal").toBe(true)
      }
    })
    await fs.rm(root, { recursive: true, force: true })
  }
})
