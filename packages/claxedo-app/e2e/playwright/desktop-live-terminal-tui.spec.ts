import { expect, test } from "@playwright/test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { expectTerminalRailStatus } from "../helpers/rail-oracle"

const exec = promisify(execFile)

for (const harness of ["codex", "claude"] as const) {
  test(`packaged ${harness} terminal completes a real TUI turn and survives app restart @live @surface-desktop`, async () => {
    test.setTimeout(240_000)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-tui-desktop-"))
    const home = path.join(root, "home")
    const directory = path.join(root, "workspace")
    const profile = path.join(root, "profile")
    const providerEnv: Record<string, string> = { HOME: home, CODEX_HOME: path.join(home, ".codex") }
    let packaged: PackagedApp | undefined
    let ptyUrl: string | undefined
    const launch = () => launchPackagedApp({
      userDataDir: profile,
      preserveUserDataDir: true,
      env: providerEnv,
    })
    try {
      await fs.mkdir(path.join(home, ".codex"), { recursive: true })
      await fs.mkdir(directory)
      // Reuse the existing account in an isolated CLI home; hooks and config written
      // by the app must not change the operator's own provider settings.
      if (harness === "codex") {
        await fs.copyFile(path.join(os.homedir(), ".codex/auth.json"), path.join(home, ".codex/auth.json"))
        await fs.chmod(path.join(home, ".codex/auth.json"), 0o600)
      } else {
        const config = JSON.parse(await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8")) as { oauthAccount?: unknown }
        await fs.writeFile(path.join(home, ".claude.json"), JSON.stringify({
          hasCompletedOnboarding: true, theme: "light", oauthAccount: config.oauthAccount,
        }), { mode: 0o600 })
        const credential = process.platform === "darwin"
          ? (await exec("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", os.userInfo().username, "-w"])).stdout
          : await fs.readFile(path.join(os.homedir(), ".claude/.credentials.json"), "utf8")
        const token = (JSON.parse(credential) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken
        expect(typeof token === "string" && token.length > 0, "A real Claude login is required for the live TUI test").toBe(true)
        await fs.mkdir(path.join(home, ".claude"), { recursive: true })
        await fs.writeFile(path.join(home, ".claude/.credentials.json"), credential, { mode: 0o600 })
      }
      await exec("git", ["init"], { cwd: directory })
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
      await packaged.page.locator(`[data-component="terminal-new-launchers"] [data-launcher-id="${harness}"]`).click()
      const creation = await created
      expect(creation.ok()).toBe(true)
      const pty = await creation.json() as { id: string; pid: number }
      const url = new URL(creation.url())
      url.pathname += `/${pty.id}`
      ptyUrl = url.toString()
      const selector = `[data-testid="terminal-pane"][data-terminal-id="${pty.id}"]`
      const rows = packaged.page.locator(`${selector} .xterm-rows`)
      await expect(rows).toContainText(/Codex|Claude|trust the contents/i, { timeout: 45_000 })
      await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-launched.png`) })
      if (/trust|allow Codex to work/i.test(await rows.innerText())) {
        await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
        if (harness === "claude") {
          await packaged.page.keyboard.press("ArrowDown")
          await expect(rows).toContainText(/❯\s+Yes, I trust this folder/)
        }
        await packaged.page.keyboard.press("Enter")
      }
      if (harness === "claude") {
        await expect(rows).toContainText(/WARNING: Claude Code running in Bypass Permissions mode|bypass permissions on/i)
        if ((await rows.innerText()).includes("Yes, I accept")) {
          await packaged.page.keyboard.press("ArrowDown")
          await expect(rows).toContainText(/❯\s+Yes, I accept/)
          await packaged.page.keyboard.press("Enter")
        }
      }
      await expect(rows).toContainText(harness === "codex" ? /OpenAI Codex/ : /bypass permissions on/i, { timeout: 30_000 })
      await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
      await packaged.page.keyboard.type("Reply with the concatenation of DESKTOP and _TUI_OK, nothing else.", { delay: 20 })
      await expect(rows).not.toContainText(/model:\s+loading|Booting MCP server/, { timeout: 45_000 })
      await packaged.page.keyboard.press("Enter")
      await expect(rows).toContainText("DESKTOP_TUI_OK", { timeout: 90_000 })
      const lifecycleUrl = `${server}/api/wr/hook/terminal-session?terminalId=${pty.id}&directory=${encodeURIComponent(directory)}`
      await expect.poll(async () => {
        const response = await fetch(lifecycleUrl)
        expect(response.ok).toBe(true)
        const body = await response.json() as { session: { eventType?: string } | null }
        return body.session?.eventType
      }, { timeout: 15_000, message: `Actual ${harness} completion must reach the terminal hook store` }).toBe("Idle")
      await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-completed.png`) })
      const before = await (await fetch(ptyUrl)).json() as { pid: number; status: string }
      expect(before.status).toBe("running")
      expect(Number.isInteger(before.pid) && before.pid > 0).toBe(true)
      const previousApp = packaged.app.process()
      await packaged.close()
      await expect.poll(() => previousApp.exitCode !== null || previousApp.signalCode !== null).toBe(true)
      packaged = await launch()
      await expect(packaged.page.locator(selector)).toBeVisible({ timeout: 45_000 })
      await packaged.page.evaluate(() => {
        const events: { src: string; time: number; muted: boolean; volume: number }[] = []
        Object.assign(window, { __claxedoAudioEnded: events })
        const play = HTMLMediaElement.prototype.play
        HTMLMediaElement.prototype.play = function () {
          this.addEventListener("ended", () => events.push({
            src: this.currentSrc, time: this.currentTime, muted: this.muted, volume: this.volume,
          }), { once: true })
          // Delegate to Chromium's actual player; neither playback nor its promise is mocked.
          return play.call(this)
        }
      })
      await expect(packaged.page.locator(`${selector} .xterm-rows`)).toContainText("DESKTOP_TUI_OK", { timeout: 30_000 })
      const after = await (await fetch(ptyUrl)).json() as { pid: number; status: string }
      expect(after).toMatchObject({ pid: before.pid, status: "running" })
      await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
      await packaged.page.keyboard.type("Run sleep 8 in the foreground with a timeout of at least 20000 ms and run_in_background=false. Wait for it to finish, then reply with the concatenation of RESTART and _TUI_OK, nothing else.", { delay: 20 })
      await packaged.page.keyboard.press("Enter")
      await expect.poll(async () => {
        const response = await fetch(lifecycleUrl)
        expect(response.ok).toBe(true)
        const body = await response.json() as { session: { eventType?: string } | null }
        return body.session?.eventType
      }, { timeout: 15_000, message: `The next real ${harness} turn must replace the previous idle status` }).toBe("Busy")
      await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-working.png`) })
      await expectTerminalRailStatus({ page: packaged.page, terminalId: pty.id, status: "working" })
      await packaged.page.getByRole("button", { name: "New Session", exact: true }).click()
      await expect(packaged.page.locator(selector)).not.toBeVisible()
      await expect.poll(async () => {
        const body = await (await fetch(lifecycleUrl)).json() as { session: { eventType?: string } | null }
        return body.session?.eventType
      }, { timeout: 90_000 }).toBe("Idle")
      await expect.poll(() => packaged!.page.evaluate(() =>
        (window as unknown as { __claxedoAudioEnded: { time: number; muted: boolean; volume: number }[] }).__claxedoAudioEnded
          .filter((event) => event.time > 0 && !event.muted && event.volume > 0).length,
      ), { timeout: 15_000, message: "Background completion must play the real notification audio through to its end" }).toBe(1)
      await packaged.page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${pty.id}"]`).click()
      await expect(packaged.page.locator(`${selector} .xterm-rows`)).toContainText("RESTART_TUI_OK", { timeout: 30_000 })
      await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-restarted.png`) })
    } finally {
      if (packaged && !packaged.page.isClosed()) await test.info().attach("audio-ended", { body: JSON.stringify(await packaged.page.evaluate(() => (window as unknown as { __claxedoAudioEnded?: unknown }).__claxedoAudioEnded ?? [])), contentType: "application/json" })
      if (packaged && !packaged.page.isClosed()) await packaged.page.screenshot({ path: test.info().outputPath("terminal-final-state.png") }).catch(() => undefined)
      if (packaged) await test.info().attach("desktop-log", { body: packaged.appLog.join(""), contentType: "text/plain" })
      if (ptyUrl) await fetch(ptyUrl, { method: "DELETE" }).catch(() => undefined)
      await packaged?.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}
