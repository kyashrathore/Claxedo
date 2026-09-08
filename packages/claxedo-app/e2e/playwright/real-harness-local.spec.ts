import { expectToolErrorRecovery } from "../helpers/tool-error-recovery"
/** Real native-harness browser journeys against an isolated self-host server and scripted model HTTP endpoints. */
import { expectConcurrentQuestionIsolation } from "../helpers/question-isolation"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { expectPermissionReplyIsolation } from "../helpers/permission-isolation"
import { stopPendingPermission } from "../helpers/permission-stop"
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

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    // Init scripts run on every navigation. Seed only the fresh browser context;
    // reload must retain the app's actual project, model and terminal state.
    if (localStorage.getItem("claxedo.global.dat:server")) return
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
    `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`,
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

  test.afterEach(async () => {
    const testInfo = test.info()
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

  test("pi-workspace harness completes exact turns, reload, and visible usage", async ({ page }) => {
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

  test("local new-worktree session receives its first reply", async ({ page }) => {
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

  for (const [action, goalMode] of [["answer", false], ["dismiss", false], ["stop", false], ["stop", true]] as const) {
    test(`codex native structured question ${action} reaches the question dock${goalMode ? " in Goal mode" : ""}`, async ({ page }) => {
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
        ] }] },
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
          await dock.locator('[data-slot="question-option"]', { hasText: "Staging" }).click()
          await dock.getByRole("button", { name: "Submit", exact: true }).click()
        }
        await expectAssistantReplyVisible(page, marker)
        expect(toolResults().length).toBeGreaterThan(0)
        if (action === "answer") expect(JSON.stringify(toolResults())).toContain("Staging")
        else expect(JSON.stringify(toolResults())).not.toContain("Staging")
      } finally {
        await test.info().attach("codex-question-tool-contract.json", {
          contentType: "application/json",
          body: JSON.stringify({ tools: scripted!.requests.map(({ tools }) => tools.map((tool) => tool.name)), results: toolResults() }),
        })
      }
    })

  }


  for (const [action, goalMode] of [["answer", false], ["custom", false], ["dismiss", false], ["stop", false], ["stop", true]] as const) {
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
      const environment = action === "custom" ? "Preview environment" : "Staging"
      const environmentOption = action === "custom"
        ? dock.locator('[data-slot="question-option"][data-custom="true"]')
        : dock.locator('[data-slot="question-option"]', { hasText: "Staging" })
      await environmentOption.click()
      if (action === "custom") {
        const customInput = dock.locator('[data-slot="question-custom-input"]')
        await customInput.fill(environment)
        await customInput.press("Enter")
      }
      await dock.getByRole("button", { name: "Next", exact: true }).click()
      await expect(dock).toContainText("Which checks should run?")
      await expect(dock).toContainText("Select all answers that apply")
      await dock.locator('[data-slot="question-option"]', { hasText: "Unit" }).click()
      await dock.locator('[data-slot="question-option"]', { hasText: "Browser" }).click()
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
    await expect(page.locator('[data-component="task-tool-card"]')).toHaveCount(0)
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


  for (const harness of ["claude", "codex"] as const) {
    test(`${harness} native tool failure survives reload and a successful next tool`, async ({ page }) => {
      const dir = await makeWorkspace(`${harness}-tool-error`, harness)
      await seedOneProject(page, dir)
      await openDraftPrompt(page, dir)
      await switchDraftHarness(page, harness)
      await waitForHarnessReady(page)
      await page.locator('[data-action="prompt-permission-mode"]').last().click()
      await page.locator(`[data-permission-mode-row][data-mode="${harness === "claude" ? "bypassPermissions" : "full-access"}"]`).click()
      await expectToolErrorRecovery({ page, directory: dir, backend: BACKEND_URL, run: async (command, marker) => {
        scripted!.scriptTool({ name: harness === "claude" ? "Bash" : "exec_command",
          input: harness === "claude" ? { command } : { cmd: command }, whenPromptIncludes: marker })
        await composePrompt(page, page.getByRole("textbox", { name: /Ask anything/i }).last(),
          `Run the requested command, then reply with exactly this one token: ${marker}`)
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, marker)
      } })
    })
  }

  for (const harness of ["claude", "codex", "pi"] as const) {
    for (const goalMode of [false, true]) {
    test(`${harness} Stop kills a running shell and the same session accepts a follow-up${goalMode ? " in Goal mode" : ""}`, async ({ page }) => {
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
        await page.getByRole("button", { name: "Stop", exact: true }).click()
        await expect.poll(alive, { timeout: 15_000, message: `${harness} left the interrupted shell running` }).toBe(false)
        if (goalMode) await expect(goalStatus(page.locator('[data-component="session-goal-dock"]'), "Paused")).toBeVisible()
        await fs.writeFile(releaseFile, "release")
        const followup = page.getByRole("textbox", { name: /Ask anything/i }).last()
        await expect(followup).toBeVisible()
        const nextMarker = `AFTER-${marker}`
        await composePrompt(page, followup, `Reply with exactly this one token: ${nextMarker}`)
        await expect(page.locator(SELECTORS.submitControl).last()).toHaveAccessibleName("Send")
        await page.locator(SELECTORS.submitControl).last().click()
        await expectAssistantReplyVisible(page, nextMarker)
        await expect(page).toHaveURL(sessionUrl)
        await page.reload({ waitUntil: "domcontentloaded" })
        await expectAssistantReplyVisible(page, nextMarker)
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
      await invoke("TaskUpdate", { taskId: created[0]!.id, status: "completed" })
      const progressMarker = await invoke("TaskUpdate", { taskId: created[1]!.id, status: "in_progress" }, true)
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
    for (const [decision, canonicalDirectory, restartServer, goalMode] of [
      ["Allow once", false, false, false], ["Allow always", false, false, false], ["Deny", false, false, false], ["Stop", false, false, false],
      ...(harness === "codex" ? [["Stop", false, false, true] as const] : []),
      ...(harness === "claude" ? [["Allow always", true, false, false] as const] : []),
      ...(harness === "codex" ? [["Allow always", false, true, false] as const] : []),
      ...(harness === "codex" ? [["Allow always", false, "idle", false] as const] : []),
    ] as const) {
      test(`${harness} native permission ${decision} gates a real file write after reload${canonicalDirectory ? " with a canonical directory" : ""}${restartServer === "idle" ? " and native idle disposal" : restartServer ? " and server restart" : ""}${goalMode ? " in Goal mode" : ""}`, async ({ page }) => {
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
          if (decision === "Stop") {
            await stopPendingPermission(page, {
              backendUrl: BACKEND_URL, directory: dir,
              sessionId: new URL(sessionUrl).pathname.split("/").at(-1)!,
            })
            expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
            if (goalMode) {
              const goalDock = page.locator('[data-component="session-goal-dock"]')
              await expect(goalStatus(goalDock, "Paused")).toBeVisible({ timeout: 30_000 })
            }
            const followup = `AFTER-STOP-${Date.now()}`
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
