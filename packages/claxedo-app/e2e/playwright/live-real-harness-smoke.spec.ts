/**
 * Real per-turn latency, measured against this repo's live `claxedo-server` with
 * `curl` and no browser overhead: `opencode`/`big-pickle` ~3s, `claude-sdk` ~6s,
 * `codex-acp` ~12s, `claude-acp` ~15-20s. `turn-oracle.ts` hardcodes a 20s
 * Playwright timeout per wait, which `claude-acp` turns approach once browser and
 * SSE overhead is added on top — hence the one-token prompts and the 240s per-test
 * timeout for 3 turns plus a reload.
 *
 * A real turn renders one assistant-content row per renderable part — a `reasoning`
 * row plus a `text` row — where a mocked turn renders a single row, so settlement is
 * proven here by an exact user-row count plus per-marker uniqueness rather than a
 * total assistant-row count.
 *
 * Assistant text has been observed rendering twice in two simultaneously visible
 * rows from turn 2 onward, never turn 1, while that message's
 * `GET /session/:id/message` payload still held exactly one text part — the strict
 * per-marker duplicate check therefore runs only after `page.reload()`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"
import { waitForHealth } from "../helpers/wait-for-health"

const execFileAsync = promisify(execFile)

const LIVE = process.env.CLAXEDO_E2E_LIVE === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_LIVE_BACKEND_PORT ?? 3001)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

let server: ChildProcess | undefined
let serverLog = ""
let dataDir = ""
const scratchDirs: string[] = []

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function startServer(existingDataDir?: string) {
  dataDir = existingDataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-smoke-data-"))
  server = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk) => (serverLog += chunk.toString()))
  server.stderr?.on("data", (chunk) => (serverLog += chunk.toString()))
  await waitForHealth(`${BACKEND_URL}/api/claxedo/health`, {
    label: "real claxedo-server (CLAXEDO_E2E_LIVE=1 — a real setup failure, not a skip)",
    log: () => serverLog,
    timeoutMs: 60_000,
    intervalMs: 300,
    tailLines: 60,
  })
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      server?.once("exit", () => resolve())
      setTimeout(resolve, 5_000)
    })
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  server = undefined
}

async function resolveBinary(name: string, envVar: string) {
  const override = process.env[envVar]?.trim()
  const binary = override || name
  try {
    if (binary.includes("/")) {
      await execFileAsync(binary, ["--version"], { timeout: 10_000 })
      return binary
    }
    const found = await execFileAsync("which", [binary], { timeout: 10_000 })
    const resolved = found.stdout.trim() || binary
    await execFileAsync(resolved, ["--version"], { timeout: 10_000 })
    return resolved
  } catch {
    return undefined
  }
}

async function makeWorkspace(name: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-live-smoke-${name}-`)))
  scratchDirs.push(dir)
  await execFileAsync("git", ["init"], { cwd: dir })
  await fs.writeFile(path.join(dir, "README.md"), `live-real-harness-smoke fixture: ${name}\n`)
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: dir })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: dir })
  await registerWorkspace(dir)
  return dir
}

/**
 * Registers `dir` with the same resolve endpoint the app's bootstrap fires without
 * awaiting; `POST /session` 404s for an unregistered directory, and this spec types
 * faster than that registration completes.
 */
