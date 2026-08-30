/**
 * The B/C/D/E scenario bodies both web lanes drive — `web-signed-cloud.spec.ts`
 * (`access: "cloud"`) and `web-signed-userhosted.spec.ts`
 * (`access: "user-hosted"`) — from `docs/plans/2026-08-06-001-test-full-matrix-
 * real-e2e-plan.md`'s Phase 4 lane x scenario matrix. Written once here so
 * neither spec file duplicates journey logic (Phase 4's own checklist item),
 * on top of Phase 1's oracles (`rail-oracle.ts`, `geometry-oracle.ts`,
 * `surface-parity.ts`, `turn-oracle.ts`) and this task's own
 * `web-signed-relay-harness.ts` primitives.
 *
 * Every function takes a `JourneyCtx` (an already-booted fixture + a fresh
 * Playwright `page`) and performs its OWN navigation — a spec file's test
 * body is therefore exactly one call into this module, matching the plan's
 * "thin configuration wrapper" mandate literally, not just in spirit.
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
import { closeSidebar, expectSurfaceStatus, focusSwitcherTab, type SurfaceStatus } from "./surface-parity"
import { expectAssistantReplyVisible } from "./turn-oracle"
import type { ScriptedModelServer } from "./scripted-model-server"
import {
  composerInput,
  composeText,
  createShellTerminal,
  gateReachesReady,
  selectScriptedModel,
  seedWorkspace,
  sendSubsequentMessage,
  sessionRoute,
  submitControl,
  submitDraft,
  type RelayFixtureInfo,
  type SignedRelayAccess,
} from "./web-signed-relay-harness"

export type JourneyCtx = {
  page: Page
  frontendUrl: string
  info: RelayFixtureInfo
  scripted: ScriptedModelServer
  /** Spec basename for `turn-oracle`'s evidence path, e.g. "web-signed-cloud". */
  spec: string
  kind: SignedRelayAccess
}

/**
 * The project/workspace header's "New session in <label>" affordance
 * (`rail-sidebar.tsx:1568`) — present for EVERY workspace kind (project or
 * workspace scope alike, `input.scope` only changes the terminal button's
 * behavior, not this one), unlike `desktop-unsigned-embedded.spec.ts`'s
 * git-branch-specific `[aria-label="New session in main"]`.
 *
 * NOT scoped by a client-seeded `data-project-id`, deliberately — MEASURED
 * live 2026-08-06: for a SIGNED (relay-backed) workspace the rail's project
 * label and grouping come from the real signed-bootstrap inventory
 * (`signed-browser-relay-fixture.mjs`'s `projectId = "proj_signed_browser_
 * relay"` / `displayName: "Signed Browser Relay"`), which OVERRIDES whatever
 * project id/name `seedWorkspace`'s client-side localStorage seed proposed —
 * unlike `real-cloud-relay.spec.ts`'s/`live-user-hosted-relay.spec.ts`'s
 * single-session journeys, which never needed to locate this button at all
 * and so never surfaced the mismatch. Header actions are mounted only while
 * their owner is engaged. The signed fixture has one canonical project
 * header, so engage and scope to that owner before resolving its action; a
 * page-wide button lookup cannot observe an action that does not exist at
 * rest.
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
  const { page, frontendUrl, info, kind } = ctx
  await seedWorkspace(page, info, kind)
  await page.goto(`${frontendUrl}${sessionRoute(info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await gateReachesReady(page)
  // The relay fixture is shared by this spec's tests, so the workspace can
  // already have sessions even though each browser context is fresh. Enter a
  // draft through the product's canonical New Session action instead of
  // relying on the bare workspace route to remain a draft forever.
  return openNewDraftInProject(page)
}

function marker(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

async function promptText(text: string) {
  return `Reply with exactly this one token, nothing else: ${text}`
}

// ---------------------------------------------------------------------------
// A2 / A3 — shell integrity
// ---------------------------------------------------------------------------

/** A2: reload mid-session still renders the transcript AND a subsequent send completes a full turn. */
export async function journeyA2(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  scripted.resetCounts()
  const m1 = marker("A2T1")
  // Compose-then-select, NOT select-then-compose — measured live 2026-08-06:
  // an earlier draft of this journey "fixed" this ordering to match `journeyA3`'s
  // real bug (see that journey's own note), which turned out to be the WRONG
  // generalization — this exact compose-then-select order is what the very
  // first successful run of this whole suite used for A2 specifically, and
  // switching it produced a NEW, reproducible failure (session creation
  // never reaching the server at all, confirmed by an empty fixture request
  // log at the moment of failure — not a UI timing flake). Left as the
  // ORIGINAL, working order; A3's fix does not generalize here.
  await composeText(page, input, await promptText(m1))
  await selectScriptedModel(page)
  await submitDraft(page)
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a2-before-reload" })

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({ timeout: 30_000 })
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a2-after-reload-transcript" })

  const m2 = marker("A2T2")
  await composeText(page, composerInput(page), await promptText(m2))
  await sendSubsequentMessage(page)
  await expectAssistantReplyVisible(page, new RegExp(m2), { spec: ctx.spec, scenario: "a2-after-reload-turn2" })
}

