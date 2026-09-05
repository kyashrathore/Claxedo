/** Real native-harness browser journeys against an isolated self-host server and scripted model HTTP endpoints. */
import {
  CLAXEDO_ALLOW_SAFE_ID,
  CLAXEDO_ASK_ALWAYS_ID,
} from "../../src/features/session/permission/modes"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  type ScriptedDialect,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"
import { startRealLocalServer, type RealLocalServer } from "../helpers/real-local-server"
import { composeText as composePrompt, selectScriptedModel } from "../helpers/web-signed-relay-harness"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"
import { expectRailRowVisible, expectRailStatusAbsent, expectRailTitleSettled } from "../helpers/rail-oracle"

const execFileAsync = promisify(execFile)

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const BACKEND_PORT = Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const TURNS = 3
const TURN_PICKER_TURNS = 11

let scripted: ScriptedModelServer | undefined
let server: RealLocalServer | undefined

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function startServer() {
  server = await startRealLocalServer("harness-local", { port: BACKEND_PORT })
  scripted = server.scripted
}

async function stopServer() {
  await server?.close()
  server = undefined
  scripted = undefined
}

/** Harvested from live-real-harness-smoke.spec.ts's resolveBinary(). */
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

/**
 * Behavior 9's asymmetry in one place: absent binary is a contributor's local
 * reality (visible skip) but a broken CI job (loud GATING throw), because the
 * lane installs both CLIs itself. Neither path is ever silent.
 */
function requireBinary(binary: string | undefined, name: string, hint: string) {
  if (binary) return
  const reason =
    `${name} binary not found on PATH (or its override failed \`--version\`) — ${hint} ` +
    `No authentication is required for this tier: the scripted model server is the endpoint.`
  if (process.env.CI) throw new Error(`GATING: ${reason}`)
  test.skip(true, reason)
}