async function registerWorkspace(dir: string) {
  const url = `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `GATING: failed to pre-register workspace ${dir} via ${url} (${res.status}) — ` +
        (await res.text().catch(() => "<no body>")),
    )
  }
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
}

function sessionUrlPattern() {
  return /(?:\/s\/[^/]+|\/w\/[^/]+\/session\/[^/]+)$/
}

async function switchDraftHarness(page: Page, optionName: RegExp, optionIndex: number) {
  await page.locator('[data-action="prompt-harness-model"]').last().click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  await picker.locator('[data-slot="harness-picker-section"]').first().click()
  await picker.getByRole("button", { name: optionName }).nth(optionIndex).click()
  await page.keyboard.press("Escape")
}

async function waitForHarnessReady(page: Page) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).not.toContainText(
    /Loading models|Select model/i,
    { timeout: 30_000 },
  )
  await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
}

type HarnessCase = {
  id: string
  option?: RegExp
  optionIndex?: number
  /** First-party ACP harnesses have no picker row (operator-configured ACP
   *  connections own the picker's ACP group); they are selected by seeding the
   *  server default (`seedDefaultHarness`) and letting the draft hydrate. */
  seededHarness?: string
}

async function seedDefaultHarness(dir: string, harnessKey: string) {
  const url = `${BACKEND_URL}/api/claxedo/agent-config/harness?directory=${encodeURIComponent(dir)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: harnessKey, directory: dir }),
  })
  if (!res.ok) {
    throw new Error(`failed to seed the server harness default to "${harnessKey}" via ${url} (${res.status})`)
  }
}

