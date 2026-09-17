import { expect, test, type Page } from "@playwright/test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { shutdownPackagedTestDaemon } from "../helpers/desktop-daemon"
import { expectTerminalRailStatus, expectTerminalRailStatusAbsent } from "../helpers/rail-oracle"

const exec = promisify(execFile)

for (const { harness, child, pause } of [
  { harness: "codex", child: false, pause: false },
  { harness: "cursor", child: false, pause: false },
  { harness: "droid", child: false, pause: false },
  { harness: "amp", child: false, pause: false },
  { harness: "antigravity", child: false, pause: false },
  { harness: "claude", child: false, pause: false },
  { harness: "claude", child: true, pause: false },
  { harness: "claude", child: true, pause: true },
] as const) {
  test(`packaged ${harness} terminal completes a real TUI turn${child ? pause ? " with a background subagent" : " with a subagent" : ""} and survives app restart @live @surface-desktop`, async () => {
    test.setTimeout(240_000)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-tui-desktop-"))
    const home = path.join(root, "home")
    const directory = path.join(root, "workspace")
    const profile = path.join(root, "profile")
    const providerEnv: Record<string, string> = { HOME: home, CODEX_HOME: path.join(home, ".codex") }
    // Cursor's native input handler treats 3+ events less than 35 ms apart as
    // a paste burst and inserts a newline on Enter. Exercise ordinary typing.
    const typingDelay = harness === "cursor" ? 50 : 20
    const customLauncher = harness === "claude"
      ? { name: "Claude Opus", command: "claude --model opus --dangerously-skip-permissions" }
      : harness === "cursor"
      ? { name: "Cursor", command: "AGENT_CLI_CREDENTIAL_STORE=file cursor-agent --force" }
      : harness === "droid" ? { name: "Droid", command: "droid --auto high" }
      : harness === "antigravity" ? { name: "Antigravity", command: "agy --dangerously-skip-permissions" }
      : harness === "amp" ? { name: "Amp", command: "amp --dangerously-allow-all --visibility private --no-ide" } : undefined
    let journeyCompleted = false
    let packaged: PackagedApp | undefined
    let ptyUrl: string | undefined
    const traffic: { at: number; launch: number; kind: string; data: string }[] = []
    const ptyStates: unknown[] = []
    const trafficBytes = { input: 0, output: 0, close: 0 }
    let launches = 0
    const rawHookDirectory = path.join(root, "raw-hooks")
    const launch = () => {
      const launchNumber = ++launches
      const observe = (page: Page) => {
        page.on("request", (request) => {
          if (request.method() === "PUT" && new URL(request.url()).pathname.includes("/pty/")) {
            ptyStates.push({ phase: "update", launch: launchNumber, at: Date.now(), body: request.postData() })
          }
        })
        page.on("websocket", (socket) => {
          if (!socket.url().includes("/pty/")) return
          const record = (kind: keyof typeof trafficBytes, payload: string | Buffer) => {
            if (trafficBytes[kind] > 512_000) return
            const data = payload.toString()
            trafficBytes[kind] += data.length
            traffic.push({ at: Date.now(), launch: launchNumber, kind, data })
          }
          socket.on("framesent", ({ payload }) => record("input", payload))
          socket.on("framereceived", ({ payload }) => record("output", payload))
          socket.on("close", () => record("close", ""))
        })
      }
      return launchPackagedApp({
        userDataDir: profile,
        preserveUserDataDir: true,
        env: providerEnv,
        beforeShellWindow: async (context) => {
          context.on("page", observe)
          for (const page of context.pages()) observe(page)
        },
      })
    }
    try {
      await fs.mkdir(path.join(home, ".codex"), { recursive: true })
      await fs.mkdir(directory)
      // Reuse the existing account in an isolated CLI home; hooks and config written
      // by the app must not change the operator's own provider settings.
      if (harness === "codex") {
        await fs.copyFile(path.join(os.homedir(), ".codex/auth.json"), path.join(home, ".codex/auth.json"))
        await fs.chmod(path.join(home, ".codex/auth.json"), 0o600)
      } else if (harness === "cursor") {
        const authDirectory = path.join(home, process.platform === "darwin" ? ".cursor" : ".config/cursor")
        await fs.mkdir(authDirectory, { recursive: true })
        const credentials = process.platform === "darwin"
          ? Object.fromEntries(await Promise.all([
            ["accessToken", "cursor-access-token"], ["refreshToken", "cursor-refresh-token"],
          ].map(async ([field, service]) => [field, (await exec("security", ["find-generic-password", "-s", service, "-a", "cursor-user", "-w"])).stdout.trim()])))
          : JSON.parse(await fs.readFile(path.join(os.homedir(), ".config/cursor/auth.json"), "utf8"))
        await fs.writeFile(path.join(authDirectory, "auth.json"), JSON.stringify(credentials), { mode: 0o600 })
      } else if (harness === "amp") {
        const authDirectory = path.join(home, ".local/share/amp")
        await fs.mkdir(authDirectory, { recursive: true })
        await fs.copyFile(path.join(os.homedir(), ".local/share/amp/secrets.json"), path.join(authDirectory, "secrets.json"))
        await fs.chmod(path.join(authDirectory, "secrets.json"), 0o600)
        await fs.mkdir(path.join(home, ".config/amp"), { recursive: true })
        await fs.writeFile(path.join(home, ".config/amp/settings.json"), JSON.stringify({ "amp.updates.mode": "disabled" }))
      } else if (harness === "droid") {
        await fs.mkdir(path.join(home, ".factory"), { recursive: true })
        for (const file of ["auth.json", "auth.v2.file", "auth.v2.key"]) {
          await fs.copyFile(path.join(os.homedir(), ".factory", file), path.join(home, ".factory", file))
          await fs.chmod(path.join(home, ".factory", file), 0o600)
        }
      } else if (harness === "claude") {
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
        {
          await fs.mkdir(rawHookDirectory)
          // Each invocation owns a file: concurrent hooks must not interleave JSON writes.
          const command = `file=$(mktemp '${path.join(rawHookDirectory, "hook.XXXXXX")}'); cat > "$file"`
          await fs.writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({ hooks: Object.fromEntries(
            ["UserPromptSubmit", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PostToolUse", "PostToolUseFailure"].map((event) => [event, [{ hooks: [{ type: "command", command }] }]]),
          ) }))
        }
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
      if (customLauncher) {
        // Seeded rather than typed into Settings -> Terminals: the pane's save
        // path is covered by `features/settings/ui/terminals.vitest.tsx`, and
        // reaching it here means opening the rail account menu, whose org/team
        // reads suspend the shell and take this header with them.
        await packaged.page.evaluate((launcher) => {
          localStorage.setItem(
            "claxedo.terminalCommands",
            JSON.stringify({ custom: [{ id: "custom-launcher", ...launcher }] }),
          )
        }, customLauncher)
      }
      await packaged.page.reload()
      const project = packaged.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)
      await expect(project).toBeVisible({ timeout: 30_000 })
      await project.locator('[data-testid="project-header"]').hover()
      await project.locator('[aria-label="New session in main"]').click()
      await packaged.page.locator('[data-testid="workspace-scope-new-terminal"]').click()
      const launchers = packaged.page.locator('[data-component="terminal-new-launchers"]')
      const launcher = customLauncher ? launchers.getByRole("button", { name: new RegExp(`^${customLauncher.name} `) }) : launchers.locator(`[data-launcher-id="${harness}"]`)
      await expect(launcher).toBeVisible()
      const [creation] = await Promise.all([
        packaged.page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/pty")),
        launcher.click(),
      ])
      expect(creation.ok()).toBe(true)
      const pty = await creation.json() as { id: string; pid: number }
      const url = new URL(creation.url())
      url.pathname += `/${pty.id}`
      ptyUrl = url.toString()
      ptyStates.push({ phase: "created", at: Date.now(), pty })
      const selector = `[data-testid="terminal-pane"][data-terminal-id="${pty.id}"]`
      const rows = packaged.page.locator(`${selector} .xterm-rows`)
      if (harness === "cursor") {
        await expect(rows).toContainText("Workspace Trust Required", { timeout: 45_000 })
        await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
        await packaged.page.keyboard.press("a")
        await expect(rows).toContainText("Run Everything", { timeout: 30_000 })
      }
      if (harness === "droid") {
        await expect(rows).toContainText(/Welcome to Factory CLI|ctrl\+L for autonomy/, { timeout: 45_000 })
        expect(await rows.innerText(), "Droid must authenticate before a real turn can be tested").not.toContain("Please login with your Factory account")
      } else if (harness === "amp") {
        await expect(rows).toContainText(/Space to continue|ampcode\.com|ctrl|Ctrl/, { timeout: 45_000 })
        if ((await rows.innerText()).includes("Space to continue")) {
          await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
          await packaged.page.keyboard.press("Space")
          for (let slide = 1; slide <= 5; slide++) {
            await expect(rows).toContainText(`${slide}/5`)
            await packaged.page.keyboard.press("Space")
          }
          await expect(rows).toContainText("Enter to get started")
          await packaged.page.keyboard.press("Enter")
          await expect(rows).not.toContainText("Enter to get started")
        }
      } else await expect(rows).toContainText(/Codex|Claude|Cursor|Antigravity|trust the contents/i, { timeout: 45_000 })
      await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-launched.png`) })
      if (harness === "antigravity") {
        expect(await rows.innerText(), "Antigravity requires a completed Google OAuth login before a real turn can be qualified").not.toContain("You are currently not signed in")
      }
      if ((harness === "claude" || harness === "codex") && /trust the contents|trust this folder|allow Codex to work/i.test(await rows.innerText())) {
        await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
        if (harness === "claude") {
          // Native Claude resets this selector during its initial capability
          // detection window (also reproduced without Claxedo in a real PTY).
          await expect.poll(() => {
            const reply = traffic.findLast((event) => event.kind === "input" && event.data.includes("xterm.js("))
            return reply ? Date.now() - reply.at : 0
          }, { timeout: 10_000 }).toBeGreaterThan(250)
          if (!/❯\s+Yes, I trust this folder/.test(await rows.innerText())) await packaged.page.keyboard.press("ArrowDown")
          await expect(rows).toContainText(/❯\s+Yes, I trust this folder/)
          await packaged.page.waitForTimeout(200)
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
      await expect(rows).toContainText(harness === "codex" ? /OpenAI Codex/ : harness === "cursor" ? /Cursor/ : harness === "droid" ? /ctrl\+L for autonomy/ : harness === "amp" ? /ctrl\+o for commands/i : harness === "antigravity" ? /Type.*message|Ask.*anything|What would you like/i : /bypass permissions on/i, { timeout: 30_000 })
      await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
      if (harness === "amp") {
        // The welcome animation exposes command help before the input box is
        // mounted. Wait for Amp's composer frame, not xterm's hidden hardware cursor.
        await expect(rows.locator(":scope > div").filter({ hasText: /╰.*workspace \(main\).*╯/ })).toBeVisible({ timeout: 15_000 })
        await expect(rows.locator(".xterm-bg-257")).toBeVisible({ timeout: 15_000 })
        await packaged.page.screenshot({ path: test.info().outputPath("amp-composer-ready.png") })
      }
      if (harness === "codex") {
        const configuration = JSON.parse(await fs.readFile(path.join(home, ".codex/hooks.json"), "utf8")) as {
          hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
        }
        expect(Object.keys(configuration.hooks).sort()).toEqual(["Interrupt", "SessionStart", "Stop", "UserPromptSubmit"])
        for (const definitions of Object.values(configuration.hooks)) {
          for (const definition of definitions) {
            for (const hook of definition.hooks) expect(hook.command).toBe(path.join(home, ".workspace-runtime/hooks/notify.sh"))
          }
        }
        const notifyPath = path.join(home, ".workspace-runtime/hooks/notify.sh")
        const notifySource = await fs.readFile(notifyPath, "utf8")
        const diagnostic = `printf 'tab=%s terminal=%s token=%s port=%s\\n' "\${CLAXEDO_TAB_ID:+present}" "\${CLAXEDO_TERMINAL_ID:+present}" "\${CLAXEDO_AGENT_HOOK_TOKEN:+present}" "\${CLAXEDO_SERVER_PORT:+present}" >> '${path.join(root, "codex-hook-environment.txt")}'`
        await fs.writeFile(notifyPath, notifySource.replace("#!/bin/bash", `#!/bin/bash\n${diagnostic}`), { mode: 0o755 })
        await packaged.page.keyboard.type("/hooks", { delay: typingDelay })
        await packaged.page.waitForTimeout(200)
        await packaged.page.keyboard.press("Enter")
        await expect(rows).toContainText("Hooks need review")
        await packaged.page.keyboard.press("Enter")
        await expect(rows).toContainText("Press t to trust all")
        await packaged.page.keyboard.press("t")
        await packaged.page.screenshot({ path: test.info().outputPath("codex-hook-trust-result.png") })
        await expect(rows).not.toContainText("4 hooks need review")
        await packaged.page.keyboard.press("Escape")
        // Hook review preserves the command draft that opened it.
        await packaged.page.keyboard.press("Control+u")
        await packaged.page.keyboard.type("/new", { delay: typingDelay })
        await packaged.page.waitForTimeout(200)
        await packaged.page.keyboard.press("Enter")
        await expect(rows).not.toContainText(/model:\s+loading/, { timeout: 30_000 })
      }
      await packaged.page.keyboard.type("Reply with the concatenation of DESKTOP and _TUI_OK, nothing else.", { delay: typingDelay })
      await expect(rows).not.toContainText(/model:\s+loading|Booting MCP server/, { timeout: 45_000 })
      await packaged.page.keyboard.press("Enter")
      if (harness === "amp") {
        await expect(rows).toContainText(/DESKTOP_TUI_OK|Out of Credits/, { timeout: 90_000 })
        expect(await rows.innerText(), "Amp provider execution requires available account credits").not.toContain("Out of Credits")
      }
      if (harness === "claude") {
        await expect(rows).toContainText(/DESKTOP_TUI_OK|OAuth access token has been revoked/, { timeout: 90_000 })
        expect(await rows.innerText(), "Claude OAuth login was revoked; log back in before testing Opus").not.toContain("OAuth access token has been revoked")
      }
      await expect(rows).toContainText("DESKTOP_TUI_OK", { timeout: 90_000 })
      const lifecycleUrl = `${server}/api/wr/hook/terminal-session?terminalId=${pty.id}&directory=${encodeURIComponent(directory)}`
      await expect.poll(async () => {
        const response = await fetch(lifecycleUrl)
        expect(response.ok).toBe(true)
        const body = await response.json() as { session: { eventType?: string } | null }
        return body.session?.eventType
      }, { timeout: 15_000, message: `Actual ${harness} completion must reach the terminal hook store` }).toBe("Idle")
      const received = await (await fetch(lifecycleUrl)).json() as { session: { prompt?: string } }
      await test.info().attach(`${harness}-received-first-prompt`, { body: JSON.stringify(received.session), contentType: "application/json" })
      expect(received.session.prompt, `${harness} must report the entire received prompt`).toBe("Reply with the concatenation of DESKTOP and _TUI_OK, nothing else.")
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
        const play: (this: HTMLMediaElement) => Promise<void> = Reflect.get(HTMLMediaElement.prototype, "play")
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
      if (child) await packaged.page.evaluate(async ({ server, terminalId, directory }) => {
        const events: string[] = []
        const stream = new EventSource(`${server}/api/wr/events?directory=${encodeURIComponent(directory)}`)
        Object.assign(window, { __claxedoChildLifecycle: events, __claxedoChildStream: stream })
        stream.onmessage = (message) => {
          const frame = JSON.parse(message.data)
          const event = frame.payload ?? frame
          if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event.eventType)
        }
        await new Promise<void>((resolve, reject) => {
          stream.onopen = () => resolve()
          stream.onerror = () => reject(new Error("Real lifecycle observation stream failed"))
        })
      }, { server, terminalId: pty.id, directory })
      await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
      const delegation = child
        ? pause
          ? "First use the Agent tool with run_in_background=true to launch one general-purpose subagent with this task: run sleep 8 in the foreground, then reply CHILD_FINISHED, nothing else. Yield while awaiting its completion notification. After it finishes, you, the parent, must do the following yourself. "
          : "First use the Agent tool with run_in_background=false to launch one foreground general-purpose subagent with this task: reply CHILD_FINISHED, nothing else. Wait synchronously for its result, without ending your response. Then you, the parent, must do the following yourself. "
        : ""
      await packaged.page.keyboard.type(`${delegation}Run sleep 8 in the foreground with a timeout of at least 20000 ms and run_in_background=false. Wait for it to finish, then reply with the concatenation of RESTART and _TUI_OK, nothing else.`, { delay: typingDelay })
      // Separate ordinary submission from Codex's native paste-burst newline guard.
      if (harness === "codex") await packaged.page.waitForTimeout(200)
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
      if (child) {
        const files = await fs.readdir(path.join(home, ".claude", "projects"), { recursive: true })
        const transcripts = files.filter((file) => file.includes("/subagents/") && file.endsWith(".jsonl"))
        expect(transcripts.length, "The actual Claude CLI must have run a subagent").toBeGreaterThan(0)
        const contents = await Promise.all(transcripts.map((file) => fs.readFile(path.join(home, ".claude", "projects", file), "utf8")))
        expect(contents.some((content) => content.includes("CHILD_FINISHED"))).toBe(true)
        const hookFiles = await fs.readdir(rawHookDirectory)
        const hooks = await Promise.all(hookFiles.map(async (file) =>
          JSON.parse(await fs.readFile(path.join(rawHookDirectory, file), "utf8")) as {
            hook_event_name?: string
            background_tasks?: Array<{ status?: string }>
          }))
        expect(hooks.some((hook) => hook.hook_event_name === "SubagentStart"), "The real provider must start a child").toBe(true)
        expect(hooks.some((hook) => hook.hook_event_name === "SubagentStop"), "The real provider must finish that child").toBe(true)
        if (pause) {
          expect(hooks.some((hook) => hook.hook_event_name === "Stop" && hook.background_tasks?.some((task) => task.status === "running")),
            "The parent must actually yield with a running background child; merely requesting background execution is insufficient").toBe(true)
        }

        const events = await packaged.page.evaluate(() => {
          const state = window as unknown as { __claxedoChildLifecycle: string[]; __claxedoChildStream: EventSource }
          state.__claxedoChildStream.close()
          return state.__claxedoChildLifecycle
        })
        await test.info().attach("child-parent-lifecycle", { body: JSON.stringify(events), contentType: "application/json" })
        expect(events.at(-1)).toBe("Idle")
        expect(events.slice(0, -1), "Child completion must never settle the still-running parent").not.toContain("Idle")
      }
      await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-restarted.png`) })
      if (!child && (harness === "claude" || harness === "codex")) {
        const restoredRows = packaged.page.locator(`${selector} .xterm-rows`)
        await packaged.page.locator(`${selector} .xterm-helper-textarea`).focus()
        // Native first-run notices can appear after a completed turn. Exercise
        // their visible interaction before proving the next prompt is intact.
        const notice = (await restoredRows.innerText()).includes("Press Enter to continue")
        await test.info().attach(`${harness}-continuation-notice`, { body: JSON.stringify({ notice }), contentType: "application/json" })
        if (notice) {
          await packaged.page.keyboard.press("Enter")
          await expect(restoredRows).not.toContainText("Press Enter to continue")
        }
        const prompt = "What is the capital of France? Answer with only the city name."
        await packaged.page.keyboard.type(prompt, { delay: typingDelay })
        await expect(restoredRows).toContainText(prompt)
        // Codex 0.153.4 deliberately treats Enter within 120 ms of a
        // paste-like burst as a newline. Separate ordinary submission from
        // the explicit burst case below instead of depending on event timing.
        if (harness === "codex") await packaged.page.waitForTimeout(200)
        await packaged.page.keyboard.press("Enter")
        await expect.poll(async () => {
          const response = await fetch(lifecycleUrl)
          expect(response.ok).toBe(true)
          const body = await response.json() as { session: { prompt?: string; eventType?: string } | null }
          return body.session
        }, { timeout: 90_000, message: "Another native turn must receive the full prompt and complete after restart" }).toMatchObject({ prompt, eventType: "Idle" })
        await expect(restoredRows).toContainText("Paris")
        await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-tui-third-turn.png`) })
        if (harness === "codex") {
          const burstPrompt = "What is the capital of Italy? Answer with only the city name."
          await packaged.page.keyboard.type(burstPrompt, { delay: 0 })
          await packaged.page.keyboard.press("Enter")
          await expect(restoredRows).toContainText(burstPrompt)
          await packaged.page.waitForTimeout(200)
          const held = await (await fetch(lifecycleUrl)).json() as { session: { prompt?: string; eventType?: string } }
          expect(held.session, "Burst Enter must preserve the draft without submitting a partial turn").toMatchObject({ prompt, eventType: "Idle" })
          await packaged.page.screenshot({ path: test.info().outputPath("codex-tui-held-burst.png") })
          await packaged.page.keyboard.press("Enter")
          await expect.poll(async () => {
            const response = await fetch(lifecycleUrl)
            expect(response.ok).toBe(true)
            return (await response.json() as { session: { prompt?: string; eventType?: string } }).session
          }, { timeout: 90_000 }).toMatchObject({ prompt: burstPrompt, eventType: "Idle" })
          await expect(restoredRows).toContainText("Rome")
          await packaged.page.screenshot({ path: test.info().outputPath("codex-tui-burst-submitted.png") })
        }
      }
      if (!child && (harness === "codex" || harness === "claude")) {
        const terminal = packaged.page.locator(selector)
        const audioCount = await packaged.page.evaluate(() =>
          (window as unknown as { __claxedoAudioEnded: unknown[] }).__claxedoAudioEnded.length)
        await terminal.locator(".xterm-helper-textarea").focus()
        const cancelPrompt = "Run sh -c 'echo $$ > .cancel-started; sleep 60; touch .cancel-finished' in the foreground. Do not run other commands."
        await packaged.page.keyboard.type(cancelPrompt, { delay: typingDelay })
        await packaged.page.waitForTimeout(200)
        await packaged.page.keyboard.press("Enter")
        await expect.poll(() => fs.access(path.join(directory, ".cancel-started")).then(() => true, () => false), { timeout: 45_000 }).toBe(true)
        const commandPid = Number((await fs.readFile(path.join(directory, ".cancel-started"), "utf8")).trim())
        expect(Number.isSafeInteger(commandPid) && commandPid > 0).toBe(true)
        process.kill(commandPid, 0)
        const cancelReceived = await (await fetch(lifecycleUrl)).json() as { session: { prompt?: string } }
        await test.info().attach(`${harness}-received-cancel-prompt`, { body: JSON.stringify(cancelReceived.session), contentType: "application/json" })
        expect.soft(cancelReceived.session.prompt, "Cancellation setup must preserve the entire submitted prompt").toBe(cancelPrompt)
        await expectTerminalRailStatus({ page: packaged.page, terminalId: pty.id, status: "working" })
        await packaged.page.keyboard.press("Escape")
        await packaged.page.getByRole("button", { name: "New Session", exact: true }).click()
        await expect.poll(() => {
          try { process.kill(commandPid, 0); return true }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
            throw error
          }
        }, { timeout: 15_000, message: "The interrupted native command process must actually exit" }).toBe(false)
        await test.info().attach(`${harness}-cancelled-process`, { body: JSON.stringify({ commandPid, exitedBeforeTeardown: true }), contentType: "application/json" })
        await expect.poll(async () => {
          const response = await fetch(lifecycleUrl)
          return (await response.json() as { session: { eventType?: string } }).session?.eventType
        }, { timeout: 15_000, message: `Interrupting the native ${harness} tool must settle the terminal` }).toBe("Idle")
        expect(await fs.access(path.join(directory, ".cancel-finished")).then(() => true, () => false)).toBe(false)
        expect(await packaged.page.evaluate(() =>
          (window as unknown as { __claxedoAudioEnded: unknown[] }).__claxedoAudioEnded.length)).toBe(audioCount)
        await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-native-cancelled.png`) })
        await packaged.page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${pty.id}"]`).click()
        await terminal.locator(".xterm-helper-textarea").focus()
        const followup = "What is the capital of Japan? Answer with only the city name."
        await packaged.page.keyboard.type(followup, { delay: typingDelay })
        await packaged.page.waitForTimeout(200)
        await packaged.page.keyboard.press("Enter")
        await expect.poll(async () => {
          const response = await fetch(lifecycleUrl)
          expect(response.ok).toBe(true)
          return (await response.json() as { session: { prompt?: string; eventType?: string } }).session
        }, { timeout: 90_000 }).toMatchObject({ prompt: followup, eventType: "Idle" })
        await expect(terminal.locator(".xterm-rows")).toContainText("Tokyo")
        expect(await fs.access(path.join(directory, ".cancel-finished")).then(() => true, () => false)).toBe(false)
        await packaged.page.screenshot({ path: test.info().outputPath(`${harness}-native-cancel-followup.png`) })
      }
      if (harness === "amp") {
        await packaged.page.evaluate(async ({ server, terminalId, directory }) => {
          const events: unknown[] = []
          const stream = new EventSource(`${server}/api/wr/events?directory=${encodeURIComponent(directory)}`)
          Object.assign(window, { __ampCancellationEvents: events, __ampCancellationStream: stream })
          stream.onmessage = (message) => {
            const frame = JSON.parse(message.data)
            const event = frame.payload ?? frame
            if (event.type === "agent.lifecycle" && event.terminalId === terminalId) events.push(event)
          }
          await new Promise<void>((resolve, reject) => {
            stream.onopen = () => resolve()
            stream.onerror = () => reject(new Error("Amp cancellation observation stream failed"))
          })
        }, { server, terminalId: pty.id, directory })
        const terminal = packaged.page.locator(selector)
        await terminal.locator(".xterm-helper-textarea").focus()
        await packaged.page.keyboard.type("Run sleep 60 in the foreground. Only after it finishes reply CANCEL_SHOULD_NOT_FINISH.", { delay: 15 })
        await packaged.page.keyboard.press("Enter")
        await expectTerminalRailStatus({ page: packaged.page, terminalId: pty.id, status: "working" })
        await expect(terminal.locator(".xterm-rows > div").filter({ hasText: /^[^A-Za-z]*sleep 60\s*$/ })).toBeVisible({ timeout: 45_000 })
        await packaged.page.screenshot({ path: test.info().outputPath("amp-before-cancel.png") })
        await packaged.page.keyboard.press("Escape")
        await packaged.page.screenshot({ path: test.info().outputPath("amp-first-escape.png") })
        const afterFirstEscape = await (await fetch(lifecycleUrl)).json() as { session: { eventType?: string } | null }
        await test.info().attach("amp-first-escape-status", { body: JSON.stringify(afterFirstEscape.session?.eventType), contentType: "application/json" })
        if (afterFirstEscape.session?.eventType === "Busy") {
          await expectTerminalRailStatus({ page: packaged.page, terminalId: pty.id, status: "working" })
        }
        await packaged.page.keyboard.press("Escape")
        await packaged.page.screenshot({ path: test.info().outputPath("amp-second-escape.png") })
        await packaged.page.getByRole("button", { name: "New Session", exact: true }).click()
        await expect.poll(async () => {
          const body = await (await fetch(lifecycleUrl)).json() as { session: { eventType?: string } | null }
          return body.session?.eventType
        }, { timeout: 15_000, message: "Cancelling Amp must settle its real terminal state" }).toBe("Idle")
        const observed = await packaged.page.evaluate(() => {
          const state = window as unknown as { __ampCancellationEvents: unknown[]; __ampCancellationStream: EventSource }
          state.__ampCancellationStream.close()
          return state.__ampCancellationEvents
        })
        await test.info().attach("amp-cancellation-lifecycle", { body: JSON.stringify(observed), contentType: "application/json" })
        expect(observed.at(-1), "The provider must identify cancellation, rather than successful completion").toMatchObject({ outcome: "cancelled" })
        await packaged.page.screenshot({ path: test.info().outputPath("amp-cancelled-background.png") })
        await expectTerminalRailStatusAbsent({ page: packaged.page, terminalId: pty.id })
        // Allow an incorrectly queued audio clip to finish before checking silence.
        await packaged.page.waitForTimeout(2000)
        expect(await packaged.page.evaluate(() => (window as unknown as { __claxedoAudioEnded: unknown[] }).__claxedoAudioEnded.length)).toBe(1)
      }
      journeyCompleted = true
    } finally {
      if (harness === "amp" && packaged && !packaged.page.isClosed()) {
        const row = packaged.page.locator('[data-testid="rail-sidebar-terminal-row"]').first()
        if (await row.isVisible()) await row.click()
        await test.info().attach("amp-rendered-rows", { body: await packaged.page.locator(".xterm-rows").evaluateAll((rows) => rows.map((row) => row.innerHTML).join("\n")), contentType: "text/html" })
        const events = await packaged.page.evaluate(() => {
          const state = window as unknown as { __ampCancellationEvents?: unknown[]; __ampCancellationStream?: EventSource }
          state.__ampCancellationStream?.close()
          return state.__ampCancellationEvents ?? []
        })
        await test.info().attach("amp-cancellation-observed", { body: JSON.stringify(events), contentType: "application/json" })
      }
      if (harness === "claude") {
        const files = await fs.readdir(rawHookDirectory).catch(() => [])
        const hooks = await Promise.all(files.map(async (file) => ({
          file, payload: await fs.readFile(path.join(rawHookDirectory, file), "utf8"),
        })))
        await test.info().attach("raw-provider-hooks", { body: JSON.stringify(hooks), contentType: "application/json" })
      }
      if (ptyUrl) ptyStates.push({ phase: "cleanup", at: Date.now(), pty: await fetch(ptyUrl).then((response) => response.json()).catch(() => null) })
      await test.info().attach("pty-state", { body: JSON.stringify(ptyStates), contentType: "application/json" })
      await test.info().attach("pty-traffic", { body: JSON.stringify(traffic), contentType: "application/json" })
      if (packaged && !packaged.page.isClosed()) await test.info().attach("audio-ended", { body: JSON.stringify(await packaged.page.evaluate(() => (window as unknown as { __claxedoAudioEnded?: unknown }).__claxedoAudioEnded ?? [])), contentType: "application/json" })
      if (packaged && !packaged.page.isClosed()) await packaged.page.screenshot({ path: test.info().outputPath("terminal-final-state.png") }).catch(() => undefined)
      if (packaged) await test.info().attach("desktop-log", { body: packaged.appLog.join(""), contentType: "text/plain" })
      await packaged?.close()
      await shutdownPackagedTestDaemon(profile, async () => {
        if (ptyUrl) {
          const removed = await fetch(ptyUrl, { method: "DELETE" })
          expect(removed.ok, "Final teardown must remove the test terminal").toBe(true)
        }
      })
      if (harness === "codex") await test.info().attach("codex-hook-environment", {
        body: await fs.readFile(path.join(root, "codex-hook-environment.txt"), "utf8").catch(() => "No hook execution recorded"), contentType: "text/plain",
      })
      if (journeyCompleted) await fs.rm(root, { recursive: true, force: true })
      else await test.info().attach("preserved-test-root", { body: root, contentType: "text/plain" })
    }
  })
}