/**
 * A3: a COLD deep link `/w/<ws>/session/<id>` loads that session. Unlike the
 * desktop lane (whose `file://` renderer runs on Solid Router's `MemoryRouter`
 * and has no URL to deep-link into at all — see `desktop-unsigned-embedded
 * .spec.ts`'s test.fixme note), a web lane's document IS the real URL
 * (`urlRoutingEnabled()` is true for any http(s) document,
 * `src/lib/runtime-mode.ts:14-29`), so this scenario is genuinely testable
 * here — the one place in the whole matrix it can be.
 */
export async function journeyA3(ctx: JourneyCtx) {
  const { page, frontendUrl, info, scripted } = ctx
  const input = await openReadyDraft(ctx)
  // Model selected BEFORE composing — every OTHER journey in this file does
  // the same and is stable; composing first was this journey's original,
  // untested draft and measured live 2026-08-06 to make the harness/model
  // popover intermittently never open (a real timing interaction between
  // composer-text state and the picker, not investigated further since the
  // fix is free — there is no product reason A3 needs the opposite order).
  await selectScriptedModel(page)
  scripted.resetCounts()
  const m1 = marker("A3")
  await composeText(page, input, await promptText(m1))
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a3-seed" })

  // A genuinely COLD document navigation, not a client-side route push from
  // an already-hydrated app. The context is retained intentionally because
  // its signed bootstrap and workspace seed are part of the authenticated lane.
  const deepLinkUrl = `${frontendUrl}/w/${encodeURIComponent(info.workspaceId)}/session/${encodeURIComponent(sessionId)}`
  await page.goto(deepLinkUrl, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await expect(page.locator("[data-claxedo]"), "shell never painted on the cold deep link").toBeVisible({
    timeout: 30_000,
  })
  await expectAssistantReplyVisible(page, new RegExp(m1), { spec: ctx.spec, scenario: "a3-cold-deep-link" })
}

// ---------------------------------------------------------------------------
// B — session lifecycle & rail
// ---------------------------------------------------------------------------

/** B1/B2/B3/B4: a new session's row appears live, completes a turn, auto-titles, accepts a second message. */
export async function journeyB1toB4(ctx: JourneyCtx) {
  const { page, info, scripted } = ctx
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
    'defect 9 / open issue #16: the second send is refused ("Select an agent and model")',
  ).not.toHaveAttribute("aria-label", /select an agent/i)
  await sendSubsequentMessage(page)
  await expectAssistantReplyVisible(page, m2, { spec: ctx.spec, scenario: "b4-second-turn" })

  expect(
    scripted.counts().chat,
    "fewer scripted chat calls than expected — a turn silently answered from elsewhere",
  ).toBeGreaterThanOrEqual(3)
  void info
}

/** B5/B6: re-prompting an older row (index >= 3) bumps it to the top, and its row stays unique. */
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

  const target = sessionIds[0]!
  await expectRailRowVisible({ page, sessionId: target, index: 3 })

  await page.locator(RAIL_SELECTORS.sessionRow(target)).click()
  await composeText(page, composerInput(page), "Reply with exactly this one token, nothing else: B5_REPROMPT")
  await sendSubsequentMessage(page)

  await expectRailRowMovesToTop({ page, sessionId: target })
  await expectRailRowUnique({ page, sessionId: target })
  await expectAssistantReplyVisible(page, "B5_REPROMPT", { spec: ctx.spec, scenario: "b5-repromt-reply" })
}

/** B7: the background status dot transitions working -> done on a row mounted while idle and never focused. */
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

/** B8: reload preserves rail title, order, and status. */
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