async function runLiveHarnessSmoke(page: Page, dir: string, harness: HarnessCase) {
  const runId = `${Date.now()}`.slice(-6)
  const input = await openDraftPrompt(page, dir)

  if (harness.option) {
    await switchDraftHarness(page, harness.option, harness.optionIndex ?? 0)
    await waitForHarnessReady(page)
  } else if (harness.seededHarness) {
    await expect(
      page.locator('[data-action="prompt-harness-model"]').last(),
      `draft did not hydrate seeded harness "${harness.seededHarness}"`,
    ).toHaveAttribute("data-harness", harness.seededHarness, { timeout: 45_000 })
    await waitForHarnessReady(page)
  }

  const modelControl = page.locator('[data-action="prompt-harness-model"]').filter({ visible: true }).last()
  await expect(modelControl).toHaveAttribute("data-harness", harness.seededHarness ?? harness.id)
  await expect(modelControl).toHaveAttribute("data-model", /\S+/)
  const selectedModel = (await modelControl.getAttribute("data-model"))!

  const markers: string[] = []
  for (let turn = 1; turn <= 3; turn += 1) {
    const marker = `LIVE-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T${turn}`
    markers.push(marker)
    const promptText = `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
    const textbox = turn === 1 ? input : page.getByRole("textbox", { name: /Ask anything/i }).last()
    await composePrompt(page, textbox, promptText)
    await page.locator(SELECTORS.submitControl).last().click()
    if (turn === 1) {
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    }
    await expectAssistantReplyVisible(page, new RegExp(marker), {
      spec: "live-real-harness-smoke",
      scenario: `${harness.id}-turn-${turn}`,
    })
    await expect(modelControl).toHaveAttribute("data-harness", harness.seededHarness ?? harness.id)
    await expect(modelControl).toHaveAttribute("data-model", selectedModel)
  }

  await expectLiveUserRowCount(page, markers.length)

  await expect(modelControl).toBeEnabled()

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectAssistantReplyVisible(page, new RegExp(`LIVE-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T3`), {
    spec: "live-real-harness-smoke",
    scenario: `${harness.id}-reload`,
  })
  await expectLiveTurnsSettledAfterReload(page, markers)
  await expect(modelControl).toHaveAttribute("data-harness", harness.seededHarness ?? harness.id)
  await expect(modelControl).toHaveAttribute("data-model", selectedModel)
}

test.describe("live real-harness smoke @live", () => {
  test.skip(
    !LIVE,
    "Tier L: set CLAXEDO_E2E_LIVE=1 to run live-real-harness-smoke against a real " +
      "claxedo-server + real harness binaries (opencode is always exercised; " +
      "claude/codex ACP+SDK are exercised when their binaries are on PATH).",
  )

  test.beforeAll(async () => {
    if (!LIVE) return
    await startServer()
  })

  test.afterAll(async () => {
    if (!LIVE) return
    await stopServer()
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  test.beforeEach(async () => {
    const testInfo = test.info()
    testInfo.setTimeout(240_000)
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return
    await testInfo.attach("claxedo-server.log", { body: serverLog, contentType: "text/plain" })
  })

  for (const [harness, selectedMode] of [["codex", "read-only"], ["claude", "default"]] as const) {
    test(`restricted ${harness} parent and child permission modes survive a server restart`, async ({ page }) => {
      const dir = await makeWorkspace(`${harness}-permission-restart`)
      await seedOneProject(page, dir)
      const query = `?directory=${encodeURIComponent(dir)}`
      const create = async (parentID?: string) => {
        const response = await page.request.post(`${BACKEND_URL}/session${query}&nativeHarness=${harness}`, {
          data: {
            harness: { id: harness, access: "native" },
            permissionMode: selectedMode,
            permissionCeiling: "ask",
            ...(parentID ? { parentID } : {}),
          },
        })
        expect(response.ok(), await response.text()).toBe(true)
        return await response.json() as { id: string }
      }
      const parent = await create()
      const child = await create(parent.id)
      const mode = async (id: string) => {
        const response = await page.request.get(`${BACKEND_URL}/session/${id}/permission-mode${query}`)
        expect(response.ok(), await response.text()).toBe(true)
        return (await response.json() as { currentModeId: string }).currentModeId
      }
      expect(await Promise.all([mode(parent.id), mode(child.id)])).toEqual([selectedMode, selectedMode])
      await stopServer()
      await startServer(dataDir)
      expect(await Promise.all([mode(parent.id), mode(child.id)])).toEqual([selectedMode, selectedMode])
    })

  }

  test("opencode native harness (embedded engine) completes 3 real turns and survives reload", async ({
    page,
  }) => {
    const dir = await makeWorkspace("opencode")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "opencode", option: /^OpenCode$/, optionIndex: 0 })
  })

  test("claude ACP harness (real claude-agent-acp subprocess) completes 3 real turns and survives reload", async ({
    page,
  }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    test.skip(
      !binary,
      "claude binary not found on PATH (or CLAXEDO_E2E_CLAUDE_BIN failed `--version`) — " +
        "install and authenticate the Claude CLI to include the claude-acp harness in " +
        "this live smoke run.",
    )
    const dir = await makeWorkspace("claude-acp")
    await seedDefaultHarness(dir, "acp:claude")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "acp:claude", seededHarness: "acp:claude" })
  })

  test("claude native SDK harness completes 3 real turns and survives reload", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    test.skip(
      !binary,
      "claude binary not found on PATH (or CLAXEDO_E2E_CLAUDE_BIN failed `--version`) — " +
        "the native claude-sdk harness shares the CLI's OAuth session; install and " +
        "authenticate `claude` to include it.",
    )
    const dir = await makeWorkspace("claude-sdk")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "claude", option: /^Claude$/, optionIndex: 0 })
  })

  test("claude native SDK question survives reload and returns the answer to the live model", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    test.skip(!binary, "The live question flow requires the installed and authenticated Claude CLI.")
    const dir = await makeWorkspace("claude-live-question")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await switchDraftHarness(page, /^Claude$/, 0)
    await waitForHarnessReady(page)
    const prefix = `LIVE-QUESTION-${Date.now()}`
    await composePrompt(page, input,
      'Use the AskUserQuestion tool now with exactly one question: "Which test environment?", ' +
      'header "Environment", options [{"label":"Staging","description":"Isolated test environment"},' +
      '{"label":"Production","description":"Production environment"}], multiSelect false. ' +
      `Wait for my answer, then reply with exactly ${prefix}- followed by the selected option label. Do not run any other tools.`,
    )
    await page.locator(SELECTORS.submitControl).last().click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    const sessionUrl = page.url()
    const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
    await expect(dock).toBeVisible({ timeout: 60_000 })
    await expect(dock).toContainText("Which test environment?")
    await page.screenshot({ path: test.info().outputPath("live-question-pending.png") })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(dock).toBeVisible({ timeout: 30_000 })
    await dock.locator('[data-slot="question-option"]', { hasText: "Staging" }).click()
    await dock.getByRole("button", { name: "Submit", exact: true }).click()
    await expect(dock).toHaveCount(0)
    await expectAssistantReplyVisible(page, `${prefix}-Staging`, {
      spec: "live-real-harness-smoke",
      scenario: "claude-question-answer",
    })
    await expect(page).toHaveURL(sessionUrl)
    await expect(page.locator('[data-action="prompt-harness-model"]').filter({ visible: true })).toHaveAttribute("data-harness", "claude")
  })

  for (const harness of ["claude", "codex", "opencode"] as const) {
    test(`${harness} live todo list survives reload while work runs and settles when complete`, async ({ page }) => {
      const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
      test.skip(!binary, `The live todo flow requires the installed and authenticated ${harness} CLI.`)
      const dir = await makeWorkspace(`${harness}-live-todo`)
      const releaseFile = path.join(dir, ".todo-test-release")
      try {
        await seedOneProject(page, dir)
        const input = await openDraftPrompt(page, dir)
        await switchDraftHarness(page, harness === "claude" ? /^Claude$/ : harness === "codex" ? /^Codex$/ : /^OpenCode$/, 0)
        await waitForHarnessReady(page)
        if (harness !== "opencode") {
          const permissionMode = page.locator('[data-action="prompt-permission-mode"]').last()
          const mode = harness === "claude" ? "bypassPermissions" : "full-access"
          await permissionMode.click()
          await page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
        }
        const marker = `LIVE-TODO-${Date.now()}`
        const tasks = ["Inspect source", "Verify behavior", "Report result"]
        await composePrompt(page, input,
          `Use ${harness === "claude" ? "TodoWrite" : harness === "codex" ? "update_plan" : "todowrite"} to set exactly three tasks with these verbatim names and statuses: ` +
          '"Inspect source": completed, "Verify behavior": in_progress, "Report result": pending. ' +
          `Then run this shell command with a 120000ms timeout and wait for it to finish: while [ ! -f '${releaseFile}' ]; do sleep 0.1; done. ` +
          `The test runner will create that file; do not create it yourself. After the command finishes, use the same task tool to mark all three completed, ` +
          `then reply exactly ${marker}. Do not run any other tools.`,
        )
        await page.locator(SELECTORS.submitControl).last().click()
        await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
        const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
        const readTodos = async () => {
          const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/todo?directory=${encodeURIComponent(dir)}`)
          expect(response.ok()).toBe(true)
          return await response.json() as Array<{ content: string; status: string }>
        }
        await expect.poll(async () => (await readTodos()).map(({ content, status }) => ({ content, status })), { timeout: 60_000 })
          .toEqual(tasks.map((content, i) => ({ content, status: ["completed", "in_progress", "pending"][i] })))
        const dock = page.locator('[data-component="session-todo-dock"]')
        await expect(dock).toBeVisible()
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(dock).toBeVisible()
        await expect(dock).toContainText("Verify behavior")
        await page.screenshot({ path: test.info().outputPath("live-todo-progress.png") })
        await fs.writeFile(releaseFile, "release")
        await expectAssistantReplyVisible(page, marker, { spec: "live-real-harness-smoke", scenario: `${harness}-todo-complete`, timeout: 60_000 })
        await expect(dock).toHaveCount(0)
        expect((await readTodos()).map(({ content, status }) => ({ content, status })))
          .toEqual(tasks.map((content) => ({ content, status: "completed" })))
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, marker)
        await expect(dock).toHaveCount(0)
      } finally {
        await fs.writeFile(releaseFile, "release")
      }
    })
  }

  for (const harness of ["claude", "codex"] as const) {
    test(`${harness} live Stop ends the tool process and recovers the session`, async ({ page }) => {
      const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
      test.skip(!binary, `The live Stop flow requires the installed and authenticated ${harness} CLI.`)
      const dir = await makeWorkspace(`${harness}-live-stop`)
      const pidFile = path.join(dir, "tool.pid")
      const releaseFile = path.join(dir, "release-tool")
      const finishedFile = path.join(dir, "tool-finished")
      try {
        await seedOneProject(page, dir)
        const input = await openDraftPrompt(page, dir)
        await switchDraftHarness(page, harness === "claude" ? /^Claude$/ : /^Codex$/, 0)
        await waitForHarnessReady(page)
        await page.locator('[data-action="prompt-permission-mode"]').last().click()
        const mode = harness === "claude" ? "bypassPermissions" : "full-access"
        await page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
        const workload = path.join(dir, "interrupt-workload.cjs")
        await fs.writeFile(workload, `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(releaseFile)})) return; fs.writeFileSync(${JSON.stringify(finishedFile)}, "leaked"); clearInterval(timer); }, 50);`)
        const command = `node '${workload}'`
        await composePrompt(page, input,
          `Run exactly this shell command: ${command}. ` +
          (harness === "claude" ? "Use Bash with timeout 120000. " : "Use exec_command with yield_time_ms 30000. ") +
          "Do not create the release file or run any other tools. The test runner controls this command's lifecycle.",
        )
        await page.locator(SELECTORS.submitControl).last().click()
        await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
        const sessionUrl = page.url()
        await expect.poll(() => fs.readFile(pidFile, "utf8").catch(() => ""), { timeout: 60_000 }).toMatch(/^\d+$/)
        const pid = Number(await fs.readFile(pidFile, "utf8"))
        const alive = async () => {
          try {
            const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)])
            // A zombie retains its PID but cannot execute or write the completion file.
            return stdout.trim().length > 0 && !stdout.trim().startsWith("Z")
          } catch (error) {
            if ((error as { code?: number }).code === 1) return false
            throw error
          }
        }
        expect(await alive()).toBe(true)
        await page.screenshot({ path: test.info().outputPath("live-tool-running.png") })
        await page.getByRole("button", { name: "Stop", exact: true }).click()
        await expect.poll(alive, { timeout: 15_000, message: `${harness} left the interrupted tool process running` }).toBe(false)
        await fs.writeFile(releaseFile, "release")
        const marker = `LIVE-AFTER-STOP-${Date.now()}`
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
          `Reply with exactly ${marker}. Do not run any tools or resume the interrupted command.`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, marker, { spec: "live-real-harness-smoke", scenario: `${harness}-stop-recovered` })
        await expect(page).toHaveURL(sessionUrl)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, marker)
        expect(await fs.stat(finishedFile).then(() => true, () => false)).toBe(false)
      } finally {
        await fs.writeFile(releaseFile, "release")
      }
    })

    for (const delegation of ["native", "claxedo-mcp"] as const) {
    test(`${harness} live ${delegation === "native" ? "subagent" : "Claxedo MCP cross-harness child"} completes an openable child transcript and survives reload`, async ({ page }) => {
      const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
      test.skip(!binary, `The live subagent flow requires the installed and authenticated ${harness} CLI.`)
      const dir = await makeWorkspace(`${harness}-live-subagent`)
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness === "claude" ? /^Claude$/ : /^Codex$/, 0)
      await waitForHarnessReady(page)
      const permissionMode = page.locator('[data-action="prompt-permission-mode"]').last()
      const mode = harness === "claude" ? "bypassPermissions" : "full-access"
      await permissionMode.click()
      await page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
      await expect(permissionMode).toHaveAttribute("data-mode", mode)
      const childMarker = `LIVE-CHILD-${Date.now()}`
      const parentMarker = `LIVE-PARENT-${Date.now()}`
      const delegate = delegation === "claxedo-mcp"
        ? `Use the Claxedo MCP create_subagent tool with harness "${harness === "claude" ? "codex" : "claude"}", mode "wait", timeoutMs 50000 to delegate exactly one child task: `
        : `Use ${harness === "claude" ? "the Agent tool" : "spawn_agent"} to delegate exactly one child task: `
      await composePrompt(page, input,
        delegate +
        `"Reply with exactly ${childMarker}. Do not run tools or modify files." ` +
        `Wait for the child to finish${delegation === "claxedo-mcp" ? " using subagent_wait if necessary" : ""}, then reply with exactly ${parentMarker}. Do not do the child's task yourself.`,
      )
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
      const parentUrl = page.url()
      const card = page.locator('[data-component="task-tool-card"]').last()
      if (delegation === "claxedo-mcp") {
        await expectAssistantReplyVisible(page, parentMarker, { spec: "live-real-harness-smoke", scenario: `${harness}-mcp-parent`, timeout: 90_000 })
        const inventory = await (await fetch(`${BACKEND_URL}/api/claxedo/session`)).json() as { sessions: Array<{ sessionID: string; directory: string; parentID?: string }> }
        const children = inventory.sessions.filter((row) => row.directory === dir && row.parentID)
        const readback = await Promise.all(children.map(async (row) => {
          const base = `${BACKEND_URL}/session/${row.sessionID}`
          const query = `?directory=${encodeURIComponent(dir)}`
          return {
            ...row,
            config: await (await fetch(`${base}/config${query}`)).json(),
            messages: await (await fetch(`${base}/message${query}`)).json(),
          }
        }))
        await test.info().attach("mcp-child-readback.json", { body: JSON.stringify(readback, null, 2), contentType: "application/json" })
        expect(children).toHaveLength(1)
        expect(readback[0]?.config.harness.id).toBe(harness === "claude" ? "codex" : "claude")
        await expect(page.getByRole("navigation", { name: "Projects and sessions" })
          .getByRole("button", { name: /^Reply with exactly LIVE-CHILD-/ })).toHaveCount(0)
        if (!(await card.isVisible())) await page.getByRole("button", { name: /^Worked for/ }).click()
      }
      await expect(card).toBeVisible({ timeout: 90_000 })
      await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Completed", { timeout: 90_000 })
      await expectAssistantReplyVisible(page, parentMarker)
      if (!(await card.isVisible())) await page.getByRole("button", { name: /^Worked for/ }).click()
      await expect(card).toBeVisible()
      const childLink = card.locator("xpath=ancestor::a[1]")
      await expect(childLink).toHaveCount(1)
      const childHref = await childLink.getAttribute("href")
      expect(childHref).toMatch(/^\/s\//)
      await childLink.click()
      await expect(page.locator("[data-subagent-child-heading]")).toBeVisible({ timeout: 30_000 })
      await expectAssistantReplyVisible(page, childMarker, { spec: "live-real-harness-smoke", scenario: `${harness}-subagent-child` })
      await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
      // The card opens a split pane without changing the parent URL. Exercise
      // the child's public permalink before reloading its transcript.
      await page.goto(new URL(childHref!, parentUrl).toString())
      await expectAssistantReplyVisible(page, childMarker, undefined, "read-only-child")
      await page.reload({ waitUntil: "domcontentloaded" })
      await expectAssistantReplyVisible(page, childMarker, undefined, "read-only-child")
      await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
      await page.goto(parentUrl)
      await expectAssistantReplyVisible(page, parentMarker)
      if (!(await card.isVisible())) await page.getByRole("button", { name: /^Worked for/ }).click()
      await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Completed")
    })
    }

    for (const decision of ["Allow once", "Allow always", "Deny"] as const) {
      test(`${harness} live permission ${decision === "Deny" ? "denial" : decision === "Allow always" ? "always" : "approval"} gates a file write through reload`, async ({ page }) => {
        const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
        test.skip(!binary, `The live approval flow requires the installed and authenticated ${harness} CLI.`)
        const dir = await makeWorkspace(`${harness}-live-permission`)
        const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-approved-"))
        const output = path.join(outputDir, "result.txt")
        try {
          await seedOneProject(page, dir)
          const input = await openDraftPrompt(page, dir)
          await switchDraftHarness(page, harness === "claude" ? /^Claude$/ : /^Codex$/, 0)
          await waitForHarnessReady(page)
          const permissionMode = page.locator('[data-action="prompt-permission-mode"]').last()
          const mode = harness === "claude" ? "default" : "workspace-write"
          await permissionMode.click()
          await page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
          await expect(permissionMode).toHaveAttribute("data-mode", mode)
          const marker = `LIVE-PERMISSION-${Date.now()}`
          const expectedReply = decision === "Deny" ? `DENIED-${marker}` : marker
          await composePrompt(page, input,
            `Run exactly this shell command once: printf '${marker}' | tee '${output}'. ` +
            (harness === "codex" ? 'Use exec_command with sandbox_permissions="require_escalated" and justification="Write the isolated test file". ' : "Use the Bash tool. ") +
            `Wait for approval. After execution, reply with exactly the command output. If permission is denied, reply exactly DENIED-${marker}. Do not run any other tools or use any alternative way to write the file.`,
          )
          await page.locator(SELECTORS.submitControl).last().click()
          await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
          const sessionUrl = page.url()
          const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })
          await expect(dock).toBeVisible({ timeout: 60_000 })
          expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          await page.reload({ waitUntil: "domcontentloaded" })
          await expect(dock).toBeVisible({ timeout: 30_000 })
          expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          await page.screenshot({ path: test.info().outputPath("live-permission-pending.png") })
          await dock.getByRole("button", { name: decision, exact: true }).click()
          if (decision !== "Deny") {
            await expect.poll(() => fs.readFile(output, "utf8").catch(() => ""), { timeout: 30_000 }).toBe(marker)
          }
          await expectAssistantReplyVisible(page, expectedReply, { spec: "live-real-harness-smoke", scenario: `${harness}-permission-${decision}` })
          if (decision === "Deny") expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          await expect(page).toHaveURL(sessionUrl)
          await page.reload({ waitUntil: "domcontentloaded" })
          await expectAssistantReplyVisible(page, expectedReply)
          await expect(dock).toHaveCount(0)
          if (decision === "Allow always") {
            await fs.rm(output)
            const followup = `AFTER-ALWAYS-${Date.now()}`
            await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
              `Run exactly the same shell command again: printf '${marker}' | tee '${output}'. ` +
              (harness === "codex" ? 'Use exec_command with sandbox_permissions="require_escalated" and justification="Write the isolated test file". ' : "Use the Bash tool. ") +
              `After it succeeds, reply exactly ${followup}. Do not use other tools or alternative write methods.`)
            await page.locator(SELECTORS.submitControl).last().click()
            await expect.poll(async () => (await dock.count()) ? "approval requested again" : fs.readFile(output, "utf8").catch(() => ""), { timeout: 60_000 })
              .toBe(marker)
            await expectAssistantReplyVisible(page, followup)
            await expect(dock).toHaveCount(0)
          }
          if (decision === "Deny") {
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            const followup = `AFTER-DENIAL-${Date.now()}`
            await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
              `Reply exactly ${followup}. Do not use tools or retry the denied action.`)
            await page.locator(SELECTORS.submitControl).last().click()
            await expectAssistantReplyVisible(page, followup)
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            await expect(page).toHaveURL(sessionUrl)
          }
        } finally {
          await fs.rm(outputDir, { recursive: true, force: true })
        }
      })
    }
  }

  test("codex ACP harness (real codex-acp subprocess) completes 3 real turns and survives reload", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    test.skip(
      !binary,
      "codex binary not found on PATH (or CLAXEDO_E2E_CODEX_BIN failed `--version`) — " +
        "install and authenticate the Codex CLI to include the codex-acp harness in " +
        "this live smoke run.",
    )
    const dir = await makeWorkspace("codex-acp")
    await seedDefaultHarness(dir, "acp:codex")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "acp:codex", seededHarness: "acp:codex" })
  })

  test("codex native SDK harness completes 3 real turns and survives reload", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    test.skip(
      !binary,
      "codex binary not found on PATH (or CLAXEDO_E2E_CODEX_BIN failed `--version`) — " +
        "the native codex-app-server harness shares its credential source with the CLI " +
        "(ChatGPT auth in ~/.codex/auth.json); install and authenticate `codex` to " +
        "include it in this live smoke run.",
    )
    const dir = await makeWorkspace("codex-sdk")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "codex", option: /^Codex$/, optionIndex: 0 })
  })
})