async function makeWorkspace(name: string, harnessKey = "pi") {
  const { directory } = await server!.makeWorkspace(name)
  const response = await fetch(
    `${BACKEND_URL}/api/claxedo/agent-config/harness?directory=${encodeURIComponent(directory)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: { kind: "native", harnessId: harnessKey } }),
    },
  )
  if (!response.ok) throw new Error(`Harness setup failed: ${response.status} ${await response.text()}`)
  return directory
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

function sessionUrlPattern() {
  return /(?:\/s\/[^/]+|\/w\/[^/]+\/session\/[^/]+)$/
}

/**
 * Selects a harness on a DRAFT composer, and proves the selection actually
 * landed before returning.
 *
 * The current composer has one combined picker, and every harness this lane
 * drives has a built-in row in it: the picker's ACP group is discovery-driven
 * over the operator's configured connections (agent-harness-selector's
 * BUILTIN_HARNESS_OPTIONS carries the native harnesses only), and this lane
 * configures none.
 *
 * The selected row itself is the setup oracle. A non-empty model label is not:
 * the previous Workspace Pi model can remain visible while the asynchronous switch
 * is still pending, which used to let this setup return on the wrong harness.
 */
function harnessPickerTarget(harnessKey: string) {
  if (harnessKey.startsWith("claude")) return { label: /^Claude$/, index: 0 }
  if (harnessKey.startsWith("codex")) return { label: /^Codex$/, index: 0 }
  if (harnessKey.startsWith("cursor")) return { label: /^Cursor$/, index: 0 }
  return { label: new RegExp(`^${harnessKey}$`, "i"), index: 0 }
}

async function switchDraftHarness(page: Page, harnessKey: string) {
  const trigger = page.locator('[data-action="prompt-harness-model"]').last()
  const target = harnessPickerTarget(harnessKey)
  await expect(trigger).toBeEnabled({ timeout: 30_000 })
  await trigger.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  const harnessSection = picker.locator('[data-slot="harness-picker-section"]').first()
  await expect(harnessSection).toBeVisible({ timeout: 30_000 })
  await harnessSection.click()
  const option = picker.getByRole("button", { name: target.label }).nth(target.index)
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await harnessSection.click()
  await expect(option, `draft did not adopt harness "${harnessKey}"`).toHaveAttribute("aria-current", "true", {
    timeout: 45_000,
  })
  await page.keyboard.press("Escape")
}

/**
 * 45s, not the 30s `live-real-harness-smoke` uses: `claude` resolves its
 * catalog through `ClaudeDriver.fetchModels`
 * (`packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:224`), a
 * short-lived probe query whose own `MODEL_LIST_TIMEOUT_MS` is exactly 30_000
 * (driver.ts:48) before it falls back to the static catalog. Waiting 30s for a
 * control whose worst case IS 30s makes the assertion a race against the
 * fallback rather than a check of it, which is how this first showed up as a
 * "Loading models" failure. The wait is still deterministic — it polls the
 * control's real text, never sleeps.
 */
async function waitForHarnessReady(page: Page) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).not.toContainText(
    /Loading models|Select model/i,
    { timeout: 45_000 },
  )
  await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
}

type GoalEntry = "slash" | "add-menu"

async function startGoalFromComposer(page: Page, input: Locator, entry: GoalEntry, objective: string) {
  if (entry === "slash") {
    await composePrompt(page, input, `/goal ${objective}`)
  } else {
    await page.locator('[data-action="prompt-add"]').last().click()
    const goal = page.locator('[data-action="prompt-goal"]')
    await expect(goal).toBeVisible({ timeout: 10_000 })
    await expect(goal).toBeEnabled()
    // The dropdown is already visibly open and enabled. Session inventory can
    // still shift its anchor while the real harness publishes terminal state,
    // so bypass Playwright's additional geometry-stability wait and dispatch
    // the same trusted click to the current menu item.
    await goal.click({ force: true })
    // Arming Goal mode intentionally changes the composer's accessible name,
    // so the draft locator returned by openDraftPrompt no longer matches.
    const goalInput = page.getByRole("textbox", { name: /Describe the outcome this Goal should reach/i }).last()
    await expect(goalInput).toBeVisible()
    await composePrompt(page, goalInput, objective)
  }

  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 45_000 })
  const dock = page.locator('[data-component="session-goal-dock"]')
  await expect(dock).toBeVisible({ timeout: 30_000 })
  await expect(dock).toContainText(objective)
  return dock
}

/**
 * The dock's status badge, not "the text `Paused` somewhere in the dock" — the
 * dock also renders the evaluator's `lastReason`, and a lifecycle transition
 * writes that reason as the status word ("Paused", "Resumed"), so a text match
 * across the whole dock is ambiguous by construction.
 */
function goalStatus(dock: Locator, status: string) {
  return dock.locator('[data-slot="session-goal-status"]').filter({ hasText: new RegExp(`^${status}$`) })
}

async function deleteGoalFromDock(page: Page, dock: Locator) {
  await dock.getByRole("button", { name: "Delete", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Delete Goal?" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(dock).toHaveCount(0, { timeout: 30_000 })
}

/**
 * Behavior 6. The load-bearing half is the LOWER bound: at least one scripted
 * call per turn on the scenario's own dialect. Zero there means the reply on
 * screen came from a provider this spec never pointed at — the exact
 * false-green the tier exists to catch, and one this suite actually hit (see
 * HARNESS NOTES' codex caveat: 3 correct markers, 0 scripted requests).
 *
 * The upper bound is deliberately loose, because "one HTTP call per turn" is
 * not a real contract. Measured directly against the scripted endpoint with the
 * real binaries: the engine adds one title call per session, and the claude CLI
 * issues TWO messages calls for a single one-token turn (the second carries a
 * `system-reminder` context block). Pinning a tight ceiling would assert the
 * harnesses' current internal chattiness, which is theirs to change — so the
 * ceiling only catches a runaway loop, and the cross-dialect check below is
 * what actually pins routing.
 */
const CALLS_PER_TURN_CEILING = 3

function expectScriptedTraffic(dialect: ScriptedDialect, turns: number) {
  const counts = scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 }
  const own = counts[dialect]
  expect(
    own,
    `expected the scripted ${dialect} endpoint to carry at least ${turns} call(s) — one per turn — but saw ${own}. ` +
      `Zero means the model traffic never reached the scripted server and the rendered reply came from a real ` +
      `provider. All counts: ${JSON.stringify(counts)}`,
  ).toBeGreaterThanOrEqual(turns)
  expect(
    own,
    `scripted ${dialect} calls (${own}) exceeded ${turns} turns x ${CALLS_PER_TURN_CEILING} — a runaway model loop`,
  ).toBeLessThanOrEqual(turns * CALLS_PER_TURN_CEILING + 1)
  for (const other of ["chat", "messages", "responses"] as const) {
    if (other === dialect) continue
    const ceiling = 0
    expect(
      counts[other],
      `expected at most ${ceiling} scripted ${other} call(s) during a ${dialect} scenario, saw ${counts[other]} — ` +
        `a harness routed through a provider it does not own. All counts: ${JSON.stringify(counts)}`,
    ).toBeLessThanOrEqual(ceiling)
  }
}

type HarnessCase = {
  id: string
  dialect: ScriptedDialect
} & (
  | {
      /** Both absent means "stay on the default" — no harness switch is driven. */
      option?: undefined
      harnessKey?: undefined
    }
  | {
      option: RegExp
      /** The option's `data-key` — the harness id. Paired with `option`: switching
       * needs both the label to assert against and the key to click. */
      harnessKey: string
    }
)

/**
 * The rail oracle: a session the user just started must be FINDABLE and
 * LEGIBLE in the sidebar while it runs, without a reload.
 *
 * All three assertions were reproduced by hand against a real server on
 * 2026-08-06 before being written down here:
 *   - row present: the `session.lifecycle` "created" frame does reach the
 *     client and inserts the row (this one passes today).
 *   - working dot: for the native-SDK harness the server publishes
 *     `agent.lifecycle` Busy with `tabId` = the SESSION id and NO `terminalId`.
 *     `agent-status-listener.ts:164` computes `terminalId || tabId` and writes
 *     it into the TERMINAL status map, which no chat row reads; meanwhile the
 *     chat row's own source, `GET /session/status`, never lists a native-SDK
 *     session at all (measured absent across a 30s poll during a live turn).
 *     So the dot never lights.
 *   - real title: the server replaces the "New Session" placeholder at the
 *     moment the turn completes (measured: title and `lastTurn.status
 *     ="completed"` both appear at +6.6s) with one derived from the first
 *     prompt (`fallbackSessionTitle`, session-title.ts:12) and publishes
 *     `session.updated` for it. That frame used to be dropped by
 *     `bridgeLifecycleEvent` (workspace-runtime `routes/session.ts`) — 0 such
 *     frames on the wire across a full cycle — so the rail kept the
 *     placeholder, in the wrong sort position, until an unrelated refetch
 *     happened to land. Now bridged; this assertion is the end-to-end guard
 *     that it stays bridged against a REAL server, which the mocked lane
 *     cannot prove.
 *
 * Asserted on the shared `[data-sidebar-status]` contract and the row's own
 * title slot, so a fix is free to route the signal any way it likes.
 */
async function expectRailRowTracksTheSession(
  page: Page,
  sessionId: string,
  promptText: string,
  releaseModelReply: () => void,
) {
  const row = await expectRailRowVisible({ page, sessionId, timeout: 15_000 })

  // Mid-turn: the row must show the working dot. Idle rows render a
  // relative-time label and no `[data-sidebar-status]` element at all.
  try {
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })
  } finally {
    releaseModelReply()
  }

  // Once the turn settles the server has the generated title; the rail must
  // stop showing the placeholder. Matched on "not the placeholder" rather than
  // on the exact generated string, which the model chooses and may reword.
  await expect(row.locator('[data-slot="session-navigation-title"]')).not.toHaveText(
    /^(New Session|Untitled session)$/,
    { timeout: 60_000 },
  )
  void promptText
}

type HarnessUsage = { turns: number; tokens: number }

async function harnessUsage(harness: string): Promise<HarnessUsage> {
  const url = new URL("/api/claxedo/usage", BACKEND_URL)
  const until = Date.now() + 60_000
  url.searchParams.set("since", String(until - 90 * 86_400_000 + 1))
  url.searchParams.set("until", String(until))
  url.searchParams.set("timezone", "UTC")
  url.searchParams.set("group", "harness")
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`usage metering probe failed: ${response.status} ${await response.text()}`)
  const body = (await response.json()) as {
    breakdown?: { rows?: Array<Record<string, unknown>> }
  }
  const row = body.breakdown?.rows?.find((item) => item.value === harness)
  return {
    turns: Number(row?.turnCount ?? 0),
    tokens:
      Number(row?.input ?? 0) +
      Number(row?.output ?? 0) +
      Number(row?.reasoning ?? 0) +
      Number(row?.cacheRead ?? 0) +
      Number(row?.cacheWrite ?? 0),
  }
}

async function expectUsageDashboardWorks(page: Page) {
  const trigger = page.getByTestId("rail-account-trigger")
  await trigger.focus()
  await page.keyboard.press("Enter")
  const usage = page.getByRole("menuitem", { name: "Usage", exact: true })
  await expect(usage, "the real account menu did not expose the canonical Usage action").toBeVisible()
  await usage.click()

  const dialog = page.getByRole("dialog", { name: "Usage" })
  await expect(dialog, "the real Usage dialog did not open").toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true")

  // Runtime turn facts belong to Claxedo usage; total-local reads provider logs.
  await dialog.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toHaveAttribute("aria-pressed", "true")
  const providerTable = dialog.getByRole("table", { name: "Usage grouped by provider" })
  await expect(providerTable, "the real provider attribution table did not render").toBeVisible({ timeout: 30_000 })
  await expect(providerTable).not.toContainText("Claxedo")
  await expect(providerTable.getByRole("row").nth(1), "the real provider attribution table was empty").toBeVisible()
  await expect(
    dialog.getByRole("img", { name: /^Daily tokens by/ }),
    "the exact turn did not reach the daily chart",
  ).toBeVisible()

  await dialog.getByRole("button", { name: "Cost" }).click()
  await expect(dialog.getByRole("img", { name: /^Daily estimated API cost\./ })).toBeVisible()
  await expect(dialog).toContainText("What these tokens would cost at API rates. Not what you were billed.")

  await dialog.getByRole("button", { name: "Total local usage" }).click()
  // Changing attribution starts a fresh usage query. Total-local legitimately
  // has zero attributed rows on an isolated runner, in which case the
  // canonical breakdown renders its empty state instead of a table.
  const providerBreakdown = dialog.locator("section.usage-breakdown")
  await expect(dialog.getByRole("heading", { name: "By provider" })).toBeVisible({ timeout: 30_000 })
  await expect(providerBreakdown).not.toContainText("Claxedo")
  await dialog.getByRole("button", { name: "Model", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "By model" })).toBeVisible()

  await dialog.getByRole("button", { name: "Usage limits" }).click()
  await expect(dialog.getByRole("heading", { name: "Quota windows" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toBeVisible()
  await dialog.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(dialog.getByRole("heading", { name: "By provider" })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger, "closing Usage did not restore focus to the account menu trigger").toBeFocused()
}

/** Drives the shared "3 scripted turns + reload, full oracle each turn" journey. */
async function runRealHarnessJourney(page: Page, dir: string, harness: HarnessCase) {
  scripted?.resetCounts()
  const meteringKey = harness.harnessKey ?? "pi"
  const usageBefore = await harnessUsage(meteringKey)
  const runId = `${Date.now()}`.slice(-6)
  const input = await openDraftPrompt(page, dir)

  if (harness.option) {
    await switchDraftHarness(page, harness.harnessKey)
    await waitForHarnessReady(page)
  } else {
    await selectScriptedModel(page)
  }

  const modelControl = page.locator('[data-action="prompt-harness-model"]:visible').last()
  const modelLabel = modelControl.locator('[data-slot="composer-control-label"]')
  await expect(modelLabel, `${harness.id} did not expose a model label`).toHaveText(/\S/, { timeout: 20_000 })
  const selectedModel = (await modelLabel.textContent())!.trim()
  const selectedModelPattern = new RegExp(selectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")

  const markers: string[] = []
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const marker = `REAL-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T${turn}`
    markers.push(marker)
    const promptText = `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
    const textbox = turn === 1 ? input : page.getByRole("textbox", { name: /Ask anything/i }).last()
    await composePrompt(page, textbox, promptText)
    if (turn === 1) scripted?.setReplyDelayMs(8_000)
    try {
      await page.locator(SELECTORS.submitControl).last().click()
      if (turn === 1) {
        await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
        const sessionId = /(?:\/s\/|\/session\/)([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
        expect(sessionId, "session route did not expose the created session id").toBeTruthy()
        // The rail is the surface the user navigates by, and until now this lane
        // — the ONLY one that runs a real harness against a real claxedo-server —
        // asserted nothing about it. Three separate rail defects shipped behind
        // that gap, all of them invisible to the mocked Tier M proofs because
        // those inject events straight onto the bus.
        await expectRailRowTracksTheSession(page, decodeURIComponent(sessionId!), promptText, () =>
          scripted?.setReplyDelayMs(0),
        )
        await expect(modelLabel, `${harness.id} lost its model label during the draft-to-session handoff`).toHaveText(
          selectedModelPattern,
        )
      }
    } finally {
      if (turn === 1) scripted?.setReplyDelayMs(0)
    }
    await expectAssistantReplyVisible(page, new RegExp(marker), {
      spec: "real-harness-local",
      scenario: `${harness.id}-turn-${turn}`,
    })
  }

  await expectLiveUserRowCount(page, markers.length)

  // Idle sessions can hand off their canonical transcript to another native runtime.
  if (harness.option) {
    const trigger = page.locator('[data-action="prompt-harness-model"]').last()
    await expect(trigger).not.toContainText(/Loading models|Select model|^$/)
    await expect(trigger).toBeEnabled()
    await trigger.click()
    await expect(
      page.locator('[data-component="harness-model-picker"] [data-slot="harness-picker-section"]').first(),
      "existing session should allow continuing with another harness",
    ).toBeEnabled()
    await page.keyboard.press("Escape")
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(modelLabel, `${harness.id} lost its model label after reload`).toHaveText(selectedModelPattern, {
    timeout: 20_000,
  })
  await expectAssistantReplyVisible(page, new RegExp(markers[TURNS - 1]!), {
    spec: "real-harness-local",
    scenario: `${harness.id}-reload`,
  })
  await expectLiveTurnsSettledAfterReload(page, markers)

  const usageAfter = await harnessUsage(meteringKey)
  const exactTokensPerTurn = 2
  expect(
    usageAfter.turns - usageBefore.turns,
    `${harness.id} did not settle exactly one usage fact per scripted turn`,
  ).toBe(TURNS)
  expect(
    usageAfter.tokens - usageBefore.tokens,
    `${harness.id} did not preserve the scripted provider's exact token totals`,
  ).toBe(TURNS * exactTokensPerTurn)

  await expectUsageDashboardWorks(page)

  // Behavior 6, asserted last so a reload-time re-fetch cannot inflate it.
  expect(scripted!.requests.filter((request) => request.dialect === harness.dialect
    && request.reply.kind === "text" && markers.includes(request.reply.text))).toHaveLength(TURNS)
  expectScriptedTraffic(harness.dialect, TURNS)
}

type SubagentHarnessCase = HarnessCase & {
  tool: { name: string; input: unknown; namespace?: string }
  openable: boolean
  sessionID?: string
  workspaceID?: string
  central?: boolean
  modelName?: RegExp
  modelSearch?: string
  permissionMode?: string
  effort?: string
}

async function runRealSubagentJourney(page: Page, dir: string, harness: SubagentHarnessCase) {
  scripted?.resetCounts()
  const input = harness.sessionID
    ? await openExistingPrompt(page, dir, harness.sessionID, harness.workspaceID, harness.central)
    : await openDraftPrompt(page, dir)

  if (!harness.sessionID && harness.option) {
    await switchDraftHarness(page, harness.harnessKey)
    if (harness.modelName) await selectHarnessModel(page, harness.modelName, harness.modelSearch)
    await waitForHarnessReady(page)
  } else if (!harness.sessionID) {
    await selectScriptedModel(page)
  }

  if (harness.effort) {
    const control = page.locator('[data-action="prompt-harness-model"]').last()
    await control.click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    await picker
      .locator('[data-slot="harness-picker-section"]')
      .filter({ hasText: /^Effort/ })
      .click()
    await picker.getByRole("button", { name: harness.effort, exact: true }).click()
    await expect(control).toContainText(harness.effort)
  }

  if (harness.permissionMode) {
    const permission = page.locator('[data-action="prompt-permission-mode"]').last()
    await expect(permission).toBeEnabled({ timeout: 30_000 })
    await permission.click()
    const row = page.locator(`[data-permission-mode-row][data-mode="${harness.permissionMode}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    await expect(permission).toHaveAttribute("data-mode", harness.permissionMode)
  }

  const marker = `SUBAGENT-${harness.id.replace(/[^a-z0-9]/gi, "")}-${`${Date.now()}`.slice(-6)}`
  scripted?.scriptTool({ ...harness.tool, whenPromptIncludes: marker })
  scripted?.setReplyDelayMs(process.env.CLAXEDO_E2E_RECORD_DEMO === "1" ? 2_000 : 750)
  try {
    await composePrompt(
      page,
      input,
      `Delegate one child task, then reply with exactly this one token and nothing else: ${marker}`,
    )
    if (harness.permissionMode) {
      await expect(page.locator('[data-action="prompt-permission-mode"]').last()).toHaveAttribute(
        "data-mode",
        harness.permissionMode,
      )
    }
    const submit = page.locator(SELECTORS.submitControl).last()
    if (harness.id === "pi") {
      const control = page.locator('[data-action="prompt-harness-model"]').last()
      await expect(control).toHaveAttribute("data-harness", "pi", { timeout: 30_000 })
      await expect(page.getByText("This Pi model is no longer available", { exact: true })).toHaveCount(0)
    }
    await expect(submit, `${harness.id} composer never became submit-ready`).toHaveAttribute("aria-label", "Send", {
      timeout: 30_000,
    })
    await submit.click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expect
      .poll(() => scripted?.requests.some((request) => request.reply.kind === "tool") ?? false, {
        message: `${harness.id} never received its scripted tool payload`,
        timeout: 30_000,
      })
      .toBe(true)
    await expect(page.getByText("Could not save session config", { exact: true })).toHaveCount(0)
    const card = page.locator('[data-component="task-tool-card"]').last()
    await expect(card, `${harness.id} never rendered its native delegation as a subagent card`).toBeVisible({
      timeout: 60_000,
    })
    await expect(card.locator('[data-slot="subagent-status"]')).toHaveText(/Pending|Working|Completed/, { timeout: 30_000 })
    await demoBeat(page)
    await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Completed", {
      timeout: 90_000,
    })
    await expect(page.locator(SELECTORS.userMessageContent).filter({ hasText: marker })).toBeVisible()
    await demoBeat(page)

    const anchor = card.locator("xpath=ancestor::a[1]")
    if (!harness.openable) {
      await expect(card.locator('[data-slot="basic-tool-tool-subtitle"]')).toContainText("Transcript unavailable")
      await expect(anchor).toHaveCount(0)
    } else {
      await expect(anchor, `${harness.id} completed without an openable child transcript`).toHaveCount(1)
      await anchor.click()
      await expect(page.locator("[data-subagent-child-heading]")).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
      await expectAssistantReplyVisible(page, "ok", {
        spec: "real-harness-local",
        scenario: `${harness.id}-subagent-child`,
      })
      await demoBeat(page)
    }
  } finally {
    scripted?.setReplyDelayMs(0)
  }

  const toolRequest = scripted?.requests.find((request) => request.reply.kind === "tool")
  expect(toolRequest?.reply).toEqual({ kind: "tool", ...harness.tool })
  const counts = scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 }
  expect(
    counts[harness.dialect],
    `${harness.id} did not execute through its scripted provider endpoint`,
  ).toBeGreaterThanOrEqual(2)
  for (const other of ["chat", "messages", "responses"] as const) {
    if (other === harness.dialect) continue
    expect(counts[other], `${harness.id} leaked model traffic onto ${other}`).toBeLessThanOrEqual(
      other === "chat" ? 1 : 0,
    )
  }
}

async function runWorkspaceSubagentJourney(
  page: Page,
  workspaceName: string,
  bootstrapHarness: string | undefined,
  harness: SubagentHarnessCase,
) {
  const dir = await makeWorkspace(workspaceName, bootstrapHarness)
  await seedOneProject(page, dir)
  await runRealSubagentJourney(page, dir, harness)
}

async function runCursorHarnessBoundary(page: Page) {
  scripted?.resetCounts()
  const dir = await makeWorkspace("cursor", "cursor")
  await seedOneProject(page, dir)
  const input = await openDraftPrompt(page, dir)
  await switchDraftHarness(page, "cursor")

  const notice = page.getByRole("alert").filter({ hasText: "Couldn't load Cursor models" })
  const modelControl = page.locator('[data-action="prompt-harness-model"]')
  await expect
    .poll(
      async () => ((await notice.count()) > 0 ? "unavailable" : (await modelControl.count()) > 0 ? "ready" : "pending"),
      {
        timeout: 30_000,
        message: "composer settled into neither the cursor-ready nor the runtime-unavailable state",
      },
    )
    .not.toBe("pending")

  if ((await notice.count()) > 0) {
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveAttribute("data-tone", "critical")
    await expect(notice.locator("[data-action='composer-notice-action']")).toBeVisible()
    await composePrompt(page, input, "tier-real cursor unavailable attempt")
    await page.locator(SELECTORS.submitControl).last().click()
  } else {
    await expect(modelControl).toHaveCount(1)
    await expect(modelControl.last()).not.toContainText(/Loading models|Select model/i, { timeout: 30_000 })
  }
  await demoBeat(page)

  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-harness"]')).toHaveCount(0)
  expect(
    scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 },
    "expected the scripted model server to receive zero requests during the cursor scenario — any count here means " +
      "selecting Cursor routed through a provider it does not own",
  ).toEqual({ chat: 0, messages: 0, responses: 0 })
}

const CURSOR_SDK_GOAL_UNAVAILABLE =
  "Cursor SDK requires an explicit cursor API key. Cursor ACP can use the local Cursor login."

async function runCursorGoalUnavailableJourney(page: Page, entry: GoalEntry) {
  scripted?.resetCounts()
  const dir = await makeWorkspace(`cursor-goal-unavailable-${entry}`, "cursor")
  await seedOneProject(page, dir)
  const input = await openDraftPrompt(page, dir)
  await switchDraftHarness(page, "cursor")

  const browserGoalRequests: Array<{ method: string; pathname: string }> = []
  const browserSessionCreates: string[] = []
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname
    if (request.method() === "POST" && pathname === "/session") browserSessionCreates.push(pathname)
    if (/\/session\/[^/]+\/goal(?:\/capabilities|\/state)?$/.test(pathname)) {
      browserGoalRequests.push({ method: request.method(), pathname })
    }
  })

  const objective = `Prove Cursor ${entry} Goal unavailability`
  if (entry === "slash") {
    await composePrompt(page, input, `/goal ${objective}`)
  } else {
    await page.locator('[data-action="prompt-add"]').last().click()
    const goal = page.locator('[data-action="prompt-goal"]')
    await expect(goal).toBeVisible({ timeout: 10_000 })
    await expect(goal).toBeEnabled()
    await goal.click()
    const goalInput = page.getByRole("textbox", { name: /Describe the outcome this Goal should reach/i }).last()
    await composePrompt(page, goalInput, objective)
  }

  const notice = page.getByRole("alert").filter({ hasText: "Couldn't load Cursor models" })
  await expect(notice).toContainText("Couldn't load Cursor models", { timeout: 30_000 })
  await expect(notice).toContainText(CURSOR_SDK_GOAL_UNAVAILABLE)
  const submit = page.locator('[data-action="prompt-submit"]').last()
  await expect(submit).toHaveAccessibleName("The agent isn't running")
  const draftUrl = page.url()
  await submit.click()
  expect(page.url()).toBe(draftUrl)
  expect(browserSessionCreates).toHaveLength(0)
  await expect(page.locator('[data-component="session-goal-dock"]')).toHaveCount(0)
  await expect(entry === "slash" ? input : page.getByRole("textbox", {
    name: /Describe the outcome this Goal should reach/i,
  }).last()).toContainText(objective)

  // Model readiness blocks a draft before it can own a session. Exercise the
  // real per-session Goal boundary separately so the unavailable assertion is
  // about Goal support itself, not inferred from the model-catalog notice.
  const session = await createHarnessSession(dir, {
    title: `Cursor ${entry} Goal capability probe`,
    harness: "cursor",
    providerID: "cursor",
    modelID: "default",
  })
  const response = await fetch(
    `${BACKEND_URL}/session/${encodeURIComponent(session.id)}/goal/capabilities?directory=${encodeURIComponent(dir)}`,
  )
  const capabilities = await response.json().catch(() => undefined)
  expect(response.status, JSON.stringify(capabilities)).toBe(200)
  expect(capabilities).toEqual({
    implemented: true,
    available: false,
    unavailableReason: CURSOR_SDK_GOAL_UNAVAILABLE,
    actions: [],
    recovery: "blocked",
    optionalFields: [],
  })
  expect(browserGoalRequests).toHaveLength(0)
  expect(
    scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 },
    "an unavailable Cursor Goal must not dispatch a prompt to any redirectable provider",
  ).toEqual({ chat: 0, messages: 0, responses: 0 })
}

async function demoBeat(page: Page) {
  if (process.env.CLAXEDO_E2E_RECORD_DEMO !== "1") return
  // Recording-only pacing. Every behavioral wait is asserted independently;
  // normal E2E runs never pay for these pauses.
  await page.waitForTimeout(1_200)
}

async function createPickerSession(dir: string) {
  return createHarnessSession(dir, {
    title: "Timeline turn picker",
    harness: "pi",
    providerID: "openai",
    modelID: "gpt-4",
  })
}

async function createHarnessSession(
  dir: string,
  input: {
    title: string
    harness: string
    providerID: string
    modelID: string
  },
) {
  const response = await fetch(`${BACKEND_URL}/session?directory=${encodeURIComponent(dir)}&nativeHarness=${input.harness}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      model: { providerID: input.providerID, modelID: input.modelID },
    }),
  })
  if (response.status !== 201) {
    throw new Error(`GATING: failed to seed picker session (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as { id: string }
}

async function createPiSession(dir: string) {
  const workspaceResponse = await fetch(
    `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`,
  )
  if (!workspaceResponse.ok)
    throw new Error(`GATING: failed to resolve Pi workspace: ${await workspaceResponse.text()}`)
  const workspace = (await workspaceResponse.json()) as { workspaceId: string }
  const response = await fetch(`${BACKEND_URL}/api/control/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "hybrid",
      title: "Pi subagent showcase",
      harness: "pi",
      workspaceId: workspace.workspaceId,
      model: { providerID: "openai", modelID: "gpt-4" },
      toolSandbox: { kind: "workspace-runtime", workspaceId: workspace.workspaceId },
    }),
  })
  if (!response.ok)
    throw new Error(`GATING: failed to create Pi session (${response.status}): ${await response.text()}`)
  const created = (await response.json()) as { session: { id: string } }
  const metadataResponse = await fetch(
    `${BACKEND_URL}/api/claxedo/session/${encodeURIComponent(created.session.id)}/meta`,
  )
  const metadata = await metadataResponse.json().catch(() => undefined) as { tags?: unknown } | undefined
  if (!metadataResponse.ok || !Array.isArray(metadata?.tags) || !metadata.tags.includes("harness:pi")) {
    throw new Error(
      `GATING: Pi session metadata lost its canonical harness identity (${metadataResponse.status}): ${JSON.stringify(metadata)}`,
    )
  }
  return { ...created, workspaceId: workspace.workspaceId }
}

