/**
 * Journeys shared by `web-signed-cloud.spec.ts` and `web-signed-host-tunnel.spec.ts`.
 * Each takes a `JourneyCtx` (booted fixture + fresh page) and does its own navigation,
 * so a spec's test body is one call into this module.
 */
import { expect, type Locator, type Page } from "@playwright/test"
import {
  expectRailRowMovesToTop,
  expectRailRowUnique,
  expectRailRowVisible,
  expectRailStatus,
  expectRailTitleSettled,
  SELECTORS as RAIL_SELECTORS,
} from "./rail-oracle"
import { expectRowGeometry } from "./geometry-oracle"
import {
  activeSwitcherContentId,
  closeSidebar,
  expectSurfaceStatus,
  focusSwitcherTab,
  type SurfaceStatus,
} from "./surface-parity"
import { expectAssistantReplyVisible } from "./turn-oracle"
import type { ScriptedModelServer } from "./scripted-model-server"
import {
  composerInput,
  composeText,
  createShellTerminal,
  ensureWorkspaceSectionExpanded,
  gateReachesReady,
  selectScriptedModel,
  selectSignedHarness,
  seedWorkspace,
  sendSubsequentMessage,
  sessionRoute,
  submitControl,
  submitDraft,
  type RelayFixtureInfo,
  type SignedRelayBacking,
} from "./web-signed-relay-harness"

export type JourneyCtx = {
  page: Page
  frontendUrl: string
  info: RelayFixtureInfo
  scripted: ScriptedModelServer
  /** Spec basename for `turn-oracle`'s evidence path, e.g. "web-signed-cloud". */
  spec: string
  backing: SignedRelayBacking
}

/**
 * Clicks the project header's "New session in <label>" action and returns the new draft's
 * composer input. Header actions mount only while the header is hovered, so the header is
 * engaged first. The button is matched by role name, not a seeded project id: the signed
 * bootstrap inventory overrides the client-seeded project label.
 */
async function openNewDraftInProject(page: Page): Promise<Locator> {
  const header = page.locator('[data-testid="project-header"]:visible').first()
  await expect(header, "the signed workspace project header never appeared").toBeVisible({ timeout: 15_000 })
  await header.hover()
  const newSessionBtn = header.getByRole("button", { name: /^New session in /i }).first()
  await expect(newSessionBtn, 'the project header\'s "New session in ..." affordance never appeared').toBeVisible({
    timeout: 15_000,
  })
  await newSessionBtn.click()
  const newComposer = page.locator('[data-component="session-new-composer"]:visible').last()
  await expect(newComposer, 'draft composer never appeared after "New session in ..."').toBeVisible({ timeout: 20_000 })
  const input = newComposer.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input, "draft composer input never became interactive").toHaveAttribute("contenteditable", "true")
  return input
}

