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

async function startServer() {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-live-smoke-data-"))
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
 * Registers `dir` as a real local workspace via the same `GET /api/workspace/resolve
 * ?directory=...&create=true` call the app's own bootstrap flow fires on first
 * navigation to a directory (`src/shell/data/bootstrap.ts`'s fire-and-forget
 * `resolveWorkspace()` inside `postPaint` -> `src/shared/data/http-backend.ts`'s
 * `resolveWorkspace`/`workspaceResolveUrl` -> `packages/claxedo-server/src/routes/
 * workspace.ts:142` (`GET /resolve`) -> `resolveWorkspace({..., create: true})` ->
 * `ensureWorkspace()` in `packages/claxedo-server-core/src/workspace/store/index.ts:287`). This
 * closes a REAL race this spec found empirically against the live server: until that
 * registration completes, `POST /session` 404s (`workspaceRuntimeProxy`'s `resolveWorkspace`
 * lookup finds nothing and falls through to `next()` with no other root `/session`
 * handler registered — `packages/claxedo-local-server/src/workspace/runtime-dispatch/internals.ts:325-350`), confirmed by
 * direct `curl` reproduction: `POST /session` 404s deterministically for a brand-new,
 * never-registered directory and 201s immediately after this exact `GET .../resolve
 * ...&create=true` call. The app's own bootstrap call is fire-and-forget and not
 * awaited before the composer becomes interactive, so under normal human typing
 * latency the client's own retry loop always wins the race; this spec types and
 * submits fast enough (and this host can be under heavy concurrent CPU load) that it
 * does not always win it. Pre-registering here is a real test-setup precondition
 * (same category as the `git init` above), not a mock — it calls the exact real
 * endpoint a slower human user's browser would already have called by the time they
 * finished typing.
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
  /** First-party ACP harnesses have no picker row any more (operator-configured
   *  ACP connections own the picker's ACP group) — they are selected by seeding
   *  the server default (`seedDefaultHarness`) and letting the draft hydrate. */
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
  }

  await expectLiveUserRowCount(page, markers.length)

  if (harness.option) {
    await expect(page.getByRole("button", { name: harness.option }).last()).toBeEnabled()
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectAssistantReplyVisible(page, new RegExp(`LIVE-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T3`), {
    spec: "live-real-harness-smoke",
    scenario: `${harness.id}-reload`,
  })
  await expectLiveTurnsSettledAfterReload(page, markers)
}

test.describe("live real-harness smoke @live", () => {
  test.skip(
    !LIVE,
    "Tier L: set CLAXEDO_E2E_LIVE=1 to run live-real-harness-smoke against a real " +
      "claxedo-server + real harness binaries (opencode is always exercised; " +
      "claude/codex ACP+SDK are exercised when their binaries are on PATH). Unset " +
      "-> loud, visible skip per e2e/INVARIANTS.md's Tier L gating contract — never " +
      "a silent no-op.",
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

  test.beforeEach(async (_fixtures, testInfo) => {
    testInfo.setTimeout(240_000)
  })

  test("opencode native harness (embedded engine) completes 3 real turns and survives reload — behaviors 1,6,7", async ({
    page,
  }) => {
    const dir = await makeWorkspace("opencode")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "opencode" })
  })

  test("claude ACP harness (real claude-agent-acp subprocess) completes 3 real turns and survives reload — behaviors 2,6,7", async ({
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

  test("claude native SDK harness completes 3 real turns and survives reload — behaviors 3,6,7", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    test.skip(
      !binary,
      "claude binary not found on PATH (or CLAXEDO_E2E_CLAUDE_BIN failed `--version`) — " +
        "the native claude-sdk harness shares its credential source with the CLI " +
        "(see HARNESS NOTES); install and authenticate `claude` to include it.",
    )
    const dir = await makeWorkspace("claude-sdk")
    await seedOneProject(page, dir)
    await runLiveHarnessSmoke(page, dir, { id: "claude-sdk", option: /^Claude$/, optionIndex: 0 })
  })

  test("codex ACP harness (real codex-acp subprocess) completes 3 real turns and survives reload — behaviors 4,6,7", async ({
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

  test("codex native SDK harness completes 3 real turns and survives reload — behavior 5", async ({
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
    await runLiveHarnessSmoke(page, dir, { id: "codex-sdk", option: /^Codex$/, optionIndex: 0 })
  })
})