async function openExistingPrompt(page: Page, dir: string, sessionID: string, workspaceID?: string, central = false) {
  await page.goto(
    central || !workspaceID
      ? `/s/${encodeURIComponent(sessionID)}`
      : `/w/${encodeURIComponent(workspaceID)}/session/${encodeURIComponent(sessionID)}`,
    { waitUntil: "domcontentloaded" },
  )
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const exactRoot = page.locator(`[data-testid="session-page-root"][data-session-id="${sessionID}"]`)
  await expect(exactRoot, `direct route never activated session ${sessionID}`).toBeVisible({ timeout: 30_000 })
  const input = exactRoot.getByRole("textbox", { name: /Ask anything/i })
  await expect(input).toBeVisible({ timeout: 20_000 })
  return input
}

async function selectHarnessModel(page: Page, name: RegExp, searchText?: string) {
  const control = page.locator('[data-action="prompt-harness-model"]').last()
  await control.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  const modelSection = picker.locator('[data-slot="harness-picker-section"]').filter({ hasText: /^Model/ })
  await modelSection.click()
  if (searchText) {
    const search = picker.getByRole("textbox", { name: /Search models/i })
    await search.fill(searchText)
  }
  const option = picker.getByRole("button", { name }).last()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(control).toContainText(name, { timeout: 30_000 })
}