/** Navigates fresh to the workspace-scoped draft route and waits for the connect gate — every journey's entry point. */
async function openReadyDraft(ctx: JourneyCtx): Promise<Locator> {
  const { page, frontendUrl, info, backing } = ctx
  await seedWorkspace(page, info, backing)
  await page.goto(`${frontendUrl}${sessionRoute(info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await gateReachesReady(page)
  // The relay fixture is shared across tests, so the workspace may already have sessions;
  // once the gate is ready, the draft route's composer is still the submit target.
  return composerInput(page)
}

function marker(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

async function promptText(text: string) {
  return `Reply with exactly this one token, nothing else: ${text}`
}

// ---------------------------------------------------------------------------
// Shell integrity
// ---------------------------------------------------------------------------

/** Reload mid-session still renders the transcript AND a subsequent send completes a full turn. */
export async function journeyA2(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  scripted.resetCounts()
  const m1 = marker("A2T1")
  await composeText(page, input, await promptText(m1))
  await selectScriptedModel(page)
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a2-before-reload" })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({ timeout: 30_000 })
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a2-after-reload-transcript" })

  const m2 = marker("A2T2")
  await composeText(page, composerInput(page), await promptText(m2))
  await sendSubsequentMessage(page)
  await expectAssistantReplyVisible(page, new RegExp(m2), { spec: ctx.spec, scenario: "a2-after-reload-turn2" })

  const historyResponse = await fetch(
    `${ctx.info.relayUrl}/workspaces/${ctx.info.workspaceId}/session/${sessionId}/message`,
    { headers: { Authorization: `Bearer ${ctx.info.runtimeAccessToken}` } },
  )
  expect(historyResponse.status).toBe(200)
  const history = await historyResponse.json() as Array<{
    info: { role: string }
    parts: Array<{ type: string; text?: string }>
  }>
  const userText = history.filter((message) => message.info.role === "user")
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text))
  expect(userText).toEqual([await promptText(m1), await promptText(m2)])
  expect(scripted.requests.filter((request) => request.dialect === "responses"
    && request.reply.kind === "text" && [m1, m2].includes(request.reply.text))).toHaveLength(2)
}

/**
 * A cold deep link `/w/<ws>/session/<id>` loads that session. Only a web lane can test
 * this: the desktop `file://` renderer runs on a MemoryRouter and has no URL.
 */
export async function journeyA3(ctx: JourneyCtx) {
  const { page, frontendUrl, info, scripted } = ctx
  const input = await openReadyDraft(ctx)
  // Select the model before composing; composing first intermittently keeps the
  // harness/model popover from opening.
  await selectScriptedModel(page)
  scripted.resetCounts()
  const m1 = marker("A3")
  await composeText(page, input, await promptText(m1))
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a3-seed" })

  // A document navigation, not a client-side route push; the context keeps its signed
  // bootstrap and workspace seed.
  const deepLinkUrl = `${frontendUrl}/w/${encodeURIComponent(info.workspaceId)}/session/${encodeURIComponent(sessionId)}`
  await page.goto(deepLinkUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await expect(page.locator("[data-claxedo]"), "shell never painted on the cold deep link").toBeVisible({
    timeout: 30_000,
  })
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a3-cold-deep-link" })
}

// ---------------------------------------------------------------------------
// Session lifecycle & rail
// ---------------------------------------------------------------------------

/** A new session's row appears live, completes a turn, auto-titles, accepts a second message. */
export async function journeyB1toB4(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  const m1 = marker("B1B2")
  await composeText(page, input, await promptText(m1))

  const sessionId = await submitDraft(page)
  await expectRailRowVisible({ page, sessionId, index: 0 })
  await expectAssistantReplyVisible(page, m1, { spec: ctx.spec, scenario: "b2-first-turn" })

  const settledTitle = await expectRailTitleSettled({ page, sessionId })
  expect(settledTitle.length, "settled rail title is empty").toBeGreaterThan(0)

  const m2 = marker("B4")
  await composeText(page, composerInput(page), await promptText(m2))
  await expect(
    submitControl(page),
    'the second send is refused ("Select an agent and model")',
  ).not.toHaveAttribute("aria-label", /select an agent/i)
  await sendSubsequentMessage(page)
  await expectAssistantReplyVisible(page, m2, { spec: ctx.spec, scenario: "b4-second-turn" })

  expect(scripted.requests.filter((request) => request.dialect === "responses"
    && request.reply.kind === "text" && [m1, m2].includes(request.reply.text))).toHaveLength(2)
}

/** Re-prompting an older row (index >= 3) bumps it to the top, and its row stays unique. */
export async function journeyB5B6(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  let input = await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  const sessionIds: string[] = []
  for (let i = 0; i < 4; i++) {
    if (i > 0) input = await openNewDraftInProject(page)
    if (i > 0) await selectScriptedModel(page)
    const m = marker(`B5SEED${i}`)
    await composeText(page, input, await promptText(m))
    const sessionId = await submitDraft(page)
    await expectAssistantReplyVisible(page, m, { spec: ctx.spec, scenario: `b5-seed-${i}` })
    sessionIds.push(sessionId)
  }

  const target = sessionIds[0]
  await expectRailRowVisible({ page, sessionId: target, index: 3 })

  await page.locator(RAIL_SELECTORS.sessionRow(target)).click()
  await composeText(page, composerInput(page), "Reply with exactly this one token, nothing else: B5_REPROMPT")
  await sendSubsequentMessage(page)

  await expectRailRowMovesToTop({ page, sessionId: target })
  await expectRailRowUnique({ page, sessionId: target })
  await expectAssistantReplyVisible(page, "B5_REPROMPT", { spec: ctx.spec, scenario: "b5-repromt-reply" })
}

/** The background status dot transitions working -> done on a row mounted while idle and never focused. */
export async function journeyB7(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const inputA = await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  await composeText(page, inputA, "Reply with exactly this one token, nothing else: B7_A1")
  const sessionA = await submitDraft(page)
  await expectAssistantReplyVisible(page, "B7_A1", { spec: ctx.spec, scenario: "b7-seed-a" })
  const rowA = page.locator(RAIL_SELECTORS.sessionRow(sessionA))
  await expect(
    rowA.locator(RAIL_SELECTORS.statusDot),
    "session A never returned to idle after its first turn settled",
  ).toHaveCount(0, { timeout: 15_000 })

  const inputB = await openNewDraftInProject(page)
  await selectScriptedModel(page)
  await composeText(page, inputB, "Reply with exactly this one token, nothing else: B7_B1")
  const sessionB = await submitDraft(page)
  await expectAssistantReplyVisible(page, "B7_B1", { spec: ctx.spec, scenario: "b7-seed-b" })

  await expect(
    rowA.locator(RAIL_SELECTORS.statusDot),
    "session A picked up a stray status dot while session B was being seeded",
  ).toHaveCount(0, { timeout: 15_000 })

  await expectRailStatus({
    page,
    sessionId: sessionA,
    driveWorking: async () => {
      await rowA.click()
      await composeText(page, composerInput(page), "Reply with exactly this one token, nothing else: B7_A2")
      await sendSubsequentMessage(page)
      await page.locator(RAIL_SELECTORS.sessionRow(sessionB)).click()
    },
    driveDone: async () => {
      // No action: the turn completes server-side regardless of focus.
    },
  })
}

/** Reload preserves rail title, order, and status. */
export async function journeyB8(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  await composeText(page, input, "Reply with exactly this one token, nothing else: B8_MARK")
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, "B8_MARK", { spec: ctx.spec, scenario: "b8-seed" })
  const titleBefore = await expectRailTitleSettled({ page, sessionId })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({ timeout: 30_000 })

  await expectRailRowVisible({ page, sessionId, index: 0 })
  const titleAfter = await expectRailTitleSettled({ page, sessionId })
  expect(titleAfter, "rail title changed across a reload with no new activity").toBe(titleBefore)
  await expect(
    page.locator(RAIL_SELECTORS.sessionRow(sessionId)).locator(RAIL_SELECTORS.statusDot),
    "a settled session should not show a stale busy dot after reload",
  ).toHaveCount(0)
}

/** Sidebar and compact-switcher status dots agree, including a transition on an already-mounted tab. */
export async function journeyB9(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  await composeText(page, input, "Reply with exactly this one token, nothing else: B9_MARK")
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, "B9_MARK", { spec: ctx.spec, scenario: "b9-seed" })
  const sessionTitle = await expectRailTitleSettled({ page, sessionId })
  await expect(
    page.locator(RAIL_SELECTORS.sessionRow(sessionId)).locator(RAIL_SELECTORS.statusDot),
    "session should have settled back to idle before the parity check",
  ).toHaveCount(0, { timeout: 15_000 })

  // Keep a second, focused draft mounted. A completed turn is intentionally
  // marked "done" only when it settles while unfocused; the focused session
  // has already seen its result and correctly returns to idle.
  await openNewDraftInProject(page)
  await closeSidebar(page)
  const draftContentId = await activeSwitcherContentId(page)
  await pollSurfaceStatus({ page, sessionId, expected: "idle" })

  scripted.resetCounts()
  scripted.setReplyDelayMs(8_000)
  try {
    await focusSwitcherTab(page, sessionTitle)
    await expect(page.locator('[data-component="session-composer"]:visible')).toBeVisible({ timeout: 10_000 })
    await composeText(page, composerInput(page), "Reply with exactly this one token, nothing else: B9_MARK2")
    await sendSubsequentMessage(page)
    await expect(
      submitControl(page),
      "second turn never entered a busy state before the focus switch",
    ).toHaveAttribute("aria-label", /stop/i, { timeout: 10_000 })
    // Switch away while the 8s scripted delay keeps the turn in flight.
    await focusSwitcherTab(page, { contentId: draftContentId, title: "New Session" })
    await expect(page.locator('[data-component="session-new-composer"]:visible')).toBeVisible({ timeout: 10_000 })
    await expect.poll(
      () => Object.values(scripted.counts()).reduce((total, count) => total + count, 0),
      { message: "scripted provider never received the delayed second turn", timeout: 10_000 },
    ).toBeGreaterThan(0)
    await pollSurfaceStatus({ page, sessionId, expected: "working" })
    await pollSurfaceStatus({ page, sessionId, expected: "done" }, 20_000)
  } finally {
    scripted.setReplyDelayMs(0)
  }
}

/** Retries `expectSurfaceStatus` until `timeoutMs`; a single-shot check races a live busy/idle transition. */
async function pollSurfaceStatus(opts: { page: Page; sessionId: string; expected: SurfaceStatus }, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await expectSurfaceStatus(opts)
    } catch (err) {
      if (Date.now() > deadline) throw err
      await opts.page.waitForTimeout(300)
    }
  }
}