/** B9: sidebar and compact-switcher status dots agree, including a transition on an already-mounted tab. */
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
  await pollSurfaceStatus({ page, sessionId, expected: "idle" })

  scripted.resetCounts()
  scripted.setReplyDelayMs(1_500)
  try {
    await focusSwitcherTab(page, sessionTitle)
    await expect(page.locator('[data-component="session-composer"]:visible')).toBeVisible({ timeout: 10_000 })
    await composeText(page, composerInput(page), "Reply with exactly this one token, nothing else: B9_MARK2")
    await sendSubsequentMessage(page)
    await expect.poll(
      () => Object.values(scripted.counts()).reduce((total, count) => total + count, 0),
      { message: "scripted provider never received B9's delayed second turn", timeout: 10_000 },
    ).toBeGreaterThan(0)
    await focusSwitcherTab(page, "New Session")
    await expect(page.locator('[data-component="session-new-composer"]:visible')).toBeVisible({ timeout: 10_000 })

    await pollSurfaceStatus({ page, sessionId, expected: "working" })
    await pollSurfaceStatus({ page, sessionId, expected: "done" })
  } finally {
    scripted.setReplyDelayMs(0)
  }
}

/** Same poll wrapper `desktop-unsigned-embedded.spec.ts` uses — see that file's doc for why a bare single-shot check races a real busy/idle transition by a beat. */
async function pollSurfaceStatus(opts: { page: Page; sessionId: string; expected: SurfaceStatus }, timeoutMs = 15_000) {
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
// C — composer & harness
// ---------------------------------------------------------------------------

/**
 * C1: a new draft resolves harness/model within 5s with no reload needed.
 * Checked on the unified `[data-action="prompt-harness-model"]` trigger used
 * by every harness, including OpenCode.
 */
export async function journeyC1(ctx: JourneyCtx) {
  const { page } = ctx
  const input = await openReadyDraft(ctx)
  const control = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(
    control,
    'open issue #15: draft stuck on "Loading models" (or blank) past 5s with no reload',
  ).not.toContainText(/Loading models|^$/, { timeout: 5_000 })

  await composeText(page, input, "Reply with exactly this one token, nothing else: C1_MARK")
  await selectScriptedModel(page)
  await expect(submitControl(page), "submit never enabled after composing text, with no reload performed").toBeEnabled({
    timeout: 5_000,
  })
}

/**
 * C4: switching harness survives a reload and completes a second turn.
 *
 * `selectScriptedModel` moves the draft onto the injected Tier R harness
 * through the unified picker. The selected harness is then locked to the
 * created session and must survive reload before the second turn.
 */
export async function journeyC4(ctx: JourneyCtx) {
  const { page, scripted } = ctx
  const input = await openReadyDraft(ctx)
  scripted.resetCounts()

  await selectScriptedModel(page)

  const m1 = marker("C4T1")
  await composeText(page, input, await promptText(m1))
  const sessionId = await submitDraft(page)
  await expectAssistantReplyVisible(page, m1, { spec: ctx.spec, scenario: "c4-turn1" })

  const harnessTriggerBefore = page.locator('[data-action="prompt-harness-model"]:visible').last()
  const labelBefore = ((await harnessTriggerBefore.textContent()) ?? "").trim()
  expect(labelBefore, "harness+model trigger stuck on Loading models/blank before reload").not.toMatch(
    /Loading models|^$/,
  )

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]"), "shell never repainted after reload").toBeVisible({ timeout: 30_000 })

  // Harness/model trigger same + real model name, never "Loading models"/empty
  // (open issue #15), matching `core-harness-ownership-*`'s "locked once a
  // session exists" contract, proven here against a real backend.
  const harnessTriggerAfter = page.locator('[data-action="prompt-harness-model"]:visible').last()
  await expect(harnessTriggerAfter, "harness+model trigger label changed across reload").toContainText(labelBefore, {
    timeout: 20_000,
  })
  await expect(
    harnessTriggerAfter,
    'open issue #15: harness+model trigger stuck on "Loading models" (or blank) after reload',
  ).not.toContainText(/Loading models|^$/, { timeout: 20_000 })

  const m2 = marker("C4T2")
  await composeText(page, composerInput(page), await promptText(m2))
  await sendSubsequentMessage(page)
  await expectAssistantReplyVisible(page, m2, { spec: ctx.spec, scenario: "c4-turn2" })

  expect(
    scripted.counts().chat,
    "second turn never reached the scripted endpoint — the harness silently fell back to another provider",
  ).toBeGreaterThanOrEqual(1)

  await expectRailRowUnique({ page, sessionId })
  await expectRailTitleSettled({ page, sessionId })
  await expectRailRowVisible({ page, sessionId, index: 0 })
}