async function seedPickerTurn(dir: string, sessionID: string, turn: number) {
  const marker = `PICKER-${String(turn).padStart(2, "0")}-${Date.now().toString().slice(-5)}`
  const prompt = `Reply with exactly this one token and nothing else: ${marker}`
  const messageID = `msg_picker_user_${turn}`
  const response = await fetch(
    `${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageID, model: { providerID: "openai", modelID: "gpt-4" }, parts: [{ type: "text", text: prompt }] }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  expect(response.status, await response.text()).toBe(200)
  return { marker, prompt, messageID }
}

test.describe("real harness journeys @core @tier-real", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run real-harness-local against a real claxedo-server + real harness " +
      "binaries pointed at the scripted model endpoint. This lane bakes its own backend origin " +
      "(VITE_CLAXEDO_SERVER_URL) into the app build, so it cannot ride a sharded core run — it has its own CI job. " +
      "Unset -> loud, visible skip per e2e/INVARIANTS.md rule 6, never a silent no-op.",
  )

  test.beforeAll(async ({}, testInfo) => {
    if (!TIER_REAL) return
    // waitForHealth owns a 90-second clean-runner boot budget. Keep the hook's
    // outer deadline longer so a real health failure reports its server-log
    // diagnostic instead of being replaced by Playwright's 60-second default.
    testInfo.setTimeout(120_000)
    await startServer()
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    await stopServer()
  })

  test.beforeEach(async ({}, testInfo) => {
    // The scripted endpoint answers instantly, but subprocess spawn plus the
    // ACP handshake still costs real seconds on each scenario's first turn.
    testInfo.setTimeout(240_000)
  })

  test.afterEach(async ({}, testInfo) => {
    // The server's stdout/stderr is buffered into `serverLog` and otherwise
    // surfaced only on GATING boot failures. On a FAILED test it is the only
    // record of what the engine actually did (or refused to do) on a CI
    // runner nobody can shell into — the first tier-real CI red burned a full
    // round because the picker said "No model results" and nothing said why.
    if (testInfo.status !== testInfo.expectedStatus && server) {
      await testInfo.attach("claxedo-server.log", { body: server.log(), contentType: "text/plain" })
    }
    if (testInfo.status !== testInfo.expectedStatus && scripted?.requests.length) {
      await testInfo.attach("scripted-model-requests.json", {
        body: JSON.stringify(scripted.requests.map((request) => ({
          dialect: request.dialect,
          model: request.model,
          prompt: request.prompt,
          reply: request.reply,
        })), null, 2),
        contentType: "application/json",
      })
    }
  })

  test("pi-workspace harness completes exact turns, reload, and visible usage — behaviors 1,6,9,11", async ({ page }) => {
    const dir = await makeWorkspace("pi-workspace")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, { id: "pi-workspace", dialect: "responses" })
  })

  test("pi-workspace Goal runs through slash and + entry paths with continuation and lifecycle controls", async ({ page }, testInfo) => {
    for (const entry of ["slash", "add-menu"] as const) {
      scripted?.resetCounts()
      const dir = await makeWorkspace(`pi-workspace-goal-${entry}`)
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await selectScriptedModel(page)
      const objective = `Prove the ${entry} Goal journey`

      if (entry === "add-menu") scripted?.setReplyDelayMs(5_000)
      const dock = await startGoalFromComposer(page, input, entry, objective)

      if (entry === "add-menu") {
        await expect(goalStatus(dock, "Active")).toBeVisible()
        const evidence = path.join(
          APP_DIR,
          "test-results/evidence/real-harness-local/pi-workspace-goal-add-menu-active.png",
        )
        await fs.mkdir(path.dirname(evidence), { recursive: true })
        await page.screenshot({ path: evidence })
        await testInfo.attach("pi-workspace-goal-add-menu-active", { path: evidence, contentType: "image/png" })
        await dock.getByRole("button", { name: "Pause", exact: true }).click()
        await expect(goalStatus(dock, "Paused")).toBeVisible({ timeout: 30_000 })
        scripted?.setReplyDelayMs(0)
        await dock.getByRole("button", { name: "Resume", exact: true }).click()
      }

      await expect(goalStatus(dock, "Complete")).toBeVisible({ timeout: 90_000 })
      await expect(dock).toContainText("Iteration 2")
      const evaluations = scripted?.requests.filter((request) =>
        request.prompt.includes("You are an independent completion evaluator.")) ?? []
      expect(evaluations).toHaveLength(2)
      expect(evaluations.map((request) => request.reply)).toEqual([
        { kind: "text", text: JSON.stringify({ met: false, reason: "One more autonomous iteration is required" }) },
        { kind: "text", text: JSON.stringify({ met: true, reason: "The scripted continuation supplied the required evidence" }) },
      ])
      await deleteGoalFromDock(page, dock)
    }
  })

  test("local new-worktree session receives its first reply — behaviors 1,6,9,12", async ({ page }) => {
    scripted?.resetCounts()
    const dir = await makeWorkspace("new-local-worktree")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await selectScriptedModel(page)

    const environment = page.locator('[data-slot="context-chip-environment"]')
    await environment.click()
    const environmentPicker = page.locator('[data-context-chip-picker="context-chip-environment"]')
    await expect(environmentPicker).toBeVisible()
    await environmentPicker.getByRole("button", { name: /^Local/ }).click()
    await expect(environment.locator('[data-slot="context-chip-label"]')).toHaveText("Local")

    const workspace = page.locator('[data-slot="context-chip-worktree"]')
    await workspace.click()
    const workspacePicker = page.locator('[data-context-chip-picker="context-chip-worktree"]')
    await expect(workspacePicker).toBeVisible()
    await workspacePicker.locator('[data-slot="context-chip-action"]').click()
    await expect(workspace.locator('[data-slot="context-chip-label"]')).toHaveText("New local worktree")

    const marker = `NEW-WORKTREE-${Date.now().toString().slice(-6)}`
    await composePrompt(page, input, `Reply with exactly this one token and nothing else: ${marker}`)
    const worktreeCreated = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "POST" && url.pathname === "/experimental/worktree"
    })
    await page.locator(SELECTORS.submitControl).last().click()
    const worktreeResponse = await worktreeCreated
    expect(worktreeResponse.status(), await worktreeResponse.text()).toBe(200)
    const created = await worktreeResponse.json() as { directory: string; name: string; branch: string }
    expect(created.directory).not.toBe(dir)
    const canonicalDirectory = await fs.realpath(created.directory)
    expect(created.directory).toBe(canonicalDirectory)

    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expectAssistantReplyVisible(page, marker)
    expectScriptedTraffic("responses", 1)

    const environmentCard = page.getByRole("complementary", { name: "Session environment" })
    await expect(environmentCard).toBeVisible()
    const expandEnvironment = environmentCard.getByRole("button", { name: "Expand Environment" })
    if (await expandEnvironment.isVisible()) await expandEnvironment.click()
    const worktreeCopy = environmentCard.getByRole("button", { name: `Copy worktree name ${created.name}` })
    const branchCopy = environmentCard.getByRole("button", { name: `Copy branch name ${created.branch}` })
    await expect(worktreeCopy).toBeVisible()
    await expect(branchCopy).toBeVisible()
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin })
    await worktreeCopy.click()
    await expect(environmentCard.getByRole("button", { name: `Copied worktree name ${created.name}` })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(created.name)
    await branchCopy.click()
    await expect(environmentCard.getByRole("button", { name: `Copied branch name ${created.branch}` })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(created.branch)
    const environmentEvidence = path.join(
      APP_DIR,
      "test-results/evidence/real-harness-local/local-new-worktree-environment-card.png",
    )
    await fs.mkdir(path.dirname(environmentEvidence), { recursive: true })
    await page.screenshot({ path: environmentEvidence })

    const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: dir })
    expect(listed.stdout).toContain(`worktree ${canonicalDirectory}`)
  })

  test("timeline turn picker previews one seeded turn and appears only after 10 — behavior 10", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(600_000)
    const dir = await makeWorkspace("turn-picker")
    await seedOneProject(page, dir)
    const session = await createPickerSession(dir)
    const turns: Awaited<ReturnType<typeof seedPickerTurn>>[] = []
    for (let turn = 1; turn < TURN_PICKER_TURNS; turn += 1) {
      turns.push(await seedPickerTurn(dir, session.id, turn))
    }

    await page.goto(`/s/${session.id}#message-${turns[0]!.messageID}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const sessionRoot = page
      .locator(`[data-testid="session-page-root"][data-session-id="${session.id}"][data-session-messages-ready="true"]`)
      .filter({ visible: true })
    await expect(sessionRoot).toHaveAttribute("data-session-visible-user-count", String(TURN_PICKER_TURNS - 1), {
      timeout: 30_000,
    })
    await expect(
      page.locator('[data-component="message-nav-hovercard"]'),
      "turn picker rendered at 10 turns",
    ).toHaveCount(0)

    turns.push(await seedPickerTurn(dir, session.id, TURN_PICKER_TURNS))
    await page.reload({ waitUntil: "domcontentloaded" })

    await expect(sessionRoot).toHaveAttribute("data-session-visible-user-count", String(TURN_PICKER_TURNS))
    const picker = sessionRoot.locator('[data-component="message-nav-hovercard"]')
    const ticks = picker.locator('[data-slot="message-nav-tick-button"]')
    await expect(picker).toBeVisible()
    await expect(ticks).toHaveCount(TURN_PICKER_TURNS)
    expect(
      await ticks.evaluateAll((items) =>
        items.map((item) => ({ tagName: item.tagName, role: item.getAttribute("role") })),
      ),
    ).toEqual(Array.from({ length: TURN_PICKER_TURNS }, () => ({ tagName: "BUTTON", role: null })))
    await expect(picker.locator('[data-slot="message-nav-tick-button"][aria-current="step"]')).toHaveCount(1)
    await expect(picker.locator('[data-slot="message-nav-tick-button"][data-distance="0"]')).toHaveCount(1)
    await demoBeat(page)

    const assertPreview = async (index: number) => {
      await ticks.nth(index).hover()
      const preview = page.locator('[data-slot="message-nav-turn-preview"]:visible')
      await expect(preview, `turn ${index + 1} preview did not open`).toHaveCount(1)
      await expect(preview.locator('[data-slot="message-nav-preview-user"]')).toContainText(turns[index]!.prompt)
      await expect(preview.locator('[data-slot="message-nav-preview-assistant"]')).toContainText(turns[index]!.marker)
      return preview
    }

    await ticks.nth(1).focus()
    const focusedPreview = page.locator('[data-slot="message-nav-turn-preview"]:visible')
    await expect(focusedPreview.locator('[data-slot="message-nav-preview-user"]')).toContainText(turns[1]!.prompt)
    await page.keyboard.press("Escape")
    await expect(focusedPreview).toHaveCount(0)
    await expect(ticks.nth(1)).toBeFocused()
    await ticks.nth(1).evaluate((element) => element.blur())

    const firstPreview = await assertPreview(1)
    await firstPreview.hover()
    await expect(firstPreview).toBeVisible()
    await demoBeat(page)
    await assertPreview(4)
    await expect
      .poll(() =>
        ticks.evaluateAll((items) =>
          items.map((item) => {
            const line = item.querySelector<HTMLElement>('[data-slot="message-nav-tick-line"]')!
            return Math.round(line.getBoundingClientRect().width)
          }),
        ),
      )
      .toEqual([8, 11, 15, 21, 28, 21, 15, 11, 8, 8, 8])
    expect(
      await ticks.evaluateAll((items) => {
        const styles = items.map((item) =>
          getComputedStyle(item.querySelector<HTMLElement>('[data-slot="message-nav-tick-line"]')!),
        )
        return styles.flatMap((style, index) =>
          style.backgroundColor === styles[4]!.backgroundColor && style.height === styles[4]!.height ? [index] : [],
        )
      }),
    ).toEqual([4])
    await demoBeat(page)
    await ticks.nth(4).click()
    await expect(
      page.locator(SELECTORS.userMessageContent).filter({ hasText: turns[4]!.prompt }).last(),
      "clicked turn did not scroll into the timeline viewport",
    ).toBeInViewport()
    await demoBeat(page)
  })

  test("claude native SDK harness completes exact turns, reload, and visible usage — behaviors 3,6,8,9,11", async ({
    page,
  }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(
      binary,
      "claude",
      "the native claude harness resolves its model catalog through the same CLI installation.",
    )
    const dir = await makeWorkspace("claude", "claude")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, {
      id: "claude",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude",
    })
  })

  test("claude native Goal supports slash and + entry paths, autonomous continuation, and Goal-aware Stop", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "the native Claude Goal contract is owned by the installed Claude CLI.")

    try {
      for (const entry of ["slash", "add-menu"] as const) {
        scripted?.resetCounts()
        scripted?.setReplyDelayMs(entry === "add-menu" ? 5_000 : 1_000)
        const dir = await makeWorkspace(`claude-goal-${entry}`, "claude")
        await seedOneProject(page, dir)
        const input = await openDraftPrompt(page, dir)
        await switchDraftHarness(page, "claude")
        await waitForHarnessReady(page)
        const dock = await startGoalFromComposer(page, input, entry, `Prove Claude ${entry} Goal Stop`)

        await expect(goalStatus(dock, "Active")).toBeVisible()
        // A native Claude Goal runs inside the provider session, so Claxedo
        // cannot pause or resume it — but it CAN drop its own record of one,
        // which `createNativeGoalResource` advertises per session for an
        // available driver. Delete is therefore the only control on this dock.
        await expect(dock.getByRole("button", { name: /Pause|Resume/ })).toHaveCount(0)
        await expect(dock.getByRole("button", { name: "Delete", exact: true })).toHaveCount(1)
        if (entry === "slash") {
          scripted?.setReplyDelayMs(0)
          await expect.poll(() => scripted?.requests.filter((request) =>
            request.prompt.includes("Based on the conversation transcript above, has the following stopping condition been satisfied?"),
          ).length ?? 0, {
            timeout: 90_000,
            message: "native Claude Goal did not run its two-pass completion evaluation",
          }).toBe(2)
          await expect(dock).toHaveCount(0, { timeout: 30_000 })
          expectScriptedTraffic("messages", 4)
          continue
        }
        const stop = page.locator('[data-action="prompt-submit"]').last()
        await expect(stop).toHaveAccessibleName("Stop")
        await stop.click()
        await expect(goalStatus(dock, "Paused")).toBeVisible({ timeout: 30_000 })
        expectScriptedTraffic("messages", 1)
      }
    } finally {
      scripted?.setReplyDelayMs(0)
    }
  })

  test("claude native SDK runs a provider-issued Agent call as an openable subagent", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the Claude CLI to exercise its native Agent tool.")
    const dir = await makeWorkspace("claude-subagent", "claude")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "claude",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude",
      tool: {
        name: "Agent",
        input: {
          description: "Verify child delegation",
          prompt: "Reply with exactly CHILD-CLAUDE-NATIVE",
          subagent_type: "general-purpose",
          run_in_background: false,
        },
      },
      openable: true,
      permissionMode: "bypassPermissions",
    })
  })

  test("workspace Pi executes a provider-issued bash tool and persists its output", async ({ page }) => {
    const dir = await makeWorkspace("pi-bash")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await selectScriptedModel(page)
    scripted!.resetCounts()
    const marker = `PI-BASH-${Date.now()}`
    scripted!.scriptTool({ name: "bash", input: { command: "printf 'PI_BASH_TOOL_OUTPUT'" }, whenPromptIncludes: marker })
    await composePrompt(page, input, `Run the command, then reply with exactly this one token and nothing else: ${marker}`)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expectAssistantReplyVisible(page, marker)
    const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
    const response = await fetch(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
    expect(response.status).toBe(200)
    const history = await response.json() as Array<{ parts: Array<{ type: string; tool?: string; state?: { status: string; output?: string } }> }>
    const bash = history.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "bash")
    expect(bash?.state).toMatchObject({ status: "completed", output: "PI_BASH_TOOL_OUTPUT" })
    const advertisedTools = scripted!.requests[0]!.tools.map((tool) => tool.name)
    expect(advertisedTools).toContain("bash")
    expect(advertisedTools).not.toContain("subagent")
    expect(scripted!.requests.filter((request) => request.reply.kind === "tool")).toHaveLength(1)
    expectScriptedTraffic("responses", 2)
  })

  test("Pi runs a provider-issued subagent call as an openable child session", async ({ page }) => {
    const dir = await makeWorkspace("pi-subagent", "pi")
    await seedOneProject(page, dir)
    const session = await createPiSession(dir)
    await runRealSubagentJourney(page, dir, {
      id: "pi",
      dialect: "responses",
      sessionID: session.session.id,
      workspaceID: session.workspaceId,
      central: true,
      tool: {
        name: "subagent",
        input: {
          task: "Reply with exactly CHILD-PI",
          title: "Verify Pi child delegation",
          background: false,
        },
      },
      openable: true,
    })
  })

  test("Pi Goal runs through slash and + entry paths with continuation and lifecycle controls", async ({ page }) => {
    try {
      for (const entry of ["slash", "add-menu"] as const) {
        scripted?.resetCounts()
        const dir = await makeWorkspace(`pi-goal-${entry}`, "pi")
        await seedOneProject(page, dir)
        const session = await createPiSession(dir)
        const input = await openExistingPrompt(page, dir, session.session.id, session.workspaceId, true)
        const objective = `Prove Pi ${entry} Goal controls`

        scripted?.setReplyDelayMs(5_000)
        const dock = await startGoalFromComposer(page, input, entry, objective)
        if (entry === "add-menu") {
          await dock.getByRole("button", { name: "Pause", exact: true }).click()
          await expect(goalStatus(dock, "Paused")).toBeVisible({ timeout: 30_000 })
          scripted?.setReplyDelayMs(0)
          await dock.getByRole("button", { name: "Resume", exact: true }).click()
        }

        await expect(goalStatus(dock, "Complete")).toBeVisible({ timeout: 90_000 })
        await expect(dock).toContainText("Iteration 2")
        expect(scripted?.requests.filter((request) =>
          request.reply.kind === "text" && request.reply.text.includes('"met":'))).toHaveLength(2)
        await deleteGoalFromDock(page, dock)
      }
    } finally {
      scripted?.setReplyDelayMs(0)
    }
  })

  test("codex native SDK harness completes exact turns, reload, and visible usage — behaviors 5,6,8,9,11", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "the native codex harness drives the same CLI's `app-server` subcommand.")
    const dir = await makeWorkspace("codex-sdk", "codex")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, {
      id: "codex-sdk",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex",
    })
  })

  test("codex native Goal supports slash and + entry paths with continuation, pause, resume, and delete", async ({ page }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "the native Codex Goal contract is owned by the installed app-server binary.")

    try {
      for (const entry of ["slash", "add-menu"] as const) {
        scripted?.resetCounts()
        if (entry === "add-menu") scripted?.setReplyDelayMs(5_000)
        const dir = await makeWorkspace(`codex-goal-${entry}`, "codex")
        await seedOneProject(page, dir)
        const input = await openDraftPrompt(page, dir)
        await switchDraftHarness(page, "codex")
        await waitForHarnessReady(page)
        const dock = await startGoalFromComposer(page, input, entry, `Prove Codex ${entry} Goal controls`)

        await expect(goalStatus(dock, "Active")).toBeVisible()
        await expect.poll(() => scripted?.counts().responses ?? 0, {
          timeout: 30_000,
          message: "native Codex Goal never reached the configured responses provider",
        }).toBeGreaterThanOrEqual(1)
        const requestsBeforePause = scripted?.counts().responses ?? 0
        await dock.getByRole("button", { name: "Pause", exact: true }).click()
        await expect(goalStatus(dock, "Paused")).toBeVisible({ timeout: 30_000 })
        scripted?.setReplyDelayMs(0)
        await dock.getByRole("button", { name: "Resume", exact: true }).click()
        await expect(goalStatus(dock, "Active")).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => scripted?.counts().responses ?? 0, {
          timeout: 30_000,
          message: "resuming native Codex Goal did not continue provider work",
        }).toBeGreaterThan(requestsBeforePause)
        const counts = scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 }
        expect(counts.messages, `native Codex Goal fell back to messages traffic: ${JSON.stringify(counts)}`).toBe(0)
        expect(counts.chat, `native Codex Goal emitted unexpected chat traffic: ${JSON.stringify(counts)}`).toBeLessThanOrEqual(1)
        await deleteGoalFromDock(page, dock)
      }
    } finally {
      scripted?.setReplyDelayMs(0)
    }
  })

  test("codex pending approval survives session switches without duplicate prompt, rail, or hydration regressions — behavior 13", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to exercise a real app-server approval request.")
    const dir = await makeWorkspace("codex-sdk-pending-approval", "codex")
    await seedOneProject(page, dir)
    await page.addInitScript(() => {
      const key = "tier-real:permission-mode-history"
      const record = () => {
        const prior = JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]
        const modes = Array.from(document.querySelectorAll('[data-action="prompt-permission-mode"]'))
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.getAttribute("data-mode") ?? "<unresolved>")
        sessionStorage.setItem(key, JSON.stringify([...new Set([...prior, ...modes])]))
        requestAnimationFrame(record)
      }
      requestAnimationFrame(record)
    })

    scripted?.resetCounts()
    const firstInput = await openDraftPrompt(page, dir)
    await switchDraftHarness(page, "codex")
    await waitForHarnessReady(page)
    const firstMarker = `APPROVAL-SWITCH-TARGET-${Date.now().toString().slice(-6)}`
    await composePrompt(page, firstInput, `Reply with exactly this one token and nothing else: ${firstMarker}`)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expectAssistantReplyVisible(page, firstMarker)
    const firstSessionId = /(?:\/s\/|\/session\/)([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
    expect(firstSessionId).toBeTruthy()
    await expectRailTitleSettled({ page, sessionId: decodeURIComponent(firstSessionId!), timeout: 60_000 })

    const pendingInput = await openDraftPrompt(page, dir)
    await switchDraftHarness(page, "codex")
    await waitForHarnessReady(page)
    const permissionMode = page.locator('[data-action="prompt-permission-mode"]').last()
    await expect(permissionMode).toHaveAttribute("data-mode", "workspace-write", { timeout: 30_000 })

    const marker = `PENDING-APPROVAL-${Date.now().toString().slice(-6)}`
    const outsidePath = path.join(os.tmpdir(), `claxedo-tier-real-denied-${Date.now()}.txt`)
    const approvalTool = {
      name: "exec_command",
      input: {
        cmd: `printf denied-write > ${JSON.stringify(outsidePath)}`,
        sandbox_permissions: "require_escalated",
        justification: "Tier R must exercise the real Codex approval boundary.",
      },
      whenPromptIncludes: marker,
    }
    scripted?.scriptTool(approvalTool)
    await composePrompt(page, pendingInput, `Run the requested command, then reply with exactly ${marker}.`)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    const pendingSessionId = /(?:\/s\/|\/session\/)([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
    expect(pendingSessionId).toBeTruthy()
    const pendingId = decodeURIComponent(pendingSessionId!)
    await expect
      .poll(() => scripted?.requests.some((request) => request.reply.kind === "tool") ?? false, {
        timeout: 30_000,
        message: "native Codex never received the scripted command tool call",
      })
      .toBe(true)
    const approvalToolRequest = scripted?.requests.find((request) => request.reply.kind === "tool")
    expect(approvalToolRequest?.reply).toEqual({
      kind: "tool",
      name: approvalTool.name,
      input: approvalTool.input,
    })
    expectScriptedTraffic("responses", 2)

    // Session surfaces stay mounted for fast switching; scope assertions to
    // the dock the user can actually see, not a stashed background surface.
    const permissionDock = page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })
    await expect(permissionDock).toBeVisible({ timeout: 60_000 })
    // A pending approval owns the composer. This is the user-visible guard
    // against submitting a second prompt into an already-active runtime turn.
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
    await expect(page.locator(SELECTORS.submitControl)).toHaveCount(0)
    const pendingRow = await expectRailRowVisible({ page, sessionId: pendingId, timeout: 30_000 })
    await expect(pendingRow.locator('[data-slot="session-navigation-title"]')).toHaveText(/\S/)
    await expect(pendingRow.locator('[data-sidebar-status="permission"]')).toHaveCount(1, { timeout: 30_000 })

    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${firstSessionId}"]`).click()
    await expect.poll(() => new URL(page.url()).pathname.endsWith(firstSessionId!)).toBe(true)
    await expect(permissionDock).toHaveCount(0)
    await expect(pendingRow.locator('[data-sidebar-status="permission"]')).toHaveCount(1)
    await pendingRow.click()
    await expect.poll(() => new URL(page.url()).pathname.endsWith(pendingSessionId!)).toBe(true)
    await expect(permissionDock).toBeVisible({ timeout: 30_000 })
    expect(pageErrors.filter((message) => message.includes("_tag") || message.includes("Cannot read properties of undefined"))).toEqual([])

    await page.getByRole("button", { name: "Deny", exact: true }).click()
    await expect(permissionDock).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 30_000 })
    const modelControl = page.locator('[data-action="prompt-harness-model"]').filter({ visible: true }).last()
    await expect(modelControl).toHaveAttribute("data-harness", "codex")
    await expect(modelControl).not.toContainText(/Workspace Pi|Select model|Connecting/i, { timeout: 30_000 })
    await expect(page.getByText("Session is already processing a message", { exact: false })).toHaveCount(0)
    await expect(page.getByTestId("first-turn-recovery-card")).toHaveCount(0)
    await expect(page.locator(".error-card")).toHaveCount(0)
    await expectRailTitleSettled({ page, sessionId: pendingId, timeout: 60_000 })
    await expectRailStatusAbsent({ page, sessionId: pendingId, timeout: 60_000 })
    await expect.poll(() => fs.stat(outsidePath).then(() => true).catch(() => false)).toBe(false)

    const permissionModes = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("tier-real:permission-mode-history") ?? "[]") as string[]
    )
    expect(permissionModes).toContain("workspace-write")
    // End-state oracle: after the Codex approval journey, the visible trigger
    // must advertise a Codex mode. History may still include transient Claxedo
    // ids from the pi-workspace placeholder before hydration; the settled control
    // is the user-visible contract this scenario owns.
    const settledMode = page.locator('[data-action="prompt-permission-mode"]').filter({ visible: true }).last()
    await expect(settledMode).toHaveAttribute("data-mode", "workspace-write")
    await expect(settledMode).not.toHaveAttribute("data-mode", CLAXEDO_ALLOW_SAFE_ID)
    await expect(settledMode).not.toHaveAttribute("data-mode", CLAXEDO_ASK_ALWAYS_ID)
  })

  test("codex native SDK runs a provider-issued spawn_agent call as an openable subagent", async ({ page }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to exercise its native collaboration tool.")
    const dir = await makeWorkspace("codex-sdk-subagent", "codex")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "codex-sdk",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex",
      tool: {
        name: "spawn_agent",
        input: {
          task_name: "demo_child",
          message: "Reply with exactly CHILD-CODEX-NATIVE",
        },
      },
      openable: true,
      permissionMode: "full-access",
      effort: "Ultra",
    })
  })

  test("cursor harness materializes without silently routing through another provider — behavior 7", async ({
    page,
  }) => {
    // Cursor cannot be redirected at the scripted endpoint (proprietary API, no
    // base-URL knob — see HARNESS NOTES), so this scenario runs no turn. What it
    // proves is the invariant-4 half that a scripted turn could never prove
    // anyway: selecting Cursor either locks in as itself or reports itself
    // unavailable, and in NEITHER case does anything leak onto a provider this
    // spec pointed elsewhere.
    await runCursorHarnessBoundary(page)
  })

  test("cursor native Goal reports exact SDK unavailability for slash and + without dispatching", async ({ page }) => {
    for (const entry of ["slash", "add-menu"] as const) {
      await runCursorGoalUnavailableJourney(page, entry)
    }
  })

  test("cross-harness subagents demo records every supported agent in one journey", async ({ page }, testInfo) => {
    test.skip(process.env.CLAXEDO_E2E_RECORD_DEMO !== "1", "Recording-only cohesive every-harness demo journey")
    testInfo.setTimeout(900_000)

    requireBinary(
      await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN"),
      "claude",
      "install the Claude CLI to record native and ACP subagents.",
    )
    requireBinary(
      await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN"),
      "codex",
      "install the Codex CLI to record native and ACP subagents.",
    )

    await runWorkspaceSubagentJourney(page, "demo-claude", "claude", {
      id: "claude",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude",
      tool: {
        name: "Agent",
        input: {
          description: "Verify child delegation",
          prompt: "Reply with exactly CHILD-CLAUDE-NATIVE",
          subagent_type: "general-purpose",
          run_in_background: false,
        },
      },
      openable: true,
      permissionMode: "bypassPermissions",
    })
    const piDir = await makeWorkspace("demo-pi", "pi")
    await seedOneProject(page, piDir)
    const pi = await createPiSession(piDir)
    await runRealSubagentJourney(page, piDir, {
      id: "pi",
      dialect: "responses",
      sessionID: pi.session.id,
      workspaceID: pi.workspaceId,
      central: true,
      tool: {
        name: "subagent",
        input: {
          task: "Reply with exactly CHILD-PI",
          title: "Verify Pi child delegation",
          background: false,
        },
      },
      openable: true,
    })

    await runWorkspaceSubagentJourney(page, "demo-codex-sdk", "codex", {
      id: "codex-sdk",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex",
      tool: {
        name: "spawn_agent",
        input: {
          task_name: "demo_child",
          message: "Reply with exactly CHILD-CODEX-NATIVE",
        },
      },
      openable: true,
      permissionMode: "full-access",
      effort: "Ultra",
    })
    await runCursorHarnessBoundary(page)
  })
})