// ---------------------------------------------------------------------------
// Composer & harness
// ---------------------------------------------------------------------------

/**
 * A new draft resolves harness/model within 5s with no reload needed.
 * Checked on the unified `[data-action="prompt-harness-model"]` trigger used
 * by every harness, including OpenCode.
 */
export async function journeyC1(ctx: JourneyCtx) {
  const { page } = ctx
  const input = await openReadyDraft(ctx)
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(
    control,
    'draft stuck on "Loading models" (or blank) past 5s with no reload',
  ).not.toContainText(/Loading models|^$/, { timeout: 5_000 })

  await composeText(page, input, "Reply with exactly this one token, nothing else: C1_MARK")
  await selectScriptedModel(page)
  await expect(submitControl(page), "submit never enabled after composing text, with no reload performed").toBeEnabled({
    timeout: 5_000,
  })
}

/**
 * Switching harness survives a reload and completes a second turn.
 *
 * Select Pi first, then switch to Claude through the unified picker. Both
 * turns must use Claude's Anthropic endpoint and retain that harness on reload.
 */
export async function journeyC4(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  scripted.resetCounts()

  await selectScriptedModel(page)
  await selectSignedHarness(page, "Claude", "claude")
  const trigger = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(trigger).not.toContainText(/Select model|Loading models/i, { timeout: 45_000 })

  const m1 = marker("C4T1")
  await composeText(page, input, await promptText(m1))
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, m1, { spec: ctx.spec, scenario: "c4-turn1" })

  const harnessTriggerBefore = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(harnessTriggerBefore).toHaveAttribute("data-harness", "claude")
  const labelBefore = ((await harnessTriggerBefore.textContent()) ?? "").trim()
  expect(labelBefore, "harness+model trigger stuck on Loading models/blank before reload").not.toMatch(
    /Loading models|^$/,
  )

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({ timeout: 30_000 })

  // Same harness and a real model name after reload, never "Loading models"/empty.
  const harnessTriggerAfter = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(harnessTriggerAfter).toHaveAttribute("data-harness", "claude")
  await expect(harnessTriggerAfter, "harness+model trigger label changed across reload").toContainText(labelBefore, {
    timeout: 20_000,
  })
  await expect(
    harnessTriggerAfter,
    'harness+model trigger stuck on "Loading models" (or blank) after reload',
  ).not.toContainText(/Loading models|^$/, { timeout: 20_000 })

  const m2 = marker("C4T2")
  await composeText(page, composerInput(page), await promptText(m2))
  await sendSubsequentMessage(page)
  await expectAssistantReplyVisible(page, m2, { spec: ctx.spec, scenario: "c4-turn2" })

  expect(
    scripted.requests.filter((request) => request.dialect === "messages"
      && request.reply.kind === "text" && (request.reply.text === m1 || request.reply.text === m2)).length,
    "both switched-harness turns must reach the Anthropic endpoint",
  ).toBe(2)
  expect(scripted.counts().responses, "the draft must not execute on its previous Pi harness").toBe(0)

  await expectRailRowUnique({ page, sessionId })
  await expectRailTitleSettled({ page, sessionId })
  await expectRailRowVisible({ page, sessionId, index: 0 })
}

