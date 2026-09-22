/**
 * Real native harnesses use an isolated server and scripted model HTTP only.
 * Offline browser tests keep the server and tool process online; filesystem
 * completion and canonical messages establish what happened during the outage.
 * A server-interrupted turn must expose a tool error; only its recovery send
 * can produce a completed assistant reply for the shared reply oracle.
 */
import { expectSessionRenamePersistence } from "../helpers/session-rename"
import { expectSessionReadRecovery } from "../helpers/session-read-recovery"
import { expectUnsupportedFork } from "../helpers/unsupported-fork"
import { expectRunningChildCleanup } from "../helpers/running-child-cleanup"
import { deletePendingQuestion } from "../helpers/question-deletion"
import { expectToolErrorRecovery } from "../helpers/tool-error-recovery"
import { expectConcurrentQuestionIsolation } from "../helpers/question-isolation"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { expectPermissionReplyIsolation } from "../helpers/permission-isolation"
import { cancelPendingPermission } from "../helpers/permission-cancellation"
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
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount, observeStreamingReply, expectStreamingSegmentsOnce, observeRuntimeTextTraffic } from "../helpers/turn-oracle-extras"
import { expectRailRowVisible, expectRailStatus, expectRailStatusAbsent, expectRailTitleSettled, readRailSessionOrder } from "../helpers/rail-oracle"
import { readPaintGeometry } from "../helpers/geometry-oracle"
import { startNetworkProxy } from "../helpers/network-proxy"

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
 * A missing binary is a contributor's ordinary local reality (visible skip) but a broken CI
 * job (loud GATING throw), because the lane installs both CLIs itself. Neither path is silent.
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

async function seedProjects(page: Page, dirs: string[]) {
  await page.addInitScript((seeded: string[]) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: seeded[0],
    }
    // Init scripts run on every navigation. Seed only the fresh browser context;
    // reload must retain the app's actual project, model and terminal state.
    if (localStorage.getItem("claxedo.global.dat:server")) return
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: seeded.map((worktree) => ({ worktree, expanded: true })) },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dirs)
}

