import { expectToolErrorRecovery } from "../helpers/tool-error-recovery"
import { expectAssistantReplyVisible } from "../helpers/turn-oracle"
import { expect, test, type Locator } from "@playwright/test"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { expectServerReachable, launchPackagedApp, type PackagedApp } from "../helpers/electron-app"
import { shutdownPackagedTestDaemon } from "../helpers/desktop-daemon"
import { composeText } from "../helpers/web-signed-relay-harness"

const execFileAsync = promisify(execFile)

async function compose(input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
}

for (const harness of ["Codex", "Claude"] as const) {
for (const flow of ["Documents MCP read", "MCP error recovery", "Composio MCP discovery", "Composio authenticated MCP", "unavailable model recovery across full restart", "unavailable model recovery after daemon restart", "running tool completes across full restart", "running tool stops across full restart", "permission Allow always across full restart", "permission Allow always redirection across full restart", "permission Allow once across full restart", "permission Deny across full restart", "permission Stop across full restart", "reply", "tasks across full restart", "tool error recovery across full restart", "question answer across full restart", "question dismiss across full restart", "question stop across full restart"] as const) {
test(`packaged app completes a real ${harness}-authenticated session: ${flow} @live @surface-desktop`, async () => {
  test.setTimeout(240_000)
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-desktop-${harness.toLowerCase()}-`)))
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-live-${harness.toLowerCase()}-profile-`))
  const releaseFile = path.join(directory, ".task-release")
  const launch = () => launchPackagedApp({
    timeoutMs: 60_000,
    userDataDir: profile,
    preserveUserDataDir: true,
    env: flow.startsWith("Composio")
      ? { CODEX_HOME: path.join(directory, ".codex-test") }
      : harness === "Codex" ? { CODEX_HOME: path.join(os.homedir(), ".codex") } : {},
  })
  let permissionOutputDir: string | undefined
  let cleanupDocumentSession: (() => Promise<void>) | undefined
  let packaged: PackagedApp | undefined
  try {
    await execFileAsync("git", ["init"], { cwd: directory })
    await fs.writeFile(path.join(directory, "README.md"), `Real ${harness} desktop proof.\n`)
    if (flow.startsWith("Composio") && harness === "Codex") {
      const codexHome = path.join(directory, ".codex-test")
      await fs.mkdir(codexHome, { recursive: true })
      await fs.copyFile(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"))
    }
    packaged = await launch()
    const serverBase = new URL(await expectServerReachable(packaged, 45_000)).origin
    const resolve = await fetch(
      `${serverBase}/api/claxedo/workspace/resolve?directory=${encodeURIComponent(directory)}&create=true`,
    )
    const resolved = await resolve.json() as { workspaceId?: string; error?: unknown }
    expect(resolve.status, JSON.stringify(resolved)).toBe(200)
    expect(resolved.workspaceId).toBeTruthy()
    const workspaceId = resolved.workspaceId!

    await packaged.page.evaluate(async (worktree) => {
      const api = (window as unknown as {
        api: { storeSet(name: string, key: string, value: string): Promise<void> }
      }).api
      await api.storeSet("claxedo.global.dat", "server", JSON.stringify({
        list: [],
        projects: { local: [{ worktree, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }))
    }, directory)
    await packaged.page.reload()
    await packaged.page.waitForLoadState("domcontentloaded")

    if (flow.startsWith("Composio")) {
      await packaged.page.getByText("Marketplace", { exact: true }).click()
      await packaged.page.getByRole("searchbox", { name: "Search plugins" }).fill("composio")
      const card = packaged.page.locator("[data-agent-plugin-card]").filter({ hasText: /composio/i })
      await expect(card).toHaveCount(1, { timeout: 45_000 })
      await card.locator("[data-directory-card-open]").click()
      const detail = packaged.page.locator('[data-component="agent-plugin-detail"]')
      await detail.getByRole("button", { name: "Add", exact: true }).click()
      const install = packaged.page.getByRole("dialog")
      for (const id of ["opencode", "claude", "codex", "cursor"]) {
        await install.getByRole("checkbox", { name: id, exact: true }).setChecked(id === harness.toLowerCase())
      }
      await install.getByRole("button", { name: "Add plugin", exact: true }).click()
      await expect(install).not.toBeVisible()
      await expect(detail.getByRole("button", { name: "Disable", exact: true })).toBeVisible()
    }

    const project = packaged.page.locator(`[data-testid="project-group"][data-project-id="${workspaceId}"]`)
    await expect(project).toBeVisible({ timeout: 30_000 })
    // The header's action cluster mounts on engagement (hover, focus or an
    // explicit hold — `rail-hover-engagement.ts`), so the pointer has to reach
    // the header before its "New session" button exists.
    await project.locator('[data-testid="project-header"]').hover()
    await project.locator('[aria-label="New session in main"]').click()

    const input = packaged.page.locator('[role="textbox"][aria-label*="Ask anything"]:visible').last()
    await expect(input).toBeVisible({ timeout: 20_000 })
    const control = packaged.page.locator('[data-action="prompt-harness-model"]:visible').last()
    await control.click()
    const picker = packaged.page.locator('[data-component="harness-model-picker"]')
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    // Native harnesses have unique rows; configured ACP connections use their own group.
    const nativeHarness = picker.getByRole("button", { name: harness === "Codex" ? /^Codex$/ : /^Claude$/ }).first()
    await nativeHarness.click()
    await picker.locator('[data-slot="harness-picker-section"]').first().click()
    await expect(nativeHarness, `${harness} harness did not become selected`).toHaveAttribute(
      "aria-current",
      "true",
      { timeout: 45_000 },
    )
    await packaged.page.keyboard.press("Escape")
    await expect(control).not.toContainText(/Loading models|Select model|^$/, { timeout: 45_000 })

    if (harness === "Claude") {
      await control.click()
      await picker.locator('[data-slot="list-item"]').filter({ has: packaged.page.locator('[data-slot="list-item-name"]').filter({ hasText: "Opus" }) }).first().click()
      await expect(control).toContainText("Opus")
      await packaged.page.keyboard.press("Escape")
    }

    if (flow === "Documents MCP read") {
      const marker = `DOCUMENT_PROOF_${Date.now()}`
      const file = path.join(directory, "agent-document.md")
      const contents = `# Agent document\n\nProof phrase: ${marker}\n`
      await fs.writeFile(file, contents)
      const registered = await fetch(`${serverBase}/documents/from-repo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory, workspace_id: workspaceId, path: "agent-document.md", display_name: "Agent document" }),
      })
      expect(registered.ok, await registered.clone().text()).toBe(true)
      const document = await registered.json() as { id: string }
      const prompt = `Use the Claxedo MCP server named claxedo. First call documents_list for this workspace, then documents_open for document ${document.id}. Read the returned canonical path using your file-reading tool and report the proof phrase stored inside. Do not search for the file independently, modify files, or use another integration.`
      await compose(input, prompt)
      const creation = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      cleanupDocumentSession = async () => {
        const response = await fetch(`${serverBase}/session/${session.id}/abort?directory=${encodeURIComponent(directory)}`, { method: "POST" })
        expect(response.ok, "Document test cleanup must cancel any unfinished tool approval").toBe(true)
      }
      type Part = { id: string; type: string; tool?: string; text?: string; state?: { status: string; output?: string } }
      const read = async (): Promise<Part[]> => {
        const response = await fetch(`${serverBase}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
        expect(response.ok).toBe(true)
        return (await response.json() as Array<{ parts: Part[] }>).flatMap((message) => message.parts)
      }
      try {
        await expect.poll(async () => (await read()).some((part) => (part.tool ?? "").includes("documents_list") && part.state?.status === "completed"), { timeout: 90_000 }).toBe(true)
        if (harness === "Codex") {
          const dock = packaged.page.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
          await expect(dock).toContainText('run tool "documents_open"', { timeout: 90_000 })
          expect((await read()).some((part) => (part.tool ?? "").includes("documents_open") && part.state?.status === "completed")).toBe(false)
          await dock.getByText("Allow once", { exact: true }).click()
          await dock.getByRole("button", { name: "Submit", exact: true }).click()
        }
        await expect.poll(async () => (await read()).some((part) => (part.tool ?? "").includes("documents_open") && part.state?.status === "completed"), { timeout: 90_000 }).toBe(true)
        await expect(packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').filter({ hasText: marker })).toBeVisible({ timeout: 90_000 })
        expect(await fs.readFile(file, "utf8")).toBe(contents)
        const opened = (await read()).find((part) => (part.tool ?? "").includes("documents_open") && part.state?.status === "completed")!
        expect(opened.state?.output).toContain(document.id)
        await packaged.page.reload()
        expect((await read()).find((part) => part.id === opened.id)).toEqual(opened)
        await expect(packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').filter({ hasText: marker })).toBeVisible()
      } finally {
        await test.info().attach("document-mcp-parts", { body: JSON.stringify(await read(), null, 2), contentType: "application/json" })
      }
      return
    }

    if (flow === "MCP error recovery") {
      const missing = `missing-session-${Date.now()}`
      const failedPrompt = `Use only the Claxedo MCP server named claxedo. Call session_get once with session=${missing}. This deliberately nonexistent session checks error reporting. Do not retry or use shell tools. After the tool returns, briefly report its error.`
      await compose(input, failedPrompt)
      const creation = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      type Tool = { id: string; type: string; tool?: string; state?: { status: string; error?: string; output?: string } }
      const read = async () => {
        const response = await fetch(`${serverBase}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
        expect(response.ok).toBe(true)
        return (await response.json() as Array<{ parts: Tool[] }>).flatMap((row) => row.parts).filter((part) => part.type === "tool")
      }
      try {
        await expect.poll(async () => (await read()).some((part) => /session_get/.test(part.tool ?? "") && part.state?.status === "error"), { timeout: 90_000 }).toBe(true)
        const failed = (await read()).find((part) => /session_get/.test(part.tool ?? "") && part.state?.status === "error")!
        expect(failed.state?.error).toBeTruthy()
        const card = packaged.page.locator(`[data-timeline-part-id="${failed.id}"] [data-kind="tool-error-card"]`)
        await expect(card).toBeVisible()
        await packaged.page.reload()
        await expect(card).toBeVisible()
        expect((await read()).find((part) => part.id === failed.id)).toEqual(failed)
        // Qualify recovery after completion; reload's transient Send state is not proof of idleness.
        await expect.poll(async () => {
          const response = await fetch(`${serverBase}/session/status?directory=${encodeURIComponent(directory)}`)
          expect(response.ok).toBe(true)
          const statuses = await response.json() as Record<string, { type: string }>
          return statuses[session.id]?.type ?? "idle"
        }, { timeout: 90_000 }).toBe("idle")
        const prompt = `Use only the Claxedo MCP server named claxedo. Call session_get once with session=${session.id}. Report whether it succeeded. Do not use shell tools or any other integration.`
        await compose(packaged.page.locator('[role="textbox"][aria-label*="Ask anything"]:visible').last(), prompt)
        await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send", { timeout: 45_000 })
        const admission = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/session/${session.id}/prompt_async`))
        await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
        const admitted = await admission
        expect(admitted.ok(), `Recovery admission ${admitted.status()}`).toBe(true)
        await expect.poll(async () => (await read()).some((part) => /session_get/.test(part.tool ?? "") && part.state?.status === "completed" && part.state.output?.includes(session.id)), { timeout: 90_000 }).toBe(true)
        await packaged.page.reload()
        await expect(card).toBeVisible()
        expect((await read()).find((part) => part.id === failed.id)).toEqual(failed)
      } finally {
        await test.info().attach("mcp-error-recovery-tools", { body: JSON.stringify(await read(), null, 2), contentType: "application/json" })
      }
      return
    }

    if (flow.startsWith("Composio")) {
      await compose(input, flow === "Composio MCP discovery" ? "Use only the installed Composio MCP integration to discover tools for reading my Gmail profile. Perform only tool discovery and summarize whether authorization is required. Do not read account data, send anything, or use other tools." : "Use the installed Composio MCP integration to discover tools for reading my connected account profile. After discovery, if Gmail is already connected, execute only GMAIL_GET_PROFILE through COMPOSIO_MULTI_EXECUTE_TOOL and report whether it succeeded, without printing the email address. If authorization is missing, report that instead. Do not read messages, list labels, modify accounts, send anything, use shell commands, or substitute another integration.")
      const creation = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      type Part = { type: string; tool?: string; text?: string; state?: { status: string; output?: string; input?: { server?: string; arguments?: unknown; pluginId?: string | null } } }
      let parts: Part[] = []
      try {
        await expect.poll(async () => {
          const response = await fetch(`${serverBase}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
          expect(response.ok).toBe(true)
          parts = (await response.json() as Array<{ parts: Part[] }>).flatMap((row) => row.parts)
          return parts.some((part) => {
            if (part.type !== "tool" || part.state?.status !== "completed") return false
            if (flow === "Composio MCP discovery") {
              if (!/COMPOSIO_SEARCH_TOOLS/i.test(part.tool ?? "")) return false
              if (harness === "Codex") {
                expect(part.state.input?.server).toMatch(/composio/i)
                expect(part.state.input?.pluginId).toBe("composio@claxedo-agent-plugins")
                expect(part.state.input?.arguments).toBeTruthy()
              }
              return true
            }
            if (!/COMPOSIO_MULTI_EXECUTE_TOOL/i.test(part.tool ?? "")) return false
            const output = JSON.parse(part.state.output ?? "null") as { data?: { results?: Array<{ tool_slug?: string; response?: { successful?: boolean } }> } } | null
            return output?.data?.results?.some((result) => result.tool_slug === "GMAIL_GET_PROFILE" && result.response?.successful === true) === true
          })
        }, { timeout: 90_000, message: `${harness} must actually invoke Composio; prose about unavailable tools is not a pass` }).toBe(true)
      } finally {
        await test.info().attach("composio-session-parts", { body: JSON.stringify(parts, null, 2), contentType: "application/json" })
      }
      await expect(packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').last()).toBeVisible()
      return
    }

    if (flow.startsWith("unavailable model recovery")) {
      const warmup = `MODEL_WARMUP_${Date.now()}`
      await compose(input, `Reply with exactly this token: ${warmup}`)
      const creation = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      await expectAssistantReplyVisible(packaged.page, warmup)
      if (flow.endsWith("after daemon restart")) {
        await packaged.close()
        await shutdownPackagedTestDaemon(profile)
        packaged = await launch()
        expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
        await expectAssistantReplyVisible(packaged.page, warmup)
      }
      const marker = `MODEL_RECOVERED_${Date.now()}`
      const prompt = `Context: café — नमस्ते.\n\nReply with exactly this token: ${marker}`
      // Seed a stale/unavailable model through the actual prompt API. The real
      // CLI/provider must produce the error; no intercepted response or event.
      const failure = await fetch(`${serverBase}/session/${session.id}/prompt_async?directory=${encodeURIComponent(directory)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: prompt }], model: { providerID: harness.toLowerCase(), modelID: "claxedo-unavailable-model-for-recovery-test" } }),
      })
      expect(failure.status).toBe(204)
      const recoveryButton = () => packaged!.page.getByRole("button", { name: "Switch model and resend", exact: true })
      await expect(recoveryButton()).toBeVisible({ timeout: 60_000 })
      const appProcess = packaged.app.process()
      await packaged.close()
      await expect.poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
      packaged = await launch()
      expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
      await recoveryButton().click()
      const dialog = packaged.page.getByRole("dialog")
      await expect(dialog).toBeVisible()
      await packaged.page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      const readUsers = async () => {
        const response = await fetch(`${serverBase}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
        expect(response.ok).toBe(true)
        const rows = await response.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
        return rows.filter((row) => row.info.role === "user").map((row) => row.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
      }
      expect(await readUsers()).toHaveLength(2)
      await recoveryButton().click()
      const name = harness === "Claude" ? /Opus/ : /GPT-5\.6-Sol/i
      const choice = dialog.locator('[data-slot="list-item"]').filter({ hasText: name }).first()
      await expect(choice).toBeVisible({ timeout: 10_000 })
      await choice.click()
      await expectAssistantReplyVisible(packaged.page, marker)
      expect(await readUsers()).toEqual([`Reply with exactly this token: ${warmup}`, prompt, prompt])
      await packaged.page.reload()
      await expectAssistantReplyVisible(packaged.page, marker)
      return
    }

    if (flow === "running tool completes across full restart" || flow === "running tool stops across full restart") {
      const stop = flow === "running tool stops across full restart"
      const pidFile = path.join(directory, "running.pid")
      const journal = path.join(directory, "execution.log")
      const script = path.join(directory, "running.cjs")
      const marker = `RUNNING_TOOL_${Date.now()}`
      await fs.writeFile(script, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(journal)},'start\\n');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(releaseFile)}))return;clearInterval(timer);fs.appendFileSync(${JSON.stringify(journal)},'finish\\n');console.log(${JSON.stringify(marker)});},50);`)
      await packaged.page.locator('[data-action="prompt-permission-mode"]').last().click()
      await packaged.page.locator(`[data-permission-mode-row][data-mode="${harness === "Claude" ? "bypassPermissions" : "full-access"}"]`).click()
      const command = `node '${script}'`
      await compose(input, `Run exactly this command once: ${command}. ` +
        (harness === "Claude" ? 'Use Bash with timeout 120000. ' : 'Use exec_command with yield_time_ms 30000. ') +
        `Wait for it to finish. The test runner releases it; do not create the release file, retry the command or use other tools. After it finishes, reply exactly ${marker}.`)
      const creation = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      await expect.poll(() => fs.readFile(pidFile, "utf8").catch(() => ""), { timeout: 60_000 }).toMatch(/^\d+$/)
      const pid = Number(await fs.readFile(pidFile, "utf8"))
      const alive = async () => {
        try {
          const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)])
          return !!stdout.trim() && !stdout.trim().startsWith("Z")
        } catch (error) { if ((error as { code?: number }).code === 1) return false; throw error }
      }
      const readTools = async () => {
        const response = await fetch(`${serverBase}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
        expect(response.ok).toBe(true)
        const rows = await response.json() as Array<{ parts: Array<{ type: string; id: string; state?: { status: string; input?: unknown; output?: string } }> }>
        return rows.flatMap((row) => row.parts).filter((part) => part.type === "tool" && JSON.stringify(part.state?.input).includes(script))
      }
      const tools = await readTools()
      expect(tools).toHaveLength(1)
      expect(tools[0]!.state?.status).toBe("running")
      expect(await fs.readFile(journal, "utf8")).toBe("start\n")
      const next = "Paris"
      const draft = `I’m planning a trip from Delhi (दिल्ली). My notes include café, <tags> and "quotes".\n\nWhat is the capital of France? Please answer in English from general knowledge, without running commands.`
      if (!stop) await composeText(packaged.page, packaged.page.getByRole("textbox", { name: /Ask anything/i }).last(), draft)
      await packaged.page.addInitScript(() => {
        const state = window as typeof window & { __prematureSessionSend?: boolean }
        state.__prematureSessionSend = false
        new MutationObserver(() => {
          const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-action="prompt-submit"]'))
          if (buttons.some((button) => button.getAttribute("aria-label") === "Send" && !button.disabled && button.getClientRects().length > 0)) {
            state.__prematureSessionSend = true
          }
        }).observe(document, { childList: true, subtree: true, attributes: true })
      })
      await packaged.page.reload()
      await expect(packaged.page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
      expect(await packaged.page.evaluate(() => (window as typeof window & { __prematureSessionSend?: boolean }).__prematureSessionSend), "a running session must not offer Send while reloading").toBe(false)
      const appProcess = packaged.app.process()
      await packaged.close()
      await expect.poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
      expect(await alive()).toBe(true)
      packaged = await launch()
      expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
      expect(await alive()).toBe(true)
      expect(await readTools()).toEqual(tools)
      if (!stop) await expect(packaged.page.getByRole("textbox", { name: /Ask anything/i }).last()).toHaveText(draft, { useInnerText: true })
      await expect(packaged.page.getByRole("button", { name: "Stop", exact: true })).toBeVisible()
      expect(await fs.readFile(journal, "utf8")).toBe("start\n")
      await packaged.page.screenshot({ path: test.info().outputPath("running-tool-after-restart.png") })
      if (stop) {
        await packaged.page.getByRole("button", { name: "Stop", exact: true }).click()
        await expect.poll(alive, { timeout: 15_000 }).toBe(false)
      }
      await fs.writeFile(releaseFile, "release")
      if (!stop) await expectAssistantReplyVisible(packaged.page, marker)
      await expect.poll(async () => (await readTools())[0]?.state?.status).toBe(stop ? "error" : "completed")
      const settled = await readTools()
      expect(settled).toHaveLength(1)
      expect(settled[0]!.id).toBe(tools[0]!.id)
      if (!stop) expect(settled[0]!.state?.output).toContain(marker)
      expect(await fs.readFile(journal, "utf8")).toBe(stop ? "start\n" : "start\nfinish\n")
      if (stop) await composeText(packaged.page, packaged.page.getByRole("textbox", { name: /Ask anything/i }).last(), draft)
      else await expect(packaged.page.getByRole("textbox", { name: /Ask anything/i }).last()).toHaveText(draft, { useInnerText: true })
      await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      await expectAssistantReplyVisible(packaged.page, next)
      await packaged.page.reload()
      await expectAssistantReplyVisible(packaged.page, next)
      expect(await readTools()).toEqual(settled)
      expect(await fs.readFile(journal, "utf8")).toBe(stop ? "start\n" : "start\nfinish\n")
      const historyResponse = await fetch(`${serverBase}/session/${session.id}/message?directory=${encodeURIComponent(directory)}`)
      expect(historyResponse.ok).toBe(true)
      const history = await historyResponse.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
      const users = history.filter((row) => row.info.role === "user")
      expect(users).toHaveLength(2)
      expect(users[1]!.parts.filter((part) => part.type === "text").map((part) => part.text).join("")).toBe(draft)

      return
    }

    if (flow.startsWith("permission ")) {
      const decision = flow.slice("permission ".length).replace(" across full restart", "").replace(" redirection", "")
      permissionOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-desktop-permission-"))
      const output = path.join(permissionOutputDir, "result.txt")
      const mode = harness === "Claude" ? "default" : "workspace-write"
      await packaged.page.locator('[data-action="prompt-permission-mode"]').last().click()
      await packaged.page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
      const marker = `DESKTOP_PERMISSION_${Date.now()}`
      const command = flow.includes("redirection")
        ? `printf '${marker}' > '${output}'`
        : `printf '${marker}' | tee '${output}'`
      const creation = packaged.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await compose(input, `Run exactly this shell command once: ${command}. ` +
        (harness === "Codex" ? 'Use exec_command with sandbox_permissions="require_escalated" and justification="Write the isolated test file". ' : "Use the Bash tool. ") +
        `Wait for approval. After execution reply exactly ${marker}. If denied reply exactly DENIED-${marker}. Do not use other tools or alternative write methods.`)
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      const query = `?directory=${encodeURIComponent(directory)}`
      const readPending = async () => {
        const response = await fetch(`${serverBase}/permission${query}`)
        expect(response.ok).toBe(true)
        return (await response.json() as Array<{ id: string; sessionID: string }>).filter((row) => row.sessionID === session.id)
      }
      await expect(packaged.page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })).toBeVisible({ timeout: 60_000 })
      const pending = await readPending()
      expect(pending).toHaveLength(1)
      expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
      const appProcess = packaged.app.process()
      await packaged.close()
      await expect.poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
      packaged = await launch()
      expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
      let dock = packaged.page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })
      await expect(dock).toBeVisible({ timeout: 30_000 })
      await expect(dock.locator('[data-slot="permission-command"]')).toContainText(command)
      expect(await readPending()).toEqual(pending)
      expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
      await packaged.page.screenshot({ path: test.info().outputPath("permission-after-restart.png") })
      await dock.getByRole("button", { name: decision, exact: true }).click()
      await expect(dock).toHaveCount(0)
      await expect.poll(readPending).toEqual([])
      if (decision !== "Stop") await expectAssistantReplyVisible(packaged.page, decision === "Deny" ? `DENIED-${marker}` : marker)
      if (decision === "Allow once" || decision === "Allow always") await expect.poll(() => fs.readFile(output, "utf8").catch(() => "")).toBe(marker)
      else expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
      if (decision === "Allow always") {
        await packaged.close()
        await shutdownPackagedTestDaemon(profile)
        packaged = await launch()
        dock = packaged.page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })
        expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
        await fs.rm(output)
        const repeated = `REPEATED_${marker}`
        const repeatedPrompt = `Run exactly the same shell command once: ${command}. ` +
          (harness === "Codex" ? 'Use exec_command with sandbox_permissions="require_escalated" and justification="Write the isolated test file". ' : "Use the Bash tool. ") +
          `After execution reply exactly ${repeated}. Do not use other tools or alternative write methods.`
        await compose(packaged.page.getByRole("textbox", { name: /Ask anything/i }).last(), repeatedPrompt)
        const [submitted] = await Promise.all([
          packaged.page.waitForResponse((response) => response.request().method() === "POST" &&
            new URL(response.url()).pathname.endsWith(`/session/${session.id}/prompt_async`)),
          packaged.page.locator('[data-action="prompt-submit"]:visible').last().click(),
        ])
        expect(submitted.ok(), `Repeated prompt returned ${submitted.status()}`).toBe(true)
        expect(submitted.request().postDataJSON().parts.filter((part: { type: string }) => part.type === "text")
          .map((part: { text: string }) => part.text).join("")).toBe(repeatedPrompt)
        await expect.poll(async () => {
          const response = await fetch(`${serverBase}/session/${session.id}/message${query}`)
          expect(response.ok).toBe(true)
          const history = await response.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
          return history.filter((row) => row.info.role === "user").map((row) =>
            row.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
        }).toContain(repeatedPrompt)
        try {
          await expect.poll(async () => (await readPending()).length ? "approval requested again" : fs.readFile(output, "utf8").catch(() => ""), { timeout: 60_000 }).toBe(marker)
        } catch (error) {
          const history = await fetch(`${serverBase}/session/${session.id}/message${query}`)
          const status = await fetch(`${serverBase}/session/status${query}`)
          const rendered = await packaged.page.evaluate(() => ({
            text: document.body.innerText,
            scroll: Array.from(document.querySelectorAll<HTMLElement>('[data-scrollable]')).map((element) => ({
              top: element.scrollTop, height: element.clientHeight, contentHeight: element.scrollHeight,
            })),
          }))
          await test.info().attach("permission-repeat-state", {
            contentType: "application/json",
            body: JSON.stringify({ history: await history.json(), statuses: await status.json(), pending: await readPending(), rendered }, null, 2),
          })
          await test.info().attach("permission-repeat-current-window", {
            contentType: "image/png", body: await packaged.page.screenshot(),
          })
          throw error
        }
        await expectAssistantReplyVisible(packaged.page, repeated)
        expect(await readPending()).toEqual([])
      }
      const late = await fetch(`${serverBase}/session/${session.id}/permissions/${pending[0]!.id}${query}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response: "always" }),
      })
      expect(late.status).toBe(404)
      const followup = `AFTER_PERMISSION_${Date.now()}`
      await compose(packaged.page.getByRole("textbox", { name: /Ask anything/i }).last(),
        `This is a new task. The previous tool task is over; do not retry it or repeat its marker. Reply exactly ${followup}. Do not use tools.`)
      await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      await expectAssistantReplyVisible(packaged.page, followup)
      await packaged.page.reload()
      await expectAssistantReplyVisible(packaged.page, followup)
      expect(await readPending()).toEqual([])
      await expect(dock).toHaveCount(0)
      if (decision === "Allow once" || decision === "Allow always") expect(await fs.readFile(output, "utf8")).toBe(marker)
      else expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
      return
    }

    if (flow === "question answer across full restart" || flow === "question dismiss across full restart" || flow === "question stop across full restart") {
      const action = flow === "question answer across full restart" ? "answer" : flow === "question dismiss across full restart" ? "dismiss" : "stop"
      const prefix = `DESKTOP_QUESTION_${Date.now()}`
      const creation = packaged.page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/session")
      await compose(input,
        (harness === "Claude"
          ? 'Use AskUserQuestion now with one question: header "Environment", question "Which test environment?", options [{"label":"Staging","description":"Isolated test environment"},{"label":"Production","description":"Production environment"}], multiSelect false. '
          : 'Use request_user_input now with one question: id "environment", header "Environment", question "Which test environment?", options [{"label":"Staging","description":"Isolated test environment"},{"label":"Production","description":"Production environment"}]. ') +
        `Wait for my answer, then reply exactly ${prefix}- followed by the selected label. If dismissed, reply exactly ${prefix}-DISMISSED and do not ask again. Do not run other tools.`)
      await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      const readQuestions = async () => {
        const response = await fetch(`${serverBase}/question?directory=${encodeURIComponent(directory)}`)
        expect(response.ok).toBe(true)
        return (await response.json() as Array<{ id: string; sessionID: string }>).filter((question) => question.sessionID === session.id)
      }
      await expect(packaged.page.locator('[data-component="dock-prompt"][data-kind="question"]')).toBeVisible({ timeout: 60_000 })
      const pending = await readQuestions()
      expect(pending).toHaveLength(1)
      const appProcess = packaged.app.process()
      await packaged.close()
      await expect.poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
      packaged = await launch()
      expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
      const dock = packaged.page.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
      await expect(dock).toContainText("Which test environment?")
      await expect(dock.locator('[data-slot="question-option"]', { hasText: "Staging" })).toContainText("Isolated test environment")
      expect(await readQuestions()).toEqual(pending)
      await packaged.page.screenshot({ path: test.info().outputPath("question-after-restart.png") })
      if (action === "answer") {
        await dock.locator('[data-slot="question-option"]', { hasText: "Staging" }).click()
        await dock.getByRole("button", { name: "Submit", exact: true }).click()
        await expectAssistantReplyVisible(packaged.page, `${prefix}-Staging`)
      } else {
        await dock.getByRole("button", { name: action === "dismiss" ? "Dismiss" : "Stop", exact: true }).click()
        if (action === "dismiss") await expectAssistantReplyVisible(packaged.page, `${prefix}-DISMISSED`)
      }
      await expect(dock).toHaveCount(0)
      expect(await readQuestions()).toEqual([])
      const late = await fetch(`${serverBase}/question/${pending[0]!.id}/reply?directory=${encodeURIComponent(directory)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: [["Production"]] }),
      })
      expect(late.status).toBe(404)
      const diagnostic: string[] = []
      packaged.page.on("pageerror", (error) => diagnostic.push(error.message))
      packaged.page.on("response", async (response) => {
        if (response.status() >= 400) diagnostic.push(`${response.status()} ${new URL(response.url()).pathname} ${await response.text().catch(() => "unavailable")}`)
      })
      packaged.page.on("console", (message) => { if (message.type() === "error") diagnostic.push(message.text()) })
      const marker = `AFTER_DESKTOP_QUESTION_${Date.now()}`
      await compose(packaged.page.getByRole("textbox", { name: /Ask anything/i }).last(), `This is a new task. The previous question task is over; do not answer it or repeat its marker. Reply with exactly this one token: ${marker}. Do not use tools.`)
      await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      try {
        await expectAssistantReplyVisible(packaged.page, marker)
      } catch (error) {
        const sessionResponse = await fetch(`${serverBase}/session/${session.id}?directory=${encodeURIComponent(directory)}`)
        const statusResponse = await fetch(`${serverBase}/session/status?directory=${encodeURIComponent(directory)}`)
        await test.info().attach("question-followup-diagnostic", { contentType: "application/json", body: JSON.stringify({
          errors: diagnostic, session: await sessionResponse.json(), statuses: await statusResponse.json(), pending: await readQuestions(),
        }, null, 2) })
        throw error
      }
      await packaged.page.reload()
      await expectAssistantReplyVisible(packaged.page, marker)
      await expect(dock).toHaveCount(0)
      expect(await readQuestions()).toEqual([])
      return
    }

    if (flow === "tool error recovery across full restart") {
      await packaged.page.locator('[data-action="prompt-permission-mode"]').last().click()
      await packaged.page.locator(`[data-permission-mode-row][data-mode="${harness === "Claude" ? "bypassPermissions" : "full-access"}"]`).click()
      let sessionID = ""
      const result = await expectToolErrorRecovery({ page: packaged.page, directory, backend: serverBase,
        sessionID: () => sessionID,
        run: async (command, marker) => {
          const page = packaged!.page
          const creation = !sessionID ? page.waitForResponse((response) =>
            response.request().method() === "POST" && new URL(response.url()).pathname === "/session") : undefined
          await compose(page.getByRole("textbox", { name: /Ask anything/i }).last(),
            `Run exactly this shell command once: ${command}. Use ${harness === "Claude" ? "Bash" : "exec_command"}. A nonzero exit is intentional; do not retry or repair it. After the tool returns, reply with exactly this one token: ${marker}`)
          await page.locator('[data-action="prompt-submit"]:visible').last().click()
          if (creation) {
            const response = await creation
            expect(response.ok()).toBe(true)
            sessionID = (await response.json() as { id: string }).id
          }
          await expectAssistantReplyVisible(page, marker)
        },
      })
      const appProcess = packaged.app.process()
      await packaged.close()
      await expect.poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
      packaged = await launch()
      expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
      await expect(packaged.page.locator(`[data-timeline-part-id="${result.failed.id}"] [data-kind="tool-error-card"]`)).toBeVisible()
      const response = await fetch(`${serverBase}/session/${sessionID}/message?directory=${encodeURIComponent(directory)}`)
      expect(response.ok).toBe(true)
      const messages = await response.json() as Array<{ parts: Array<{ id: string }> }>
      const parts = messages.flatMap((message) => message.parts)
      expect(parts.find((part) => part.id === result.failed.id)).toEqual(result.failed)
      expect(parts.find((part) => part.id === result.successful.id)).toEqual(result.successful)
      expect(await fs.readFile(path.join(directory, "recovered.txt"), "utf8")).toBe("recovered")
      const marker = `DESKTOP_AFTER_ERROR_RESTART_${Date.now()}`
      await compose(packaged.page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${marker}`)
      await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      await expectAssistantReplyVisible(packaged.page, marker)
      await packaged.page.screenshot({ path: test.info().outputPath("tool-error-after-restart.png") })
      return
    }

    if (flow === "tasks across full restart") {
      await packaged.page.locator('[data-action="prompt-permission-mode"]').last().click()
      await packaged.page.locator(`[data-permission-mode-row][data-mode="${harness === "Claude" ? "bypassPermissions" : "full-access"}"]`).click()
      const pidFile = path.join(directory, ".task-pid")
      const finishedFile = path.join(directory, ".task-finished")
      const marker = `DESKTOP_TASKS_${Date.now()}`
      await compose(input,
        (harness === "Claude"
          ? 'Use TaskCreate and TaskUpdate with returned task IDs to create exactly three tasks: "Inspect source" completed, "Verify behavior" in_progress, "Report result" pending. '
          : 'Use update_plan with exactly three tasks: "Inspect source" completed, "Verify behavior" in_progress, "Report result" pending. ') +
        `Then run this shell command and wait for it: echo $$ > '${pidFile}'; while [ ! -f '${releaseFile}' ]; do sleep 0.1; done; echo finished > '${finishedFile}'. ` +
        `The test runner creates the release file; do not create it yourself. When the shell finishes, mark all tasks completed using ${harness === "Claude" ? "TaskUpdate with the original IDs" : "update_plan"} and reply exactly ${marker}.`,
      )
      const creation = packaged.page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/session",
      )
      await expect(packaged.page.locator('[data-action="prompt-submit"]:visible').last()).toHaveAccessibleName("Send")
      await packaged.page.locator('[data-action="prompt-submit"]:visible').last().click()
      const created = await creation
      expect(created.ok()).toBe(true)
      const session = await created.json() as { id: string }
      expect(session.id).toBeTruthy()
      await expect.poll(() => fs.readFile(pidFile, "utf8").catch((error) => {
        if (error.code === "ENOENT") return ""
        throw error
      }), { timeout: 90_000 }).toMatch(/^\d+\s*$/)
      const pid = Number((await fs.readFile(pidFile, "utf8")).trim())
      const activeTasks = [
        { content: "Inspect source", status: "completed" },
        { content: "Verify behavior", status: "in_progress" },
        { content: "Report result", status: "pending" },
      ]
      const readTasks = async () => {
        const response = await fetch(`${serverBase}/session/${session.id}/todo?directory=${encodeURIComponent(directory)}`)
        expect(response.ok).toBe(true)
        return (await response.json() as Array<{ content: string; status: string }>).map(({ content, status }) => ({ content, status }))
      }
      expect(await readTasks()).toEqual(activeTasks)
      process.kill(pid, 0)
      await expect(fs.stat(finishedFile)).rejects.toMatchObject({ code: "ENOENT" })
      const appProcess = packaged.app.process()
      await packaged.close()
      await expect.poll(() => appProcess.exitCode !== null || appProcess.signalCode !== null).toBe(true)
      process.kill(pid, 0)
      packaged = await launch()
      expect(new URL(await expectServerReachable(packaged, 45_000)).origin).toBe(serverBase)
      const dock = packaged.page.locator('[data-component="session-todo-dock"]')
      await expect(dock).toContainText("Verify behavior")
      await expect(dock.locator('[data-in-progress]')).toHaveCount(1)
      expect(await readTasks()).toEqual(activeTasks)
      process.kill(pid, 0)
      await expect(fs.stat(finishedFile)).rejects.toMatchObject({ code: "ENOENT" })
      await packaged.page.screenshot({ path: test.info().outputPath("tasks-after-desktop-restart.png") })
      await fs.writeFile(releaseFile, "release")
      await expect(packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').filter({ hasText: marker })).toBeVisible({ timeout: 90_000 })
      expect((await fs.readFile(finishedFile, "utf8")).trim()).toBe("finished")
      expect(await readTasks()).toEqual(activeTasks.map((task) => ({ ...task, status: "completed" })))
      await expect(dock).toHaveCount(0)
      await packaged.page.reload()
      await expect(packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').filter({ hasText: marker })).toBeVisible()
      await expect(dock).toHaveCount(0)
      return
    }

    const marker = "WINDOWS_CODEX_APP_OK"
    await compose(input, `Reply with exactly this token and nothing else: ${marker}`)
    const submit = packaged.page.locator('[data-action="prompt-submit"]:visible').last()
    await expect(submit).toBeEnabled({ timeout: 10_000 })
    const createResponse = packaged.page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "POST" && url.pathname === "/session"
    })
    await submit.click()
    const created = await createResponse
    if (!created.ok()) {
      throw new Error(
        `real ${harness} session creation failed (${created.status()}): ${await created.text()}. ` +
          `App log tail: ${packaged.appLog.join("").split("\n").slice(-30).join("\n")}`,
      )
    }
    await expect(
      packaged.page.locator('[data-slot="session-turn-assistant-content"]:visible').filter({ hasText: marker }),
      `the real ${harness} session did not render its authenticated response`,
    ).toBeVisible({ timeout: 180_000 })
  } finally {
    if (packaged && !packaged.page.isClosed()) {
      await packaged.page.screenshot({ path: test.info().outputPath("desktop-session-final.png") })
    }
    await fs.writeFile(releaseFile, "release")
    await cleanupDocumentSession?.()
    await packaged?.close()
    await shutdownPackagedTestDaemon(profile)
    await fs.rm(profile, { recursive: true, force: true })
    await fs.rm(directory, { recursive: true, force: true })
    if (permissionOutputDir) await fs.rm(permissionOutputDir, { recursive: true, force: true })
  }
})
}
}