// ---------------------------------------------------------------------------
// D — terminal, folded with E1's geometry proof (same pairing `desktop-
// unsigned-embedded.spec.ts` uses: geometry needs both a session row and a
// terminal row on screen at once, so D1-D3 and E1 share one journey).
// ---------------------------------------------------------------------------

/** D1/D2/D3/E1: a real terminal streams a live prompt, its rail row settles, and row geometry matches session rows. */
export async function journeyD1toD3E1(ctx: JourneyCtx) {
  const { page, scripted, frontendUrl, info } = ctx
  await openReadyDraft(ctx)
  await selectScriptedModel(page)
  scripted.resetCounts()

  // Force xterm's DOM renderer BEFORE opening any terminal — the default is a
  // WebGL/canvas renderer whose painted pixels a `page.locator` cannot read as
  // text, matching `desktop-unsigned-embedded.spec.ts`'s identical finding for
  // this same component (`renderer.ts`'s `rendererPreference()` reads plain
  // `localStorage`, not the `Persist`/electron-store system, so this is
  // surface-agnostic — it is not a desktop-only escape hatch).
  await page.evaluate(() => localStorage.setItem("opencode.terminal.renderer", "dom"))

  const terminalId = await createShellTerminal(page)

  // D1: streams a live prompt within 10s and never matches /Reconnecting.../.
  const pane = page.locator(`[data-testid="terminal-pane"][data-terminal-id="${terminalId}"]`)
  await expect(pane, "terminal pane never mounted").toBeVisible({ timeout: 10_000 })
  const xtermRows = pane.locator(".xterm-rows").first()
  await expect(
    xtermRows,
    "no DOM-rendered terminal content within 10s — see defects 4/5/6/7 / open issue #17 (terminal creation hangs)",
  ).toHaveText(/\S/, { timeout: 10_000 })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const text = (await xtermRows.innerText().catch(() => "")) ?? ""
    expect(text, "defect 4: terminal buffer shows a Reconnecting banner").not.toMatch(/Reconnecting\.\.\. \d\/6/)
    await page.waitForTimeout(500)
  }

  // D2: rail row shows working then settles — proven here by the row simply
  // existing and (eventually) losing any error/reconnecting affordance; the
  // richer working->done proof for a SESSION row is B7's job, and a terminal
  // row's own status semantics are `[data-terminal-id]` presence + no
  // reconnect banner, which the loop above already covers over the full 10s.
  await expect(
    page.locator(RAIL_SELECTORS.terminalRow(terminalId)),
    "terminal never gained a stable rail row",
  ).toBeVisible({ timeout: 10_000 })

  // D3/E1: create a session too, so the geometry oracle has both row kinds to compare.
  // Creating a terminal makes its pane active and intentionally hides the
  // draft composer. Return through the real session route before typing; a
  // retained hidden composer is not an interactive submit target.
  await page.goto(`${frontendUrl}${sessionRoute(info)}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
  await gateReachesReady(page)
  const input = await openNewDraftInProject(page)
  await selectScriptedModel(page)
  await composeText(page, input, "Reply with exactly this one token, nothing else: D3_MARK")
  await submitDraft(page)
  await expectRowGeometry({ page, evidence: { spec: ctx.spec, scenario: "d3-e1-row-geometry" } })
}

// ---------------------------------------------------------------------------
// F — transport proof (F2 user-hosted / F3 cloud, per the lane's own kind).
// Every scenario above already rides the real relay; this journey is the
// EXPLICIT negative-space proof that nothing bypassed it, mirroring
// `real-cloud-relay.spec.ts` behavior 5 / `live-user-hosted-relay.spec.ts`
// behavior 8.
// ---------------------------------------------------------------------------

function isForbiddenDirectPath(pathname: string) {
  return (
    /^\/(session|file|config|mcp|agent|command|permission|question)(\/|$)/.test(pathname) ||
    pathname === "/global/dispose" ||
    pathname === "/global/event" ||
    pathname === "/event" ||
    /^\/api\/claxedo\/(pty|process|diff|hook)(?:\/|$)/.test(pathname)
  )
}

export function watchForbiddenDirectRequests(page: Page, backendOrigin: string, hits: string[] = []) {
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin !== backendOrigin) return
    if (isForbiddenDirectPath(url.pathname)) {
      const directory = request.headers()["x-opencode-directory"]
      hits.push(`${request.method()} ${url.pathname}${url.search}${directory ? ` [directory=${directory}]` : ""}`)
    }
  })
  return hits
}