// ---------------------------------------------------------------------------
// Terminal, folded with the row-geometry check: geometry needs a session row
// and a terminal row on screen at once.
// ---------------------------------------------------------------------------

/** A real terminal streams a live prompt, its rail row settles, and row geometry matches session rows. */
export async function journeyD1toD3E1(ctx: JourneyCtx) {
  const { page, scripted, frontendUrl, info } = ctx
  const seedInput = await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  // Managed (signed) PTY creation requires a sessionId on the authority path
  // (`workspace-runtime` `pty_session_id_required`). Create a real session first
  // and keep it focused so the Shell launcher can bind the PTY to it — otherwise
  // the rail stays on `pending-*` with "Terminal failed to start".
  await composeText(page, seedInput, "Reply with exactly this one token, nothing else: D0_SESSION")
  await submitDraft(page)
  await expectAssistantReplyVisible(page, "D0_SESSION", { spec: ctx.spec, scenario: "d0-session-for-pty" })

  // Force xterm's DOM renderer before opening a terminal: the default canvas/WebGL
  // renderer's pixels cannot be read as text. `rendererPreference()` reads plain localStorage.
  await page.evaluate(() => localStorage.setItem("claxedo.terminal.renderer", "dom"))

  const terminalId = await createShellTerminal(page)

  // Terminal creation: streams a live prompt within 30s and never matches /Reconnecting.../.
  const pane = page.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"]`)
  await expect(pane, "terminal pane never mounted").toBeVisible({ timeout: 15_000 })
  await pane.click()
  const xtermRows = pane.locator(".xterm-rows").first()
  const xtermDeadlineMs = 30_000
  await expect.poll(
    async () => (await xtermRows.innerText().catch(() => "")).replace(/\s+/g, " ").trim(),
    {
      message:
        "no DOM-rendered terminal content within 30s",
      timeout: xtermDeadlineMs,
    },
  ).toMatch(/\S/)

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const text = (await xtermRows.innerText().catch(() => "")) ?? ""
    expect(text, "terminal buffer shows a Reconnecting banner").not.toMatch(/Reconnecting\.\.\. \d\/6/)
    await page.waitForTimeout(500)
  }

  // A terminal row's settled state is its presence with no reconnect banner (checked
  // over 10s above); the working -> done proof for a session row is `journeyB7`.
  await ensureWorkspaceSectionExpanded(page, info)
  await expect(
    page.locator(RAIL_SELECTORS.terminalRow(terminalId)),
    "terminal never gained a stable rail row",
  ).toBeVisible({ timeout: 10_000 })

  // Creating a terminal makes its pane active and hides the draft composer; return through
  // the session route and create a session so the geometry oracle has both row kinds.
  await page.goto(`${frontendUrl}${sessionRoute(info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await gateReachesReady(page)
  const input = await openNewDraftInProject(page)
  await selectScriptedModel(page)
  await composeText(page, input, "Reply with exactly this one token, nothing else: D3_MARK")
  await submitDraft(page)
  await expectRowGeometry({ page, evidence: { spec: ctx.spec, scenario: "d3-e1-row-geometry" } })
}

// ---------------------------------------------------------------------------
// Transport proof: nothing bypassed the relay to hit the backend origin directly.
// ---------------------------------------------------------------------------

function isForbiddenDirectPath(pathname: string) {
  return (
    /^\/(session|file|config|mcp|agent|command|permission|question)(\/|$)/.test(pathname) ||
    pathname === "/api/wr/events" ||
    /^\/api\/claxedo\/(pty|process|diff|hook)(?:\/|$)/.test(pathname)
  )
}

export function watchForbiddenDirectRequests(page: Page, backendOrigin: string, hits: string[] = []) {
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin !== backendOrigin) return
    if (isForbiddenDirectPath(url.pathname)) {
      const directory = request.headers()["x-claxedo-directory"]
      hits.push(`${request.method()} ${url.pathname}${url.search}${directory ? ` [directory=${directory}]` : ""}`)
    }
  })
  return hits
}
