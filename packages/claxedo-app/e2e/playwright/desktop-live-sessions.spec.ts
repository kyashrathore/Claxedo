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

const execFileAsync = promisify(execFile)

async function compose(input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
}

for (const harness of ["Codex", "Claude"] as const) {
for (const flow of ["reply", "tasks across full restart", "tool error recovery across full restart", "question answer across full restart", "question dismiss across full restart", "question stop across full restart"] as const) {
test(`packaged app completes a real ${harness}-authenticated session: ${flow} @live @surface-desktop`, async () => {
  test.setTimeout(240_000)
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-desktop-${harness.toLowerCase()}-`)))
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-live-${harness.toLowerCase()}-profile-`))
  const releaseFile = path.join(directory, ".task-release")
  const launch = () => launchPackagedApp({
    timeoutMs: 60_000,
    userDataDir: profile,
    preserveUserDataDir: true,
    env: harness === "Codex" ? { CODEX_HOME: path.join(os.homedir(), ".codex") } : {},
  })
  let packaged: PackagedApp | undefined
  try {
    await execFileAsync("git", ["init"], { cwd: directory })
    await fs.writeFile(path.join(directory, "README.md"), `Real ${harness} desktop proof.\n`)
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
    await packaged?.close()
    await shutdownPackagedTestDaemon(profile)
    await fs.rm(profile, { recursive: true, force: true })
    await fs.rm(directory, { recursive: true, force: true })
  }
})
}
}