async function seedOneProject(page: Page, dir: string) {
  await seedProjects(page, [dir])
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
 * Selects a harness on a draft composer and proves the selection landed before returning.
 *
 * The composer has one combined picker, and every harness this lane drives has a built-in row
 * in it: the picker's ACP group is discovery-driven over the operator's configured
 * connections, and this lane configures none.
 *
 * The selected row is the oracle, not a non-empty model label — the previous harness's model
 * can still be showing while the asynchronous switch is pending.
 */
function harnessPickerTarget(harnessKey: string) {
  if (harnessKey.startsWith("claude")) return { label: /^Claude Code$/, index: 0 }
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
 * 45s, not 30s: `claude` resolves its catalog through `ClaudeDriver.fetchModels`, a probe
 * query whose own `MODEL_LIST_TIMEOUT_MS` is exactly 30_000 before it falls back to the static
 * catalog. Waiting 30s for a control whose worst case is 30s races the fallback instead of
 * checking it. The wait polls the control's real text and never sleeps.
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
  await dock.locator('[data-slot="session-goal-toggle"]').click()
  await expect(dock).toHaveAttribute("data-expanded", "true")
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
 * The load-bearing half is the lower bound: at least one scripted call per turn on the
 * scenario's own dialect. Zero there means the reply on screen came from a provider this file
 * never pointed at — the false green this tier exists to catch, and one a correct-looking set
 * of reply markers cannot rule out on its own.
 *
 * The upper bound is deliberately loose, because "one HTTP call per turn" is not a contract:
 * the engine adds a title call per session, and the claude CLI issues two messages calls for a
 * single one-token turn. A tight ceiling would pin the harnesses' internal chattiness, which
 * is theirs to change, so it only catches a runaway loop and the cross-dialect check below is
 * what pins routing.
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
 * A session the user just started must be findable and legible in the sidebar while it runs,
 * without a reload. Both signals cross a seam only a real server exercises. The working dot
 * needs the runtime's `agent.lifecycle` frames to reach the chat row's status source rather
 * than the terminal status map — for a native-SDK harness the server sets `tabId` to the
 * session id and no `terminalId`, and `agent-status-listener` computes `terminalId || tabId`.
 * The real title needs `session.updated` bridged out of workspace-runtime when the server
 * replaces the "New Session" placeholder as the turn completes; unbridged, the rail keeps the
 * placeholder, in the wrong sort position, until an unrelated refetch lands.
 *
 * Asserted on the shared `[data-sidebar-status]` contract and the row's own title slot, so a
 * fix is free to route the signal any way it likes.
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
  await expect(dialog.getByRole("button", { name: "Usage limits" })).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.getByRole("heading", { name: "Quota windows" })).toBeVisible()
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
        // The rail is the surface the user navigates by, and this is the only lane running a
        // real harness against a real claxedo-server: the mocked tier injects events straight
        // onto the bus and cannot see this seam.
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
  await expectAssistantReplyVisible(page, new RegExp(markers[TURNS - 1]), {
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

  // Asserted last so a reload-time re-fetch cannot inflate the count.
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
    const chipRow = page.locator('[data-component="subagent-chip-row"]').last()
    const chip = chipRow.locator('[data-component="subagent-chip"]').last()
    await expect(chip, `${harness.id} never rendered its native delegation as a subagent chip`).toBeVisible({
      timeout: 60_000,
    })
    await expect(chip.locator('[data-slot="subagent-chip-status"]')).toHaveText(/working|done/, { timeout: 30_000 })
    await demoBeat(page)
    await expect(chip).toHaveAttribute("data-status", "completed", { timeout: 90_000 })
    await expect(chip.locator('[data-slot="subagent-chip-status"]')).toHaveText("done")
    await expect(page.locator(SELECTORS.userMessageContent).filter({ hasText: marker })).toBeVisible()
    await demoBeat(page)

    const openControl = chipRow.locator('button[data-component="subagent-chip"]').last()
    if (!harness.openable) {
      await expect(chip).toHaveAttribute("aria-label", /, transcript unavailable$/)
      await expect(openControl).toHaveCount(0)
    } else {
      await expect(openControl, `${harness.id} completed without an openable child transcript`).toHaveCount(1)
      await openControl.click()
      const tab = page.locator('[data-slot="workspace-tab"][data-workspace-tab-kind="subagent"]')
      await expect(tab).toHaveCount(1, { timeout: 30_000 })
      await expect(tab).toHaveAttribute("data-selected", "true")
      const childSessionId = (await tab.getAttribute("data-workspace-tab-id"))!.replace(/^subagent:/, "")
      const panel = page.locator('[data-testid="workspace-panel-body"]:not([data-panel-body-inert="true"])')
      await expect(panel.locator(`[data-session-timeline-session-id="${childSessionId}"]`)).toBeVisible({
        timeout: 30_000,
      })
      // The docked child is read-only: it builds no composer, so the page's only
      // submit control stays the parent pane's.
      await expect(panel.locator(SELECTORS.submitControl)).toHaveCount(0)
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

  const notice = page.getByRole("alert").filter({ hasText: /Couldn't load Cursor models|Cursor is not set up/ })
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
    await expect(notice).toHaveAttribute("data-tone", /critical|warning/)
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

  const notice = page.getByRole("alert").filter({ hasText: /Couldn't load Cursor models|Cursor is not set up/ })
  await expect(notice).toBeVisible({ timeout: 30_000 })
  await expect(notice.locator("[data-action='composer-notice-action']")).toBeVisible()
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
    providerID: "pi",
    modelID: "openai/gpt-4",
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
    `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}`,
    { method: "POST" },
  )
  if (!workspaceResponse.ok)
    throw new Error(`GATING: failed to resolve Pi workspace: ${await workspaceResponse.text()}`)
  const workspace = (await workspaceResponse.json()) as { workspaceId: string }
  const response = await fetch(`${BACKEND_URL}/api/control/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Pi subagent showcase",
      harness: "pi",
      workspaceId: workspace.workspaceId,
      model: { providerID: "pi", modelID: "openai/gpt-4" },
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
      body: JSON.stringify({ messageID, model: { providerID: "pi", modelID: "openai/gpt-4" }, parts: [{ type: "text", text: prompt }] }),
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
      "Unset -> loud, visible skip, never a silent no-op.",
  )

  test.beforeAll(async () => {
    const testInfo = test.info()
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

  test.beforeEach(async () => {
    const testInfo = test.info()
    // The scripted endpoint answers instantly, but subprocess spawn plus the
    // ACP handshake still costs real seconds on each scenario's first turn.
    testInfo.setTimeout(240_000)
  })

  test.afterEach(async ({ page }) => {
    const testInfo = test.info()
    // The server's stdout/stderr is buffered into `serverLog` and otherwise
    // surfaced only on GATING boot failures. On a FAILED test it is the only
    // record of what the engine actually did (or refused to do) on a CI
    // runner nobody can shell into — the first tier-real CI red burned a full
    // round because the picker said "No model results" and nothing said why.
    if (testInfo.status !== testInfo.expectedStatus && server) {
      await testInfo.attach("claxedo-server.log", { body: server.log(), contentType: "text/plain" })
      const sessionID = /(?:\/s\/|\/session\/)([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
      if (sessionID) {
        const directory = await page.evaluate(() => (window as typeof window & { __CLAXEDO__?: { activeDirectory?: string } }).__CLAXEDO__?.activeDirectory)
        const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(directory ?? "")}`)
        await testInfo.attach("stored-session-messages.json", { body: await response.text(), contentType: "application/json" })
      }
    }
    if (testInfo.status !== testInfo.expectedStatus && scripted) {
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

  test("pi-workspace harness completes exact turns, reload, and visible usage", async ({ page }) => {
    test.fixme(true, "Pi first send fails because the newly created native session file is missing")
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

  // The two streams, on the real daemon: a turn's frames ride the host
  // aggregate — `/api/wr/events` naming no workspace — and nothing
  // session-shaped rides the control plane's `/api/cp/events`. The reply's
  // parts are asserted on the wire itself, and only on chunks that arrived on
  // the parameter-less connection, so neither a transcript that advanced
  // through a history refetch nor a frame carried by some other stream can
  // pass.
  test("a turn's frames ride wr/events; cp/events carries no session frame", async ({ page }, testInfo) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install Claude to exercise a native turn over the two streams.")
    const dir = await makeWorkspace("two-streams", "claude")
    await seedOneProject(page, dir)

    // A live SSE body never resolves for Playwright's `response.text()`; the
    // in-page reader records each chunk as it lands.
    const traffic = await observeRuntimeTextTraffic(page)
    const workspaceOpens: Array<{ cursor: string | null; search: string }> = []
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.pathname !== "/api/wr/events") return
      workspaceOpens.push({
        cursor: response.request().headers()["last-event-id"] ?? null,
        search: url.search,
      })
    })
    const controlPlaneFrames: string[] = []
    const controlPlaneSockets: string[] = []
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/api/cp/events")) return
      controlPlaneSockets.push(socket.url())
      socket.on("framereceived", (frame) => { controlPlaneFrames.push(String(frame.payload)) })
    })

    await openDraftPrompt(page, dir)
    await switchDraftHarness(page, "claude")
    await waitForHarnessReady(page)
    const marker = `TWO_STREAMS_${Date.now()}`
    scripted!.scriptText({ marker, text: marker })
    await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token and nothing else: ${marker}`)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expectAssistantReplyVisible(page, marker)

    const frameTypes = (frames: string[]) =>
      frames.flatMap((text) => [...text.matchAll(/"type":"([a-z.-]+)"/g)].map((match) => match[1]))
    const counts = (types: string[]) =>
      types.reduce<Record<string, number>>((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {})

    // Exactly one kind of workspace stream is open here: the host aggregate,
    // which names no workspace at all — no `directory`, no `workspaceId`, no
    // `sessionID`.
    expect(workspaceOpens.length).toBeGreaterThan(0)
    expect(workspaceOpens.map((open) => open.search).filter((search) => search !== "")).toEqual([])
    // The frames of the turn, on the wire, counted only where they landed: the
    // aggregate's connection. The row, its parts and the settlement.
    const workspaceFrames = async () =>
      (await traffic()).filter((chunk) => new URL(chunk.url).search === "").map((chunk) => chunk.data)
    await expect.poll(async () => counts(frameTypes(await workspaceFrames()))["session.idle"] ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
    const workspaceCounts = counts(frameTypes(await workspaceFrames()))
    expect(workspaceCounts["message.updated"] ?? 0).toBeGreaterThan(0)
    expect(workspaceCounts["message.part.updated"] ?? 0).toBeGreaterThan(0)
    const streamedText = (await workspaceFrames()).join("").split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { payload?: { type: string; properties?: { field?: string; delta?: string } } })
      .filter((frame) => frame.payload?.type === "message.part.delta" && frame.payload.properties?.field === "text")
      .map((frame) => frame.payload!.properties!.delta).join("")
    expect(streamedText, "the reply's text reaches the browser as text deltas on the workspace stream").toContain(marker)

    // The control plane's stream is open, and carries nothing of the session.
    expect(controlPlaneSockets.length).toBeGreaterThan(0)
    const controlPlaneCounts = counts(frameTypes(controlPlaneFrames))
    for (const type of Object.keys(controlPlaneCounts)) {
      expect(type, `a session frame on cp/events: ${type}`).not.toMatch(/^(message|permission|question|todo|subagent|goal)\./)
      // The control plane's own session notices — a share, an inventory
      // change — name a workspace or a session id, never a session's content.
      expect(type, `a session frame on cp/events: ${type}`).not.toMatch(/^session\.(?!share\.changed$|inventory\.changed$)/)
    }
    // One session was created; its turn's deltas, retitle and settlement ring
    // the inventory notice for no other reason.
    expect(controlPlaneCounts["session.inventory.changed"]).toBe(1)

    await testInfo.attach("stream-frame-counts.json", {
      body: JSON.stringify({ workspaceOpens, workspace: workspaceCounts, controlPlane: controlPlaneCounts }, null, 2),
      contentType: "application/json",
    })
  })

  test("a session created elsewhere reaches the rail of a route with no workspace", async ({ page }) => {
    const dir = await makeWorkspace("inventory-notice", "claude")
    await seedOneProject(page, dir)
    const notices: string[] = []
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/api/cp/events")) return
      socket.on("framereceived", (frame) => { notices.push(String(frame.payload)) })
    })
    const workspaceOpens: Array<{ at: number; search: string }> = []
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.pathname === "/api/wr/events") workspaceOpens.push({ at: Date.now(), search: url.search })
    })
    // The Tasks route names no workspace. The host aggregate is open there
    // regardless — it is the daemon's, not a workspace's — and only what opens
    // once that route is the document counts.
    const tasksRouteAt = Date.now()
    await page.goto("/tasks")
    await expect(page).toHaveURL(/\/tasks$/)
    await expect.poll(() => notices.some((frame) => frame.includes('"type":"heartbeat"')), { message: "cp/events is open on the Tasks route", timeout: 30_000 }).toBe(true)
    const created = await createHarnessSession(dir, { title: "Created from the CLI", harness: "claude", providerID: "anthropic", modelID: "claude-sonnet-4-5" })
    await expectRailRowVisible({ page, sessionId: created.id, timeout: 30_000 })
    await expect.poll(() => notices.some((frame) => frame.includes('"type":"session.inventory.changed"')), { timeout: 15_000 }).toBe(true)
    expect(
      workspaceOpens.filter((open) => open.at >= tasksRouteAt).map((open) => open.search).filter((search) => search !== ""),
      "a route that names no workspace opens no workspace-scoped stream",
    ).toEqual([])
  })

  // The reason the aggregate exists: before it, a local workspace off screen
  // went quiet, and its rail indicator only caught up on a switch.
  test("an agent finishing in a workspace not on screen updates that workspace's rail indicator without a switch", async ({ page }, testInfo) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install Claude to run a turn in a workspace that is not on screen.")
    const routed = await makeWorkspace("aggregate-routed")
    const offscreen = await makeWorkspace("aggregate-offscreen", "claude")
    await seedProjects(page, [routed, offscreen])

    // The query of every `wr/events` connection this page opens. A local
    // workspace gets no stream of its own, so an off-screen turn can only
    // reach the rail through the parameter-less aggregate. Its frames are
    // read off the wire too: a rail that never moves is a different failure
    // from frames that never arrived.
    const streamOpens: string[] = []
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.pathname === "/api/wr/events") streamOpens.push(url.search)
    })
    const traffic = await observeRuntimeTextTraffic(page)

    const session = await createHarnessSession(offscreen, {
      title: "Off-screen turn",
      harness: "claude",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })

    await openDraftPrompt(page, routed)
    const routedUrl = page.url()

    const marker = `OFFSCREEN_${Date.now()}`
    scripted!.scriptText({ marker, text: marker })
    const releaseReply = scripted!.holdTextReplies(marker)
    try {
      await expectRailStatus({
        page,
        sessionId: session.id,
        timeout: 60_000,
        driveWorking: async () => {
          const response = await page.request.post(
            `${BACKEND_URL}/session/${session.id}/prompt_async?directory=${encodeURIComponent(offscreen)}`,
            { data: { parts: [{ type: "text", text: `Reply with exactly this one token and nothing else: ${marker}` }] } },
          )
          expect(response.ok(), await response.text()).toBe(true)
        },
        driveDone: () => releaseReply(),
      })
    } finally {
      releaseReply()
      await testInfo.attach("wr-events.json", {
        body: JSON.stringify({ routedUrl, streamOpens, frames: await traffic() }, null, 2),
        contentType: "application/json",
      })
    }

    expect(page.url(), "the routed workspace never left the screen").toBe(routedUrl)

    // What the aggregate itself carried. The rail dot alone does not pin it:
    // the daemon also answers `/session/status?directory=` for a workspace
    // that is not routed, and that poll moves the same dot. The frames below
    // arrived on the parameter-less connection and nowhere else.
    const offscreenFrames = (await traffic())
      .filter((chunk) => new URL(chunk.url).search === "")
      .flatMap((chunk) => chunk.data.split("\n"))
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as {
        directory?: string
        payload?: { type?: string; properties?: { sessionID?: string } }
      })
      .filter((frame) => frame.payload?.properties?.sessionID === session.id)
    expect(
      offscreenFrames.map((frame) => frame.payload?.type),
      "the off-screen turn rode the host aggregate, from busy to settled",
    ).toEqual(expect.arrayContaining(["session.status", "session.idle"]))
    // The daemon stamps its own filesystem path, which resolves through
    // /private on macOS, so the tail is what identifies the workspace.
    expect(
      [...new Set(offscreenFrames.map((frame) => frame.directory?.endsWith(path.basename(offscreen))))],
      "those frames are addressed to the workspace that was never on screen",
    ).toEqual([true])

    expect(streamOpens.length, "the host aggregate is open").toBeGreaterThan(0)
    expect(
      streamOpens.filter((search) => search !== ""),
      "no workspace-scoped stream is opened for a local workspace",
    ).toEqual([])
  })

  test("local new-worktree session receives its first reply", async ({ page }) => {
    test.fixme(true, "The scripted Pi double cannot reach Pi in a local workspace; e2e/e2e-decisions.md #81")
    scripted?.resetCounts()
    const dir = await makeWorkspace("new-local-worktree")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await selectScriptedModel(page)

    const environment = page.locator('[data-slot="context-chip-environment"]')
    await environment.click()
    const environmentPicker = page.locator('[data-context-chip-picker="context-chip-environment"]')
    await expect(environmentPicker).toBeVisible()
    await environmentPicker.getByRole("button", { name: /^This computer/ }).click()
    await expect(environment.locator('[data-slot="context-chip-label"]')).toHaveText("This computer")

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

  test("timeline turn picker previews one seeded turn and appears only after 10", async ({
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

    await page.goto(`/s/${session.id}#message-${turns[0].messageID}`, { waitUntil: "domcontentloaded" })
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
      await expect(preview.locator('[data-slot="message-nav-preview-user"]')).toContainText(turns[index].prompt)
      await expect(preview.locator('[data-slot="message-nav-preview-assistant"]')).toContainText(turns[index].marker)
      return preview
    }

    await ticks.nth(1).focus()
    const focusedPreview = page.locator('[data-slot="message-nav-turn-preview"]:visible')
    await expect(focusedPreview.locator('[data-slot="message-nav-preview-user"]')).toContainText(turns[1].prompt)
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
          style.backgroundColor === styles[4].backgroundColor && style.height === styles[4].height ? [index] : [],
        )
      }),
    ).toEqual([4])
    await demoBeat(page)
    await ticks.nth(4).click()
    await expect(
      page.locator(SELECTORS.userMessageContent).filter({ hasText: turns[4].prompt }).last(),
      "clicked turn did not scroll into the timeline viewport",
    ).toBeInViewport()
    await demoBeat(page)
  })

  test("claude native SDK harness completes exact turns, reload, and visible usage", async ({
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
      option: /^Claude Code$/,
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
        // Claude does not expose resume. Delete clears its native hook through
        // the resource's stop-before-delete path, then removes the objective.
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
          const sessionId = /(?:\/s\/|\/session\/)([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
          expect(sessionId).toBeTruthy()
          await expect.poll(async () => {
            const response = await page.request.get(`${BACKEND_URL}/session/${sessionId}/goal/state`, {
              params: { directory: dir },
            })
            expect(response.ok()).toBe(true)
            return (await response.json()).goal
          }, { timeout: 30_000, message: "completed Claude Goal must clear the authoritative session state" }).toBeNull()
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

  for (const harness of ["claude", "codex"] as const) {
    for (const presentation of ["navigation", "windows"] as const) {
      test(`${harness} concurrent native questions (${presentation}) remain isolated across workspaces`, async ({ page }) => {
        const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
        requireBinary(binary, harness, "install the CLI to exercise concurrent questions.")
        scripted!.resetCounts()
        await expectConcurrentQuestionIsolation(page, {
          backendUrl: BACKEND_URL,
          presentation,
          startQuestion: async (target, index) => {
            const directory = await makeWorkspace(`${harness}-question-isolation-${index}`, harness)
            if (index === 0 || presentation === "windows") await seedOneProject(target, directory)
            const input = await openDraftPrompt(target, directory)
            await switchDraftHarness(target, harness)
            await waitForHarnessReady(target)
            const marker = `ISOLATED-${index}-${Date.now()}`
            scripted!.scriptTool({
              name: harness === "claude" ? "AskUserQuestion" : "request_user_input",
              input: { questions: [{ id: "environment", header: "Environment", question: "Which environment?", options: [
                { label: "Staging", description: "Isolated environment" },
                { label: "Production", description: "Production environment" },
              ], ...(harness === "claude" ? { multiSelect: false } : {}) }] },
              whenPromptIncludes: marker,
            })
            await composePrompt(target, input, `Ask which environment to use, then reply with exactly this one token: ${marker}`)
            await target.locator(SELECTORS.submitControl).last().click()
            return { directory, answerMarker: marker, dismissMarker: marker }
          },
        })
      })
    }
  }

  for (const harness of ["claude", "codex"] as const) {
    test(`${harness} native unsupported fork leaves history unchanged`, async ({ page }) => {
      const dir = await makeWorkspace(`unsupported-fork-${harness}`, harness)
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      const marker = `FORK-SOURCE-${Date.now()}`
      await composePrompt(page, input, `Reply with exactly this one token: ${marker}. Do not use tools.`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, marker)
      await page.reload()
      await expectAssistantReplyVisible(page, marker)
      const sessionId = new URL(page.url()).pathname.split("/").at(-1)!
      await expectUnsupportedFork(page, { backendUrl: BACKEND_URL, directory: dir, sessionId })
      await page.reload()
      await expectAssistantReplyVisible(page, marker)
      await page.screenshot({ path: test.info().outputPath("fork-unavailable-history-preserved.png") })
    })
  }

  for (const harness of ["claude", "codex"] as const) {
    test(`${harness} native session rename preserves history and harness across server restart`, async ({ page }) => {
      const dir = await makeWorkspace(`session-rename-${harness}`, harness)
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      const marker = `RENAME-SOURCE-${Date.now()}`
      await composePrompt(page, input, `Reply with exactly this one token: ${marker}. Do not use tools.`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, marker)
      await page.reload()
      await expectAssistantReplyVisible(page, marker)
      const sessionId = new URL(page.url()).pathname.split("/").at(-1)!
      await expectSessionRenamePersistence(page, {
        backendUrl: BACKEND_URL, directory: dir, sessionId,
        restartServer: async () => { await server!.restart() },
      })
      await expectSessionReadRecovery(page, { backendUrl: BACKEND_URL, directory: dir, sessionId })
      await expectAssistantReplyVisible(page, marker)
      const followup = `RENAME-FOLLOWUP-${Date.now()}`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${followup}. Do not use tools.`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, followup)
      await page.reload()
      await expectAssistantReplyVisible(page, marker)
      await expectAssistantReplyVisible(page, followup)
      await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText("Renamed café 日本語 🚀")
      expect(new URL(page.url()).pathname.split("/").at(-1)).toBe(sessionId)
      await page.screenshot({ path: test.info().outputPath("session-renamed-after-restart.png") })
    })
  }

  for (const [parentHarness, childHarness] of [["claude", "codex"], ["codex", "claude"]] as const) {
    for (const action of ["Archive", "Delete"] as const) {
      test(`${action} ${parentHarness} parent stops its running ${childHarness} child`, async ({ page }) => {
        const dir = await makeWorkspace(`child-cleanup-${parentHarness}-${action}`, parentHarness)
        await seedOneProject(page, dir)
        await expectRunningChildCleanup(page, {
          backendUrl: BACKEND_URL, directory: dir, parentHarness, childHarness, action,
          startChild: async (sessionId, command, marker) => {
            scripted!.scriptTool({
              name: childHarness === "claude" ? "Bash" : "exec_command",
              input: childHarness === "claude" ? { command, timeout: 120000 } : { cmd: command, yield_time_ms: 30000 },
              whenPromptIncludes: marker,
            })
            const response = await page.request.post(`${BACKEND_URL}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(dir)}`, {
              data: { parts: [{ type: "text", text: `Run the command, then reply with exactly this one token: ${marker}` }] },
            })
            expect(response.ok(), await response.text()).toBe(true)
          },
        })
        await page.screenshot({ path: test.info().outputPath("child-cleanup.png") })
      })
    }
  }

  test("Codex sends converge on the same session order in both browser tabs", async ({ page, context }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to exercise cross-tab session updates.")
    const dir = await makeWorkspace("codex-rail-sync", "codex")
    await seedOneProject(page, dir)
    const visits: Array<{ id: string; url: string; reply: string }> = []
    for (const name of ["OLDER", "NEWER"]) {
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, "codex")
      await waitForHarnessReady(page)
      const reply = `RAIL-${name}-${Date.now()}`
      await composePrompt(page, input, `Reply with exactly this one token: ${reply}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, reply)
      visits.push({ id: new URL(page.url()).pathname.split("/").at(-1)!, url: page.url(), reply })
    }
    const [older, newer] = visits
    await (await expectRailRowVisible({ page, sessionId: older.id })).click()
    await expectAssistantReplyVisible(page, older.reply)
    const receiver = await context.newPage()
    try {
      await seedOneProject(receiver, dir)
      await receiver.goto(older.url)
      await expectAssistantReplyVisible(receiver, older.reply)
      await expectRailRowVisible({ page: receiver, sessionId: newer.id })
      const before = { sender: await readRailSessionOrder(page), receiver: await readRailSessionOrder(receiver) }
      const reply = `RAIL-SYNC-${Date.now()}`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${reply}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, reply)
      await expectAssistantReplyVisible(receiver, reply)
      await page.screenshot({ path: test.info().outputPath("rail-sender.png") })
      await receiver.screenshot({ path: test.info().outputPath("rail-receiver.png") })
      const after = { sender: await readRailSessionOrder(page), receiver: await readRailSessionOrder(receiver) }
      await fs.writeFile(test.info().outputPath("rail-orders.json"), JSON.stringify({ visits, before, after }, null, 2))
      await expectRailRowVisible({ page, sessionId: older.id, index: 0 })
      await expectRailRowVisible({ page: receiver, sessionId: older.id, index: 0 })
      expect(await readRailSessionOrder(receiver)).toEqual(await readRailSessionOrder(page))
    } finally {
      await receiver.close()
    }
  })

  for (const [action, goalMode] of [["answer", false], ["answer-retained", false], ["multiple", false], ["custom", false], ["dismiss", false], ["stop", false], ["stop", true], ["delete", false], ["delete-response-lost", false]] as const) {
    test(action === "answer-retained" ? "codex native question retains the selected answer card after completion and reload" : `codex native structured question ${action} reaches the question dock${goalMode ? " in Goal mode" : ""}`, async ({ page }) => {
      test.fixme(action === "answer-retained", "Codex delivers the selected answer but retains no resolved question card after reload")
      const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
      requireBinary(binary, "codex", "install the Codex CLI to exercise its structured question tool.")
      const dir = await makeWorkspace("codex-question", "codex")
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, "codex")
      await waitForHarnessReady(page)
      const marker = `CODEX-QUESTION-${Date.now()}`
      scripted!.resetCounts()
      scripted!.scriptTool({
        name: "request_user_input",
        input: { questions: [{ id: "environment", header: "Environment", question: "Which environment?", options: [
          { label: "Staging", description: "Isolated environment" },
          { label: "Production", description: "Production environment" },
        ] }, ...(action === "multiple" ? [{ id: "checks", header: "Checks", question: "Which checks should run?", options: [
          { label: "Unit", description: "Fast checks" }, { label: "Browser", description: "Real UI checks" },
        ] }] : [])] },
        whenPromptIncludes: marker,
      })
      const toolResults = () => scripted!.requests.flatMap(({ body }) =>
        "input" in body && Array.isArray(body.input) ? body.input.filter((item) => item.type === "function_call_output") : [])
      try {
        await composePrompt(page, input, `${goalMode ? "/goal " : ""}Ask which environment to use, then reply with exactly this one token: ${marker}`)
        await page.locator(SELECTORS.submitControl).last().click()
        const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
        await expect(dock).toBeVisible({ timeout: 20_000 })
        await expect(dock.locator('[data-slot="question-option"]', { hasText: "Staging" })).toContainText("Isolated environment")
        if (action === "delete" || action === "delete-response-lost") {
          const removedId = new URL(page.url()).pathname.split("/").at(-1)!
          await deletePendingQuestion(page, { backendUrl: BACKEND_URL, directory: dir, sessionId: removedId, interruptResponse: action === "delete-response-lost" })
          await openDraftPrompt(page, dir)
          await switchDraftHarness(page, "codex")
          await waitForHarnessReady(page)
          const followup = `AFTER-DELETE-${Date.now()}`
          await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${followup}`)
          await page.locator(SELECTORS.submitControl).last().click()
          await expectAssistantReplyVisible(page, followup)
          await page.reload({ waitUntil: "domcontentloaded" })
          await expectAssistantReplyVisible(page, followup)
          expect((await page.request.get(`${BACKEND_URL}/session/${removedId}?directory=${encodeURIComponent(dir)}`)).status()).toBe(404)
          return
        }
        if (action === "stop") {
          await page.reload({ waitUntil: "domcontentloaded" })
          await expect(dock).toBeVisible()
          await dock.getByRole("button", { name: "Stop", exact: true }).click()
          await expect(dock).toHaveCount(0)
          await page.reload({ waitUntil: "domcontentloaded" })
          await expect(dock).toHaveCount(0)
          if (goalMode) await expect(goalStatus(page.locator('[data-component="session-goal-dock"]'), "Paused")).toBeVisible()
          const followup = `FOLLOWUP-${Date.now()}`
          await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${followup}`)
          await page.locator(SELECTORS.submitControl).last().click()
          await expectAssistantReplyVisible(page, followup)
          return
        }
        if (action === "dismiss") {
          await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
        } else {
          if (action === "custom") {
            const option = dock.locator('[data-slot="question-option"][data-custom="true"]')
            await option.click()
            await dock.locator('[data-slot="question-custom-input"]').fill("Preview café 日本語")
            await dock.locator('[data-slot="question-custom-input"]').press("Enter")
            await page.reload({ waitUntil: "domcontentloaded" })
            await expect(option).toHaveAttribute("data-picked", "true")
            await expect(option).toContainText("Preview café 日本語")
          } else {
            await dock.locator('[data-slot="question-option"]', { hasText: "Staging" }).click()
          }
          if (action === "multiple") {
            await dock.getByRole("button", { name: "Next", exact: true }).click()
            await dock.locator('[data-slot="question-option"]', { hasText: "Unit" }).click()
            await page.reload({ waitUntil: "domcontentloaded" })
            await expect(dock).toContainText("Which checks should run?")
            await expect(dock.locator('[data-slot="question-option"]', { hasText: "Unit" })).toHaveAttribute("data-picked", "true")
            await dock.getByRole("button", { name: "Back", exact: true }).click()
            await expect(dock.locator('[data-slot="question-option"]', { hasText: "Staging" })).toHaveAttribute("data-picked", "true")
            await dock.getByRole("button", { name: "Next", exact: true }).click()
          }
          await dock.getByRole("button", { name: "Submit", exact: true }).click()
        }
        await expectAssistantReplyVisible(page, marker)
        expect(toolResults().length).toBeGreaterThan(0)
        if (action === "answer" || action === "answer-retained") expect(JSON.stringify(toolResults())).toContain("Staging")
        else if (action === "multiple") {
          expect(JSON.stringify(toolResults())).toContain("Staging")
          expect(JSON.stringify(toolResults())).toContain("Unit")
          expect(JSON.stringify(toolResults())).not.toContain("Browser")
        }
        else if (action === "custom") expect(JSON.stringify(toolResults())).toContain("Preview café 日本語")
        else expect(JSON.stringify(toolResults())).not.toContain("Staging")
        if (action === "answer-retained") {
          await fs.writeFile(test.info().outputPath("question-tool-results.json"), JSON.stringify(toolResults(), null, 2))
          await page.reload({ waitUntil: "domcontentloaded" })
          await expectAssistantReplyVisible(page, marker)
          await page.screenshot({ path: test.info().outputPath("answered-question-after-reload.png") })
          const card = page.locator('[data-component="question-card"]').filter({ hasText: "Which environment?" })
          await expect(card, "answered question retains its result card").toBeVisible({ timeout: 10_000 })
          await expect(card.locator('[data-slot="answer-text"]')).toHaveText("Staging")
          await expect(dock).toHaveCount(0)
        }
      } finally {
        await test.info().attach("codex-question-tool-contract.json", {
          contentType: "application/json",
          body: JSON.stringify({ tools: scripted!.requests.map(({ tools }) => tools.map((tool) => tool.name)), results: toolResults() }),
        })
      }
    })

  }


  for (const [action, goalMode] of [["answer", false], ["custom", false], ["dismiss", false], ["stop", false], ["stop", true], ["delete", false], ["delete-response-lost", false]] as const) {
    test(`claude native SDK provider-issued question: ${action} after reload${goalMode ? " in Goal mode" : ""}`, async ({ page }) => {
      const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
      requireBinary(binary, "claude", "install the Claude CLI to exercise its AskUserQuestion tool.")
      const dir = await makeWorkspace("claude-question", "claude")
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, "claude")
      await waitForHarnessReady(page)
      const marker = `CLAUDE-QUESTION-${Date.now()}`
      scripted!.resetCounts()
      scripted!.scriptTool({
        name: "AskUserQuestion",
        input: {
          questions: [{
            question: "Which environment should the test use?",
            header: "Environment",
            options: [
              { label: "Staging", description: "Use the isolated test environment." },
              { label: "Production", description: "Use the production environment." },
            ],
            multiSelect: false,
          }, {
            question: "Which checks should run?",
            header: "Checks",
            options: [
              { label: "Unit", description: "Run isolated checks." },
              { label: "Browser", description: "Exercise the UI." },
            ],
            multiSelect: true,
          }],
        },
        whenPromptIncludes: marker,
      })
      await composePrompt(page, input, `${goalMode ? "/goal " : ""}Ask which environment to use, then reply with exactly this one token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
      const sessionUrl = page.url()
      const dock = page.locator('[data-component="dock-prompt"][data-kind="question"]').filter({ visible: true })
      await expect(dock).toBeVisible({ timeout: 30_000 })
      await expect(dock).toContainText("Which environment should the test use?")
      await expect(dock).toContainText("Use the isolated test environment.")
      await page.screenshot({ path: test.info().outputPath("question-pending.png") })
      await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)
      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(dock).toBeVisible({ timeout: 30_000 })
      if (action === "delete" || action === "delete-response-lost") {
        const removedId = new URL(page.url()).pathname.split("/").at(-1)!
        await deletePendingQuestion(page, { backendUrl: BACKEND_URL, directory: dir, sessionId: removedId, interruptResponse: action === "delete-response-lost" })
        await openDraftPrompt(page, dir)
        await switchDraftHarness(page, "claude")
        await waitForHarnessReady(page)
        const followup = `AFTER-DELETE-${Date.now()}`
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${followup}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, followup)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, followup)
        expect((await page.request.get(`${BACKEND_URL}/session/${removedId}?directory=${encodeURIComponent(dir)}`)).status()).toBe(404)
        return
      }
      if (action === "dismiss" || action === "stop") {
        if (action === "dismiss") {
          await dock.getByRole("button", { name: "Dismiss", exact: true }).click()
          await expectAssistantReplyVisible(page, marker)
        } else {
          const stop = dock.getByRole("button", { name: "Stop", exact: true })
          await expect(stop).toBeVisible({ timeout: 10_000 })
          await stop.click()
        }
        await expect(dock).toHaveCount(0)
        if (goalMode) await expect(goalStatus(page.locator('[data-component="session-goal-dock"]'), "Paused")).toBeVisible()
        const followup = page.getByRole("textbox", { name: /Ask anything/i }).last()
        await expect(followup).toBeVisible()
        const nextMarker = `FOLLOWUP-${marker}`
        await composePrompt(page, followup, `Reply with exactly this one token: ${nextMarker}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, nextMarker)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(dock).toHaveCount(0)
        await expectAssistantReplyVisible(page, nextMarker)
        return
      }
      const environment = action === "custom" ? "Preview café 日本語" : "Staging"
      const environmentOption = action === "custom"
        ? dock.locator('[data-slot="question-option"][data-custom="true"]')
        : dock.locator('[data-slot="question-option"]', { hasText: "Staging" })
      await environmentOption.click()
      if (action === "custom") {
        const customInput = dock.locator('[data-slot="question-custom-input"]')
        await customInput.fill(environment)
        await customInput.press("Enter")
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(environmentOption).toHaveAttribute("data-picked", "true")
        await expect(environmentOption).toContainText(environment)
      }
      await dock.getByRole("button", { name: "Next", exact: true }).click()
      await expect(dock).toContainText("Which checks should run?")
      await expect(dock).toContainText("Select all answers that apply")
      await dock.locator('[data-slot="question-option"]', { hasText: "Unit" }).click()
      await dock.locator('[data-slot="question-option"]', { hasText: "Browser" }).click()
      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(dock).toContainText("Which checks should run?")
      await dock.getByRole("button", { name: "Back", exact: true }).click()
      await expect(environmentOption).toHaveAttribute("data-picked", "true")
      await dock.getByRole("button", { name: "Next", exact: true }).click()
      await expect(dock.locator('[data-slot="question-option"]', { hasText: "Unit" })).toHaveAttribute("data-picked", "true")
      await expect(dock.locator('[data-slot="question-option"]', { hasText: "Browser" })).toHaveAttribute("data-picked", "true")
      await page.screenshot({ path: test.info().outputPath("question-answered.png") })
      await dock.getByRole("button", { name: "Submit", exact: true }).click()
      await expect(dock).toHaveCount(0)
      await expectAssistantReplyVisible(page, marker)
      await expect(page).toHaveURL(sessionUrl)
      const results = scripted!.requests.flatMap((request) => {
        if (request.dialect !== "messages" || !("messages" in request.body)) return []
        return request.body.messages.flatMap((message) => Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "tool_result")
          : [])
      })
      expect(JSON.stringify(results)).toContain(environment)
      expect(JSON.stringify(results)).toContain("Unit, Browser")
    })
  }

  test("claude native SDK runs a provider-issued Agent call as an openable subagent", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the Claude CLI to exercise its native Agent tool.")
    const dir = await makeWorkspace("claude-subagent", "claude")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "claude",
      dialect: "messages",
      option: /^Claude Code$/,
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
    const advertisedTools = scripted!.requests[0].tools.map((tool) => tool.name)
    expect(advertisedTools).toContain("bash")
    expect(advertisedTools).not.toContain("subagent")
    expect(scripted!.requests.filter((request) => request.reply.kind === "tool")).toHaveLength(1)
    expectScriptedTraffic("responses", 2)
  })

  test("Pi reports unsupported subagents and rejects an unadvertised delegation tool", async ({ page }) => {
    const dir = await makeWorkspace("pi-subagent", "pi")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await selectScriptedModel(page)
    scripted!.resetCounts()
    const marker = `PI-UNSUPPORTED-${Date.now()}`
    scripted!.scriptTool({
      name: "subagent", input: { task: "Do not execute", title: "Unsupported delegation", background: false }, whenPromptIncludes: marker,
    })
    await composePrompt(page, input, `Reply with exactly this one token: ${marker}`)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expectAssistantReplyVisible(page, marker)
    const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
    const capabilities = await page.request.get(`${BACKEND_URL}/session/${sessionID}/capabilities?directory=${encodeURIComponent(dir)}`)
    expect(capabilities.ok()).toBe(true)
    expect(await capabilities.json()).toMatchObject({ subagents: false })
    expect(scripted!.requests.flatMap((request) => request.tools.map((tool) => tool.name))).not.toContain("subagent")
    const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
    expect(response.ok()).toBe(true)
    const history = await response.json() as Array<{ parts: Array<{ type: string; tool?: string; state?: { status: string; error?: string } }> }>
    const tool = history.flatMap((message) => message.parts).find((part) => part.type === "tool" && part.tool === "subagent")
    expect(tool?.state).toMatchObject({ status: "error", error: expect.stringContaining("Tool subagent not found") })
    await expect(page.locator('[data-component="subagent-chip-row"]')).toHaveCount(0)
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

  test("codex native SDK harness completes exact turns, reload, and visible usage", async ({
    page,
  }) => {
    test.fixme(true, "Codex first send fails because no rollout exists for the newly created native thread")
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


  for (const established of [false, true]) {
    const harness = "claude"
    test(`Claude renders each text segment once while a ${established ? "follow-up" : "first"} native reply streams`, async ({ page }, testInfo) => {
      const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
      requireBinary(binary, harness, "install the native harness to exercise live text deltas.")
      const dir = await makeWorkspace(`${harness}-streamed-segments`, harness)
      const traffic = await observeRuntimeTextTraffic(page)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      const marker = `STREAM_SEGMENTS_${Date.now()}`
      const segments = Array.from({ length: 16 }, (_, index) => `SEGMENT_${String(index + 1).padStart(2, "0")}`)
      const reply = segments.map(segment => `**${segment}** appears once in this streamed paragraph.`).join("\n\n")
      const frames: Array<{ at: number; payload: string }> = []
      page.on("websocket", socket => {
        socket.on("framereceived", ({ payload }) => frames.push({ at: Date.now(), payload: payload.toString() }))
      })
      // Observe the existing connection too: registration must precede navigation.
      await page.reload({ waitUntil: "domcontentloaded" })
      await waitForHarnessReady(page)
      if (established) {
        const warmup = `ESTABLISHED_${Date.now()}`
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${warmup}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, warmup)
      }
      scripted!.scriptText({ marker, text: reply })
      scripted!.setTextStreamPacing({ chunks: 32, delayMs: 150 })
      const stop = await observeStreamingReply(page)
      let samples: Awaited<ReturnType<typeof stop>> = []
      try {
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Return the requested streamed paragraphs for ${marker}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expect.poll(async () => (await traffic()).some(chunk => chunk.data.includes('"type":"message.part.delta"')), {
          message: "native runtime text reaches the browser before completion", timeout: 30_000,
        }).toBe(true)
        const during = await traffic()
        await fs.writeFile(testInfo.outputPath("during-stream.json"), JSON.stringify(during, null, 2))
        expect(during.some(chunk => chunk.data.includes("SEGMENT_16")), "the screenshot observes an unfinished reply").toBe(false)
        await page.screenshot({ path: testInfo.outputPath("partial-reply.png") })
        await expectAssistantReplyVisible(page, segments.at(-1)!)
      } finally {
        scripted!.setTextStreamPacing(undefined)
        samples = await stop()
        await fs.writeFile(testInfo.outputPath("streamed-text-frames.json"), JSON.stringify(samples, null, 2))
        await fs.writeFile(testInfo.outputPath("streamed-wire-frames.json"), JSON.stringify(frames, null, 2))
        await fs.writeFile(testInfo.outputPath("runtime-text-traffic.json"), JSON.stringify(await traffic(), null, 2))
      }
      const received = (await traffic()).map(chunk => chunk.data).join("").split("\n")
        .filter(line => line.startsWith("data: "))
        .map(line => JSON.parse(line.slice(6)) as { payload?: { type: string; properties?: { field?: string; delta?: string } } })
        .filter(frame => frame.payload?.type === "message.part.delta" && frame.payload.properties?.field === "text")
        .map(frame => frame.payload!.properties!.delta).join("")
      expect(received, "the workspace stream delivers the full scripted reply as text deltas").toContain(reply)
      expectStreamingSegmentsOnce(samples, segments)
    })
  }

  const outageTest = test.extend<{ network: Awaited<ReturnType<typeof startNetworkProxy>> }>({
    network: async ({ baseURL }, use) => {
      const network = await startNetworkProxy(new URL(baseURL!))
      try { await use(network) } finally { await network.close() }
    },
    proxy: async ({ network }, use) => {
      await use({ server: network.url, bypass: "<-loopback>" })
    },
  })

  outageTest("Claude tool completion reconciles after the browser reconnects and reloads", async ({ page, network }, testInfo) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install Claude to exercise native tool completion through a browser outage.")
    const dir = await makeWorkspace("claude-offline-tool", "claude")
    const releaseFile = path.join(dir, "release-tool")
    const startedFile = path.join(dir, "tool-started")
    const completedFile = path.join(dir, "tool-completed")
    const marker = `OFFLINE_TOOL_DONE_${Date.now()}`
    const script = path.join(dir, "offline-tool.cjs")
    await fs.writeFile(script, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(startedFile)}, "started");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
  clearInterval(timer);
  fs.writeFileSync(${JSON.stringify(completedFile)}, ${JSON.stringify(marker)});
  console.log(${JSON.stringify(marker)});
}, 20);
setTimeout(() => process.exit(2), 60000).unref();
`)
    const sockets: Array<{ url: string; closed: boolean }> = []
    page.on("websocket", socket => {
      if (!socket.url().includes("/api/cp/events")) return
      const entry = { url: socket.url(), closed: false }
      sockets.push(entry)
      socket.on("close", () => { entry.closed = true })
    })
    // The workspace stream is what carries the tool's settlement: every open
    // with its resume cursor, and (through the in-page reader, since a live
    // SSE body never resolves for `response.text()`) the frames it delivered.
    const traffic = await observeRuntimeTextTraffic(page)
    // The outage would also cut Vite's HMR socket, and its client reloads the
    // page once a `vite-ping` socket opens again — a reload that drops the
    // cursor this test watches. A mocked HMR socket never disconnects.
    await page.routeWebSocket((url) => url.pathname === "/", () => undefined)
    const workspaceOpens: Array<{ at: number; cursor: string | null; scope: string | null; status: number }> = []
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.pathname !== "/api/wr/events") return
      workspaceOpens.push({ at: Date.now(), cursor: response.request().headers()["last-event-id"] ?? null, scope: url.searchParams.get("sessionID"), status: response.status() })
    })
    try {
      await seedOneProject(page, dir)
      await page.goto(`/${slug(dir)}/session`)
      await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible()
      await switchDraftHarness(page, "claude")
      await waitForHarnessReady(page)
      await page.locator('[data-action="prompt-permission-mode"]').last().click()
      await page.locator('[data-permission-mode-row][data-mode="bypassPermissions"]').click()
      scripted!.scriptTool({ name: "Bash", input: { command: `node '${script}'`, timeout: 120000 }, whenPromptIncludes: marker })
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Run the requested command, then reply with exactly this one token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => fs.readFile(startedFile, "utf8").catch(error => {
        if (error.code === "ENOENT") return ""
        throw error
      }), { message: "the real tool process starts", timeout: 30_000 }).toBe("started")
      const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
      const endpoint = `${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`
      const readTools = async () => {
        const response = await fetch(endpoint)
        expect(response.ok).toBe(true)
        const rows = await response.json() as Array<{ parts: Array<{ id: string; type: string; state?: { status: string; output?: string } }> }>
        return rows.flatMap(row => row.parts).filter(part => part.type === "tool")
      }
      const tools = await readTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].state?.status).toBe("running")
      const part = page.locator(SELECTORS.toolPart(tools[0].id))
      const status = part.locator('[data-slot="basic-tool-tool-title"]')
      await expect(status).toBeVisible()
      await expect(status).toContainText("Running")
      const connected = sockets.filter(socket => !socket.closed)
      expect(connected.length, "the browser has an open cp/events WebSocket").toBeGreaterThan(0)
      await page.screenshot({ path: testInfo.outputPath("tool-running-before-disconnect.png") })
      network.disconnect()
      await expect.poll(() => connected.every(socket => socket.closed), { message: "the outage closes the existing event connection" }).toBe(true)
      await fs.writeFile(releaseFile, "release")
      await expect.poll(() => fs.readFile(completedFile, "utf8").catch(error => {
        if (error.code === "ENOENT") return ""
        throw error
      }), { message: "the real tool completes while the browser is offline" }).toBe(marker)
      await expect.poll(async () => (await readTools())[0]?.state?.status, { timeout: 30_000 }).toBe("completed")
      await fs.writeFile(testInfo.outputPath("canonical-tools-while-offline.json"), JSON.stringify(await readTools(), null, 2))
      await page.screenshot({ path: testInfo.outputPath("tool-after-completion-while-offline.png") })
      const opensBeforeReconnect = workspaceOpens.length
      const reconnectedAt = Date.now()
      network.reconnect()
      await expect.poll(() => sockets.some(socket => !socket.closed && !connected.includes(socket)), { message: "the browser opens a new event connection", timeout: 30_000 }).toBe(true)
      await expectAssistantReplyVisible(page, marker)
      await expect(status).not.toContainText("Running")
      await expect(status).toContainText("Ran")
      // The workspace stream reopens WITH its cursor — after a backoff the
      // outage's failed attempts grew, so it can trail the settlement the
      // control plane's own reads already showed — and what settled the row
      // comes down it: the retained settlement replayed behind that cursor,
      // or, when the ring had rolled, the gap notice that makes the reader
      // re-read.
      await expect.poll(() => workspaceOpens.length, { message: "the workspace stream reopened after the outage", timeout: 30_000 })
        .toBeGreaterThan(opensBeforeReconnect)
      const reopened = workspaceOpens.slice(opensBeforeReconnect)
      expect(reopened[0]?.cursor, "the reopened workspace stream resumed by cursor").not.toBeNull()
      await expect.poll(
        async () => (await traffic()).some((chunk) => chunk.at >= reconnectedAt
          && (chunk.data.includes('"type":"message.part.updated"') || chunk.data.includes('"type":"stream.replay-gap"'))),
        { message: "the settlement or a gap notice arrived on the reopened workspace stream", timeout: 15_000 },
      ).toBe(true)
      await fs.writeFile(testInfo.outputPath("workspace-stream-traffic.json"), JSON.stringify(await traffic(), null, 2))
      await page.screenshot({ path: testInfo.outputPath("tool-settled-after-reconnect.png") })
      await page.reload({ waitUntil: "domcontentloaded" })
      await expectAssistantReplyVisible(page, marker)
      // A cold open folds a settled turn: the tool sits behind "Worked for…"
      // until opened, which is itself the row saying the tool settled.
      const fold = page.getByRole("button", { name: /^Worked for/ })
      await expect(fold.or(status)).toBeVisible()
      if (await fold.isVisible()) await fold.click()
      await expect(status).toBeVisible()
      await expect(status).not.toContainText("Running")
      expect((await readTools())[0]?.state).toMatchObject({ status: "completed", output: expect.stringContaining(marker) })
    } finally {
      network.reconnect()
      await fs.writeFile(releaseFile, "release")
      await fs.writeFile(testInfo.outputPath("event-connections.json"), JSON.stringify({ controlPlane: sockets, workspace: workspaceOpens }, null, 2))
    }
  })

  test("Claude running tool becomes interrupted without reload after server restart and a follow-up can complete", async ({ page }, testInfo) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install Claude to exercise interruption of a running native tool.")
    const dir = await makeWorkspace("claude-tool-server-restart", "claude")
    const startedFile = path.join(dir, "tool-started")
    const releaseFile = path.join(dir, "release-tool")
    const script = path.join(dir, "held-tool.cjs")
    const marker = `INTERRUPTED_TOOL_${Date.now()}`
    await fs.writeFile(script, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(startedFile)}, "started");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
  clearInterval(timer);
  console.log(${JSON.stringify(marker)});
}, 20);
setTimeout(() => process.exit(2), 90000).unref();
`)
    try {
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, "claude")
      await waitForHarnessReady(page)
      await page.locator('[data-action="prompt-permission-mode"]').last().click()
      await page.locator('[data-permission-mode-row][data-mode="bypassPermissions"]').click()
      scripted!.scriptTool({ name: "Bash", input: { command: `node '${script}'`, timeout: 120000 }, whenPromptIncludes: marker })
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Run the requested command, then reply with exactly this one token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect.poll(() => fs.readFile(startedFile, "utf8").catch(error => {
        if (error.code === "ENOENT") return ""
        throw error
      }), { message: "the real tool starts before the server is restarted", timeout: 30_000 }).toBe("started")
      const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
      const readTools = async () => {
        const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
        expect(response.ok()).toBe(true)
        const messages = await response.json() as Array<{ parts: Array<{ id: string; type: string; state?: { status: string; error?: string } }> }>
        return messages.flatMap(message => message.parts).filter(part => part.type === "tool")
      }
      const tools = await readTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].state?.status).toBe("running")
      const part = page.locator(SELECTORS.toolPart(tools[0].id))
      await expect(part).toContainText("Running")
      await page.screenshot({ path: testInfo.outputPath("tool-before-server-restart.png") })
      await server!.restart()
      await expect(part).toBeVisible({ timeout: 30_000 })
      await fs.writeFile(testInfo.outputPath("tools-after-server-restart.json"), JSON.stringify(await readTools(), null, 2))
      await expect.soft.poll(async () => (await readTools()).find(tool => tool.id === tools[0].id)?.state?.status, {
        message: "the interrupted tool has a terminal error state", timeout: 15_000,
      }).toBe("error")
      await expect.soft(part).not.toContainText("Running")
      const errorCard = part.locator('[data-kind="tool-error-card"]')
      await expect.soft(errorCard).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath("tool-after-server-restart.png") })
      expect(testInfo.errors, "server interruption is visible before testing recovery").toHaveLength(0)
      const interrupted = (await readTools()).find(tool => tool.id === tools[0].id)!
      expect(interrupted.state?.error).toMatch(/interrupt|restart|abort/i)
      const reply = `AFTER_TOOL_RESTART_${Date.now()}`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${reply}. Do not use tools.`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, reply)
      await page.reload({ waitUntil: "domcontentloaded" })
      await expectAssistantReplyVisible(page, reply)
      expect((await readTools()).find(tool => tool.id === tools[0].id)).toEqual(interrupted)
      await expect(part).not.toContainText("Running")
    } finally {
      await fs.writeFile(releaseFile, "release")
    }
  })

  test("New Terminal creates a working shell and retains terminal focus through reload and chat return", async ({ page }, testInfo) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install Claude to exercise terminal creation from a completed real chat.")
    const dir = await makeWorkspace("claude-terminal-navigation", "claude")
    await page.addInitScript(() => {
      localStorage.setItem("claxedo.terminal.screen-reader-mode", "1")
    })
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await switchDraftHarness(page, "claude")
    await waitForHarnessReady(page)
    const reply = `TERMINAL_CHAT_${Date.now()}`
    await composePrompt(page, input, `Reply with exactly this one token: ${reply}. Do not use tools.`)
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, reply)
    const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
    await page.getByRole("button", { name: "New Terminal", exact: true }).last().click()
    const launchers = page.locator('[data-component="terminal-new-launchers"]')
    await expect(launchers).toBeVisible()
    const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/pty") && response.request().method() === "POST")
    await launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="shell"]').click()
    const response = await createdResponse
    expect(response.ok(), await response.text()).toBe(true)
    const created = await response.json() as { id: string }
    expect(created.id).toMatch(/^pty_/)
    const pane = page.locator(`[data-testid="terminal-pane"][data-terminal-id="${created.id}"]`)
    const rail = page.locator(`[data-testid="rail-sidebar-terminal-row"][data-terminal-id="${created.id}"]`)
    await expect(pane).toBeVisible()
    await expect(rail).toBeVisible()
    const suffix = String(Date.now())
    const marker = `TERMINAL_OUTPUT_${suffix}`
    await pane.click()
    await page.keyboard.type(`printf 'TERMINAL_OUTPUT_%s\\n' '${suffix}'`)
    await page.keyboard.press("Enter")
    await expect(pane.locator(".xterm-accessibility-tree")).toContainText(marker, { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath("terminal-created-and-running.png") })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(pane).toBeVisible()
    await expect(pane.locator(".xterm-accessibility-tree")).toContainText(marker, { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath("terminal-after-reload.png") })
    await page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${sessionID}"]`).first().click()
    await expectAssistantReplyVisible(page, reply)
    await rail.click()
    await expect(pane).toBeVisible()
    await expect(pane.locator(".xterm-accessibility-tree")).toContainText(marker)
    const returnMarker = `TERMINAL_RETURN_${suffix}`
    await pane.click()
    await page.keyboard.type(`printf 'TERMINAL_RETURN_%s\\n' '${suffix}'`)
    await page.keyboard.press("Enter")
    await expect(pane.locator(".xterm-accessibility-tree")).toContainText(returnMarker, { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath("terminal-after-chat-return.png") })
  })

  for (const [harness, longOutput, runningCommand] of [["claude", false, false], ["codex", false, false], ["codex", true, false], ["codex", false, true]] as const) {
    test(runningCommand ? "Codex running shell paints its command before completion" : longOutput ? "Codex completed shell exposes all 240 output lines after reload" : `${harness} native long-running tool retains its result through reload`, async ({ page }) => {
      test.fixme(longOutput, "Codex tool results contain the full output but the stored and rendered shell retains only the final chunk")
      test.fixme(runningCommand, "Codex running shell commands intermittently remain transparent until the row remounts")
      const dir = await makeWorkspace(`${harness}-long-result`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      await page.locator('[data-action="prompt-permission-mode"]').last().click()
      await page.locator(`[data-permission-mode-row][data-mode="${harness === "claude" ? "bypassPermissions" : "full-access"}"]`).click()
      const marker = `LONG_RESULT_${Date.now()}`
      const script = path.join(dir, "long-result.cjs")
      await fs.writeFile(script, `${longOutput ? 'for (let i = 1; i <= 240; i++) console.log("OUTPUT_LINE_" + i);' : ""} setTimeout(() => console.log(${JSON.stringify(marker)}), 8000);`)
      const command = `node '${script}'`
      scripted!.scriptTool({ name: harness === "claude" ? "Bash" : "exec_command", input: harness === "claude" ? { command, timeout: 120000 } : { cmd: command, yield_time_ms: 30000 }, whenPromptIncludes: marker })
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Run the requested command, then reply with exactly this one token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      if (runningCommand) {
        const active = page.locator('[data-component="tool-part-wrapper"]').filter({ hasText: "Running" }).last()
        await expect(active).toBeVisible()
        const label = active.getByText(command, { exact: true })
        await expect(label).toHaveCount(1)
        await expect.soft.poll(async () => (await readPaintGeometry(label)).opacity, { timeout: 1000, message: "the running command finishes its entrance animation" }).toBeGreaterThan(0.9)
        const geometry = await readPaintGeometry(label)
        await fs.writeFile(test.info().outputPath("running-command-geometry.json"), JSON.stringify({ command, geometry }, null, 2))
        await page.screenshot({ path: test.info().outputPath("running-command.png") })
        await expect(active).toContainText("Running")
        expect.soft(geometry.opacity, "the running command is painted, not transparent").toBeGreaterThan(0.9)
        expect.soft(geometry.visibility).toBe(true)
        expect.soft(geometry.width).toBeGreaterThan(0)
        expect.soft(geometry.height).toBeGreaterThan(0)
        expect.soft(geometry.hit, "the running command is not covered").toBe(true)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(active).toBeVisible()
        await expect(label).toHaveCount(1)
        await expect.soft.poll(async () => (await readPaintGeometry(label)).opacity, { timeout: 1000, message: "the restored command finishes its entrance animation" }).toBeGreaterThan(0.9)
        const restored = await readPaintGeometry(label)
        await fs.writeFile(test.info().outputPath("restored-running-command-geometry.json"), JSON.stringify({ command, geometry: restored }, null, 2))
        await page.screenshot({ path: test.info().outputPath("restored-running-command.png") })
        await expect(active).toContainText("Running")
        expect.soft(restored.opacity, "the restored running command is painted").toBeGreaterThan(0.9)
        expect.soft(restored.visibility).toBe(true)
        expect.soft(restored.width).toBeGreaterThan(0)
        expect.soft(restored.height).toBeGreaterThan(0)
        expect.soft(restored.hit, "the restored running command is not covered").toBe(true)
      }
      await expectAssistantReplyVisible(page, marker)
      const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
      const read = async () => {
        const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
        expect(response.ok()).toBe(true)
        const rows = await response.json() as Array<{ parts: Array<{ type: string; id: string; state?: { status: string; output?: string } }> }>
        return rows.flatMap((row) => row.parts).filter((part) => part.type === "tool")
      }
      const tools = await read()
      expect(tools).toHaveLength(1)
      expect(tools[0].state).toMatchObject({ status: "completed", output: expect.stringContaining(marker) })
      await page.reload({ waitUntil: "domcontentloaded" })
      await expectAssistantReplyVisible(page, marker)
      expect(await read()).toEqual(tools)
      if (longOutput) {
        await fs.writeFile(test.info().outputPath("command-source.cjs"), await fs.readFile(script))
        const results = scripted!.requests.flatMap(({ body }) => "input" in body && Array.isArray(body.input)
          ? body.input.filter(item => item.type === "function_call_output") : [])
        await fs.writeFile(test.info().outputPath("native-tool-results.json"), JSON.stringify(results, null, 2))
        expect(JSON.stringify(results).match(/OUTPUT_LINE_\d+/g), "Codex returns all lines to the model endpoint").toEqual(
          Array.from({ length: 240 }, (_, index) => `OUTPUT_LINE_${index + 1}`),
        )
        await fs.writeFile(test.info().outputPath("completed-shell-part.json"), JSON.stringify(tools[0], null, 2))
        const part = page.locator(SELECTORS.toolPart(tools[0].id))
        await part.scrollIntoViewIfNeeded()
        await part.locator('[data-component="tool-trigger"]').click()
        await page.screenshot({ path: test.info().outputPath("completed-shell-expanded.png") })
        const output = part.locator('[data-slot="bash-pre"]')
        await expect(output).toBeVisible()
        await expect(output, "expanded command retains the first output line").toContainText("OUTPUT_LINE_1")
        await expect(output, "expanded command retains the final output line").toContainText("OUTPUT_LINE_240")
        await expect(part.getByRole("button", { name: "Show all", exact: true })).toBeVisible()
      }
    })
  }

  for (const harness of ["claude", "codex"] as const) {
    test(`${harness} native busy draft preserves multiline text through reload and submits once`, async ({ page }) => {
      const dir = await makeWorkspace(`${harness}-busy-draft`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      const first = `FIRST_DRAFT_${Date.now()}`
      const next = `NEXT_DRAFT_${Date.now()}`
      const firstPrompt = `Reply with exactly this one token: ${first}`
      const draft = `First line: café — नमस्ते\n\nMiddle line: preserve <tags>, quotes "hello", and \`code\`.\nLast line: Reply with exactly this one token: ${next}`
      const release = scripted!.holdTextReplies(first)
      try {
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), firstPrompt)
        await page.locator(SELECTORS.submitControl).last().click()
        await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
        await expect.poll(() => scripted!.requests.some((request) => request.prompt.includes(first))).toBe(true)
        const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
        const readUsers = async () => {
          const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
          expect(response.ok()).toBe(true)
          const rows = await response.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
          return rows.filter((row) => row.info.role === "user").map((row) => row.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
        }
        const readStatus = async () => {
          const response = await page.request.get(`${BACKEND_URL}/session/status?directory=${encodeURIComponent(dir)}`)
          expect(response.ok()).toBe(true)
          const statuses = await response.json() as Record<string, { type: string }>
          return statuses[sessionID]?.type
        }
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), draft)
        await expect.poll(readStatus).toBe("busy")
        await expect(page.locator(SELECTORS.submitControl).last()).toHaveAccessibleName("Send")
        expect(await readUsers()).toEqual([firstPrompt])
        await page.reload({ waitUntil: "domcontentloaded" })
        const editor = page.getByRole("textbox", { name: /Ask anything/i }).last()
        await expect(editor).toHaveText(draft, { useInnerText: true })
        await expect.poll(readStatus).toBe("busy")
        await expect(page.locator(SELECTORS.submitControl).last()).toHaveAccessibleName("Send")
        expect(await readUsers()).toEqual([firstPrompt])
        release()
        await expectAssistantReplyVisible(page, first)
        await expect(editor).toHaveText(draft, { useInnerText: true })
        await expect(page.locator(SELECTORS.submitControl).last()).toHaveAccessibleName("Send")
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, next)
        expect(await readUsers()).toEqual([firstPrompt, draft])
        // The fixture's prompt index is JSON-encoded; inspect the actual wire body
        // using the same encoding so quotes and newlines are compared exactly.
        expect(scripted!.requests.some((request) => JSON.stringify(request.body).includes(JSON.stringify(draft).slice(1, -1)))).toBe(true)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, next)
        expect(await readUsers()).toEqual([firstPrompt, draft])
        await expect(editor).toBeEmpty()
      } finally { release() }
    })
  }

  for (const harness of ["claude", "codex"] as const) {
    test(`${harness} native switch model and resend preserves the failed prompt`, async ({ page }) => {
      const dir = await makeWorkspace(`${harness}-model-recovery`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      const warmup = `WARMUP_${Date.now()}`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${warmup}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, warmup)
      const dialect = harness === "claude" ? "messages" : "responses"
      const originalModel = scripted!.requests.filter((request) => request.dialect === dialect && request.prompt.includes(warmup)).at(-1)!.model
      const marker = `MODEL_RECOVERY_${Date.now()}`
      const prompt = `Preserve this context: café — नमस्ते.\n\nReply with exactly this one token: ${marker}`
      const explanation = `Model unavailable for ${marker}. Choose another model.`
      const release = scripted!.scriptError({ marker, status: 400, message: explanation, model: originalModel })
      try {
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), prompt)
        await page.locator(SELECTORS.submitControl).last().click()
        await expect(page.getByText(explanation, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
        const url = page.url()
        await page.reload({ waitUntil: "domcontentloaded" })
        await page.getByRole("button", { name: "Switch model and resend", exact: true }).click()
        const modelDialog = page.getByRole("dialog")
        await expect(modelDialog).toBeVisible()
        // Opening and dismissing recovery must not send or switch anything.
        await page.keyboard.press("Escape")
        await expect(modelDialog).not.toBeVisible()
        expect(scripted!.requests.filter((request) => request.prompt.includes(marker) && request.reply.kind === "text")).toHaveLength(0)
        await page.getByRole("button", { name: "Switch model and resend", exact: true }).click()
        const choice = harness === "claude"
          ? modelDialog.locator('[data-slot="list-item"]').filter({ hasText: /Haiku/i }).first()
          : modelDialog.locator('[data-slot="list-item"]').first()
        await expect(choice).toBeVisible({ timeout: 10_000 })
        await choice.click()
        await expectAssistantReplyVisible(page, marker)
        const successes = scripted!.requests.filter((request) => request.dialect === dialect && request.prompt.includes(marker) && request.reply.kind === "text")
        expect(successes.length).toBeGreaterThan(0)
        expect(successes.every((request) => request.model !== originalModel)).toBe(true)
        const sessionID = new URL(url).pathname.split("/").at(-1)!
        const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
        expect(response.ok()).toBe(true)
        const rows = await response.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
        const users = rows.filter((row) => row.info.role === "user").map((row) => row.parts.filter((part) => part.type === "text").map((part) => part.text).join(""))
        expect(users).toHaveLength(3)
        expect(users.slice(1)).toEqual([prompt, prompt])
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, marker)
        await expect(page).toHaveURL(url)
      } finally { release() }
    })
  }

  for (const harness of ["claude", "codex"] as const) {
    for (const restart of [false, true]) {
    test(`${harness} native provider error preserves explanation through reload and recovery${restart ? " after server restart" : ""}`, async ({ page }) => {
      const dir = await makeWorkspace(`${harness}-provider-error`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      if (restart) {
        const warmup = `BEFORE_RESTART_${Date.now()}`
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${warmup}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, warmup)
        await server!.restart()
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, warmup)
      }
      const marker = `PROVIDER_ERROR_${Date.now()}`
      const explanation = `Request blocked for ${marker}. Start a new session or choose another model.`
      const releaseError = scripted!.scriptError({ marker, status: 400, message: explanation })
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
      await expect(page.getByText(explanation, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
      const url = page.url()
      const sessionID = new URL(url).pathname.split("/").at(-1)!
      const read = async () => {
        const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/message?directory=${encodeURIComponent(dir)}`)
        expect(response.ok()).toBe(true)
        return response.json()
      }
      expect(JSON.stringify(await read())).toContain(explanation)
      expect(scripted!.requests.filter((request) => request.reply.kind === "error").length).toBeGreaterThan(0)
      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(page.getByText(explanation, { exact: false }).first()).toBeVisible()
      expect(JSON.stringify(await read())).toContain(explanation)
      releaseError()
      const next = `RECOVERED_${Date.now()}`
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(), `Reply with exactly this one token: ${next}`)
      await expect(page.locator(SELECTORS.submitControl).last()).toHaveAccessibleName("Send")
      await page.locator(SELECTORS.submitControl).last().click()
      await expectAssistantReplyVisible(page, next)
      await page.reload({ waitUntil: "domcontentloaded" })
      await expectAssistantReplyVisible(page, next)
      expect(JSON.stringify(await read())).toContain(explanation)
      await expect(page).toHaveURL(url)
    })
    }
  }

  for (const [harness, presentation] of [["claude", false], ["codex", false], ["codex", true]] as const) {
    test(presentation ? "Codex failed shell header retains its command and exit code after reload" : `${harness} native tool failure survives reload and a successful next tool`, async ({ page }) => {
      test.fixme(presentation, "Codex failed shell headers omit the command even when the stored tool input contains it")
      const dir = await makeWorkspace(`${harness}-tool-error`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      await page.locator('[data-action="prompt-permission-mode"]').last().click()
      await page.locator(`[data-permission-mode-row][data-mode="${harness === "claude" ? "bypassPermissions" : "full-access"}"]`).click()
      const result = await expectToolErrorRecovery({ page, directory: dir, backend: BACKEND_URL, run: async (command, marker) => {
        scripted!.scriptTool({ name: harness === "claude" ? "Bash" : "exec_command",
          input: harness === "claude" ? { command } : { cmd: command }, whenPromptIncludes: marker })
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
          `Run the requested command, then reply with exactly this one token: ${marker}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, marker)
      } })
      if (presentation) {
        const part = page.locator(SELECTORS.toolPart(result.failed.id))
        await part.scrollIntoViewIfNeeded()
        await page.screenshot({ path: test.info().outputPath("failed-shell-header.png") })
        await fs.writeFile(test.info().outputPath("failed-shell-part.json"), JSON.stringify(result.failed, null, 2))
        const trigger = part.locator('[data-component="tool-trigger"]')
        await expect.soft(trigger, "failed shell header identifies the command").toContainText("fail.cjs")
        await expect(part.locator('[data-slot="basic-tool-tool-exit"]'), "failed shell retains a visible exit code").toHaveText(/23/)
      }
    })
  }

  for (const harness of ["claude", "codex", "pi"] as const) {
    for (const [action, goalMode] of [["stop", false], ["stop", true], ["delete", false]] as const) {
    test(action === "delete" ? `${harness} Delete kills a running shell without resurrecting the session` : `${harness} Stop kills a running shell and the same session accepts a follow-up${goalMode ? " in Goal mode" : ""}`, async ({ page }) => {
      const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
      requireBinary(binary, harness, "install the native CLI to exercise interruption of a real tool process.")
      const dir = await makeWorkspace(`${harness}-stop-tool`, harness)
      const pidFile = path.join(dir, "tool.pid")
      const releaseFile = path.join(dir, "release-tool")
      const finishedFile = path.join(dir, "tool-finished")
      try {
        await seedOneProject(page, dir)
        const input = await openDraftPrompt(page, dir)
        if (harness === "pi") {
          await selectScriptedModel(page)
        } else {
          await switchDraftHarness(page, harness)
          await waitForHarnessReady(page)
          await page.locator('[data-action="prompt-permission-mode"]').last().click()
          const mode = harness === "claude" ? "bypassPermissions" : "full-access"
          await page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
        }
        const marker = `STOP-TOOL-${Date.now()}`
        const workload = path.join(dir, "interrupt-workload.cjs")
        await fs.writeFile(workload, `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(releaseFile)})) return; fs.writeFileSync(${JSON.stringify(finishedFile)}, "leaked"); clearInterval(timer); }, 50);`)
        const command = `node '${workload}'`
        scripted!.scriptTool({
          name: harness === "claude" ? "Bash" : harness === "codex" ? "exec_command" : "bash",
          input: harness === "claude" ? { command, timeout: 120000 }
            : harness === "codex" ? { cmd: command, yield_time_ms: 30000 }
            : { command, timeout: 120 },
          whenPromptIncludes: marker,
          ...(harness === "claude" && goalMode ? { autoModeSeverity: 0 as const } : {}),
        })
        await composePrompt(page, input, `${goalMode ? "/goal " : ""}Run the command, then reply with exactly this one token: ${marker}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
        const sessionUrl = page.url()
        await expect.poll(() => fs.readFile(pidFile, "utf8").catch(() => ""), { timeout: 30_000 }).toMatch(/^\d+$/)
        if (harness === "claude" && goalMode) {
          expect(scripted!.requests.some((request) => request.reply.kind === "text" && request.reply.text === "<severity>0</severity>"), "Claude did not execute the native Auto classifier protocol").toBe(true)
        }
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
        expect(await fs.stat(finishedFile).then(() => true, () => false)).toBe(false)
        if (action === "delete") {
          await page.getByRole("button", { name: "More options", exact: true }).click()
          await page.getByRole("menuitem", { name: "Delete", exact: true }).click()
          await page.getByRole("button", { name: "Delete session", exact: true }).click()
          await expect(page).not.toHaveURL(sessionUrl)
        } else {
          await page.getByRole("button", { name: "Stop", exact: true }).click()
        }
        await expect.poll(alive, { timeout: 15_000, message: `${harness} left the interrupted shell running` }).toBe(false)
        if (goalMode) await expect(goalStatus(page.locator('[data-component="session-goal-dock"]'), "Paused")).toBeVisible()
        await fs.writeFile(releaseFile, "release")
        if (action === "delete") {
          await openDraftPrompt(page, dir)
          if (harness === "pi") await selectScriptedModel(page)
          else { await switchDraftHarness(page, harness); await waitForHarnessReady(page) }
        }
        const followup = page.getByRole("textbox", { name: /Ask anything/i }).last()
        await expect(followup).toBeVisible()
        const nextMarker = `AFTER-${marker}`
        await composePrompt(page, followup, `Reply with exactly this one token: ${nextMarker}`)
        await expect(page.locator(SELECTORS.submitControl).last()).toHaveAccessibleName("Send")
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, nextMarker)
        if (action === "stop") await expect(page).toHaveURL(sessionUrl)
        else await expect(page).not.toHaveURL(sessionUrl)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, nextMarker)
        if (action === "delete") {
          const removedId = new URL(sessionUrl).pathname.split("/").at(-1)!
          const response = await page.request.get(`${BACKEND_URL}/session/${removedId}?directory=${encodeURIComponent(dir)}`)
          expect(response.status()).toBe(404)
          await expect(page.locator(`[data-testid="rail-sidebar-session-row"][data-session-id="${removedId}"]`)).toHaveCount(0)
        }
        if (goalMode) await expect(page.locator('[data-component="session-goal-dock"]').getByText("Paused", { exact: true })).toBeVisible()
        expect(await fs.stat(finishedFile).then(() => true, () => false)).toBe(false)
      } finally {
        await fs.writeFile(releaseFile, "release")
      }
    })
    }
  }

  test("claude native todo progress uses provider IDs across turns and reload", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the native CLI to exercise task tracking")
    const dir = await makeWorkspace("claude-native-tasks", "claude")
    await seedOneProject(page, dir)
    await openDraftPrompt(page, dir)
    await switchDraftHarness(page, "claude")
    await waitForHarnessReady(page)
    let turn = 0
    let release: (() => void) | undefined
    const invoke = async (name: string, input: Record<string, unknown>, hold = false) => {
      const marker = `TASK-${Date.now()}-${turn++}`
      if (hold) release = scripted!.holdTextReplies(marker)
      scripted!.scriptTool({ name, input, whenPromptIncludes: marker })
      await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
        `Perform the requested task operation, then reply with exactly this one token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      if (!hold) await expectAssistantReplyVisible(page, marker)
      return marker
    }
    const read = async () => {
      const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
      const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/todo?directory=${encodeURIComponent(dir)}`)
      expect(response.ok()).toBe(true)
      return await response.json() as Array<{ id: string; content: string; status: string }>
    }
    try {
      const names = ["Inspect source", "Verify behavior", "Report result"]
      for (const subject of names) await invoke("TaskCreate", { subject, description: subject })
      const created = await read()
      expect(created.map((row) => row.content)).toEqual(names)
      expect(created.every((row) => typeof row.id === "string" && row.id.length > 0)).toBe(true)
      expect(new Set(created.map((row) => row.id)).size).toBe(3)
      await invoke("TaskUpdate", { taskId: created[0].id, status: "completed" })
      const progressMarker = await invoke("TaskUpdate", { taskId: created[1].id, status: "in_progress" }, true)
      await expect.poll(async () => (await read()).map((row) => row.status)).toEqual(["completed", "in_progress", "pending"])
      const progress = await read()
      expect(progress.map((row) => row.status)).toEqual(["completed", "in_progress", "pending"])
      const dock = page.locator('[data-component="session-todo-dock"]')
      await expect(dock).toContainText("Verify behavior")
      await page.reload({ waitUntil: "domcontentloaded" })
      expect(await read()).toEqual(progress)
      await expect(dock).toContainText("Verify behavior")
      release!()
      release = undefined
      await expectAssistantReplyVisible(page, progressMarker)
      for (const row of created.slice(1)) await invoke("TaskUpdate", { taskId: row.id, status: "completed" })
      await expect(dock).toHaveCount(0)
      await page.reload({ waitUntil: "domcontentloaded" })
      expect((await read()).map(({ id, content, status }) => ({ id, content, status })))
        .toEqual(created.map(({ id, content }) => ({ id, content, status: "completed" })))
      // Native deletion must clear the last task too, rather than retain a stale dock/list.
      for (const row of created) await invoke("TaskUpdate", { taskId: row.id, status: "deleted" })
      expect(await read()).toEqual([])
    } finally { release?.() }
  })

  for (const harness of ["codex"] as const) {
    test(`${harness} native todo progress survives reload and completes through its real tool`, async ({ page }) => {
      const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
      requireBinary(binary, harness, "install the native CLI to exercise its task tracking tool.")
      const dir = await makeWorkspace(`${harness}-todo`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      const tasks = ["Inspect source", "Verify behavior", "Report result"]
      const marker = `TODO-${Date.now()}`
      let release = () => {}
      try {
        for (const complete of [false, true]) {
          const token = `${marker}-${complete ? "DONE" : "PROGRESS"}`
          const statuses = complete ? ["completed", "completed", "completed"] : ["completed", "in_progress", "pending"]
          release = scripted!.holdTextReplies(token)
          scripted!.scriptTool({
            name: "update_plan",
            input: { plan: tasks.map((step, i) => ({ step, status: statuses[i] })) },
            whenPromptIncludes: token,
          })
          await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
            `Update the task list, then reply with exactly this one token: ${token}`)
          await page.locator(SELECTORS.submitControl).last().click()
          await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
          const sessionID = new URL(page.url()).pathname.split("/").at(-1)!
          const readTodos = async () => {
            const response = await page.request.get(`${BACKEND_URL}/session/${sessionID}/todo?directory=${encodeURIComponent(dir)}`)
            expect(response.ok()).toBe(true)
            return await response.json() as Array<{ content: string; status: string }>
          }
          await expect.poll(async () => (await readTodos()).map(({ content, status }) => ({ content, status })), { timeout: 30_000 })
            .toEqual(tasks.map((content, i) => ({ content, status: statuses[i] })))
          const dock = page.locator('[data-component="session-todo-dock"]')
          if (!complete) {
            await expect(dock).toBeVisible()
            await expect(dock.locator('span[aria-label="1 of 3 todos completed"]')).toBeVisible()
            await page.reload({ waitUntil: "domcontentloaded" })
            await expect(dock).toBeVisible()
            await expect(dock).toContainText("Verify behavior")
            await page.locator('[data-action="session-todo-toggle-button"]').click()
            await expect(page.locator('[data-slot="session-todo-preview"] [data-component="text-reveal"]'))
              .toHaveAttribute("aria-label", "Verify behavior")
            await page.screenshot({ path: test.info().outputPath("todo-progress-reloaded.png") })
          } else {
            await expect(dock).toHaveCount(0, { timeout: 10_000 })
          }
          release()
          await expectAssistantReplyVisible(page, token)
          if (complete) {
            await page.reload({ waitUntil: "domcontentloaded" })
            await expectAssistantReplyVisible(page, token)
            expect((await readTodos()).map((todo) => todo.status)).toEqual(statuses)
            await expect(dock).toHaveCount(0)
          }
        }
      } finally {
        release()
      }
    })

  }

  for (const harness of ["claude", "codex"] as const) {
    for (const [decision, canonicalDirectory, restartServer, goalMode, interruptResponse] of [
      ["Allow once", false, false, false], ["Allow always", false, false, false], ["Deny", false, false, false], ["Stop", false, false, false], ["Delete", false, false, false], ["Delete", false, false, false, true],
      ...(harness === "codex" ? [["Stop", false, false, true] as const] : []),
      ...(harness === "claude" ? [["Allow always", true, false, false] as const] : []),
      ["Allow always", false, true, false],
      ...(harness === "codex" ? [["Allow always", false, "idle", false] as const] : []),
    ] as const) {
      test(`${harness} native permission ${decision} gates a real file write after reload${canonicalDirectory ? " with a canonical directory" : ""}${restartServer === "idle" ? " and native idle disposal" : restartServer ? " and server restart" : ""}${goalMode ? " in Goal mode" : ""}${interruptResponse ? " with lost delete response" : ""}`, async ({ page }) => {
        const binary = await resolveBinary(harness, `CLAXEDO_E2E_${harness.toUpperCase()}_BIN`)
        requireBinary(binary, harness, "install the native CLI to exercise its tool approval boundary.")
        const dir = await makeWorkspace(`${harness}-permission`, harness)
        const createdOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-permission-write-"))
        const outputDir = canonicalDirectory ? await fs.realpath(createdOutputDir) : createdOutputDir
        const output = path.join(outputDir, "result.txt")
        try {
          await seedOneProject(page, dir)
          const input = await openDraftPrompt(page, dir)
          await switchDraftHarness(page, harness)
          await waitForHarnessReady(page)
          const permissionMode = page.locator('[data-action="prompt-permission-mode"]').last()
          const mode = harness === "claude" ? "default" : "workspace-write"
          await permissionMode.click()
          await page.locator(`[data-permission-mode-row][data-mode="${mode}"]`).click()
          await expect(permissionMode).toHaveAttribute("data-mode", mode)
          const marker = `PERMISSION-${Date.now()}`
          const command = `printf approved-write > '${output}'`
          const tool = {
            name: harness === "claude" ? "Bash" : "exec_command",
            input: harness === "claude"
              ? { command, description: "Write the isolated approval test file" }
              : { cmd: command, sandbox_permissions: "require_escalated", justification: "Write the isolated approval test file" },
            whenPromptIncludes: marker,
          }
          scripted!.scriptTool(tool)
          await composePrompt(page, input, `${goalMode ? "/goal " : ""}Run the requested command, then reply with exactly this one token: ${marker}`)
          await page.locator(SELECTORS.submitControl).last().click()
          await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
          const sessionUrl = page.url()
          const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })
          await expect(dock).toBeVisible({ timeout: 60_000 })
          await expect(dock.locator('[data-slot="permission-command"]')).toContainText(command)
          expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          await page.reload({ waitUntil: "domcontentloaded" })
          await expect(dock).toBeVisible({ timeout: 30_000 })
          await expect(dock.locator('[data-slot="permission-command"]')).toContainText(command)
          expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          await page.screenshot({ path: test.info().outputPath("permission-pending.png") })
          if (decision === "Deny") {
            await expectPermissionReplyIsolation(page, {
              backendUrl: BACKEND_URL, directory: dir,
              sessionId: new URL(sessionUrl).pathname.split("/").at(-1)!, harness, mode,
            })
            await expect(dock).toBeVisible()
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          }
          if (decision === "Stop" || decision === "Delete") {
            await cancelPendingPermission(page, {
              action: decision, interruptResponse,
              backendUrl: BACKEND_URL, directory: dir,
              sessionId: new URL(sessionUrl).pathname.split("/").at(-1)!,
            })
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            if (goalMode) {
              const goalDock = page.locator('[data-component="session-goal-dock"]')
              await expect(goalStatus(goalDock, "Paused")).toBeVisible({ timeout: 30_000 })
            }
            if (decision === "Delete") {
              await openDraftPrompt(page, dir)
              await switchDraftHarness(page, harness)
              await waitForHarnessReady(page)
            }
            const followup = `AFTER-${decision.toUpperCase()}-${Date.now()}`
            await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
              `Reply with exactly this one token: ${followup}. Do not use tools or retry the cancelled action.`)
            await page.locator(SELECTORS.submitControl).last().click()
            await expectAssistantReplyVisible(page, followup)
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            await page.reload({ waitUntil: "domcontentloaded" })
            await expectAssistantReplyVisible(page, followup)
            await expect(dock).toHaveCount(0)
            return
          }
          await dock.getByRole("button", { name: decision, exact: true }).click()
          await expect(dock).toHaveCount(0)
          await expectAssistantReplyVisible(page, marker)
          if (decision !== "Deny") {
            await expect.poll(() => fs.readFile(output, "utf8").catch(() => "")).toBe("approved-write")
          } else {
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
          }
          await expect(page).toHaveURL(sessionUrl)
          await page.reload({ waitUntil: "domcontentloaded" })
          await expectAssistantReplyVisible(page, marker)
          await expect(dock).toHaveCount(0)
          if (decision === "Allow always") {
            if (restartServer === "idle") {
              // Wait for the production idle owner, not an arbitrary sleep or
              // a simulated process exit. Immediate follow-ups miss this loss.
              const logStart = server!.log().length
              await expect.poll(() => server!.log().slice(logStart), { timeout: 45_000 })
                .toContain("codex app-server idle timeout, disposing")
            } else if (restartServer) {
              await server!.restart()
              await page.reload({ waitUntil: "domcontentloaded" })
              await expectAssistantReplyVisible(page, marker)
              await expect(dock).toHaveCount(0)
            }
            await fs.rm(output)
            const followupMarker = `SECOND-${marker}`
            scripted!.scriptTool({ ...tool, whenPromptIncludes: followupMarker })
            await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
              `Run the same command again, then reply with exactly this one token: ${followupMarker}`)
            await page.locator(SELECTORS.submitControl).last().click()
            await expect.poll(async () => (await dock.count()) ? "approval requested again" : fs.readFile(output, "utf8").catch(() => ""), { timeout: 30_000 })
              .toBe("approved-write")
            await expectAssistantReplyVisible(page, followupMarker)
            await expect(dock).toHaveCount(0)
          }
          if (decision === "Allow once") {
            await fs.rm(output)
            const followupMarker = `SECOND-${marker}`
            scripted!.scriptTool({ ...tool, whenPromptIncludes: followupMarker })
            await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
              `Run the same command again, then reply with exactly this one token: ${followupMarker}`)
            await page.locator(SELECTORS.submitControl).last().click()
            await expect(dock).toBeVisible({ timeout: 60_000 })
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            await dock.getByRole("button", { name: "Deny", exact: true }).click()
            await expectAssistantReplyVisible(page, followupMarker)
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            await expect(dock).toHaveCount(0)
          }
        } finally {
          await fs.rm(outputDir, { recursive: true, force: true })
        }
      })
    }
  }

  test("codex pending approval survives session switches without duplicate prompt, rail, or hydration regressions", async ({
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
    // Both hydration and the settled control must use runtime-reported modes.
    expect(permissionModes).not.toContain("claxedo-allow-safe")
    expect(permissionModes).not.toContain("claxedo-ask-always")
    const settledMode = page.locator('[data-action="prompt-permission-mode"]').filter({ visible: true }).last()
    await expect(settledMode).toHaveAttribute("data-mode", "workspace-write")
    await expect(settledMode).not.toHaveAttribute("data-mode", "claxedo-allow-safe")
    await expect(settledMode).not.toHaveAttribute("data-mode", "claxedo-ask-always")
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

  test("codex child session's escalated command surfaces an approval dock, not a silent denial", async ({ page }, testInfo) => {
    test.fixme(true, "a child session's approval request is auto-denied without surfacing a decision dock")
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to exercise a real child-session approval boundary.")
    const dir = await makeWorkspace("codex-child-permission", "codex")
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-child-permission-"))
    const output = path.join(outputDir, "result.txt")
    try {
      await seedOneProject(page, dir)
      const input = await openDraftPrompt(page, dir)
      await switchDraftHarness(page, "codex")
      await waitForHarnessReady(page)
      const permission = page.locator('[data-action="prompt-permission-mode"]').last()
      await permission.click()
      await page.locator('[data-permission-mode-row][data-mode="workspace-write"]').click()
      await expect(permission).toHaveAttribute("data-mode", "workspace-write")

      const marker = `CHILDSPAWN-${Date.now()}`
      scripted!.scriptTool({
        name: "spawn_agent",
        input: { task_name: "approval_child", message: "Run the requested command, then reply with exactly CHILD-DONE" },
        whenPromptIncludes: marker,
      })
      await composePrompt(page, input, `Delegate one child task, then reply with exactly this token: ${marker}`)
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })

      // Arm the child's escalated command only after the spawn call fired. The
      // child's first model request is a fresh conversation with no
      // function_call_output; every parent continuation after the spawn carries
      // one, so an unmarked tool lands on the child's turn only.
      //
      // The codex app-server drops the just-created thread when its process
      // restarts between session create and first send ("no rollout found for
      // thread id"). While that upstream defect holds, the scenario cannot
      // reach the child turn — skip there rather than fail at the wrong step.
      const spawned = await expect
        .poll(() => scripted!.requests.some((request) => request.reply.kind === "tool"), { timeout: 30_000 })
        .toBe(true)
        .then(() => true, () => false)
      if (!spawned) {
        test.skip(true, "blocked upstream: the codex parent turn dies with 'no rollout found for thread id' before the spawn call")
      }
      scripted!.scriptTool({
        name: "exec_command",
        input: { cmd: `printf child-denied > '${output}'`, sandbox_permissions: "require_escalated", justification: "child approval boundary" },
      })

      // QA state 75: the child command reported "User declined the command"
      // while no approval surface ever appeared. The expected behavior is that
      // the child's ask reaches a decision dock on the parent.
      const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]').filter({ visible: true })
      await expect(dock, "the child session's escalated command never surfaced a decision dock").toBeVisible({ timeout: 120_000 })
      await page.screenshot({ path: testInfo.outputPath("child-permission-dock.png") })
    } finally {
      await fs.rm(outputDir, { recursive: true, force: true })
    }
  })

  test("cursor harness materializes without silently routing through another provider", async ({
    page,
  }) => {
    // Cursor cannot be redirected at the scripted endpoint (proprietary API, no base-URL
    // knob), so this scenario runs no turn. What it proves instead: selecting Cursor either
    // locks in as itself or reports itself unavailable, and in neither case does anything leak
    // onto a provider this file pointed elsewhere.
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
      option: /^Claude Code$/,
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
