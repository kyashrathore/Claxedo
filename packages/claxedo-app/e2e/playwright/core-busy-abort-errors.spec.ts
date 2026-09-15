/**
 * Busy turn lifecycle: the Thinking placeholder, Stop/abort, the interrupted divider, the
 * mid-turn retry banner, the error card, and the optimistic-status escalation ladder.
 * Clean first-send/reload/history behavior is `core-first-prompt-local` /
 * `core-turns-reload-recovery`; harness selection is `core-harness-ownership-local`. The
 * retry status is a plain `session.status` SSE event and is harness-agnostic.
 *
 * Facts these tests lean on (`session-status-dispatcher.ts`, `session-controller.ts`,
 * `message-timeline.data.ts`, under src/features/session):
 *   - Every `session.status` write carries `source: "optimistic" | "server"`, and ANY
 *     server-source write — whatever its value, even another "busy" — clears the
 *     escalation timers. A real backend's own busy ack is therefore already a
 *     reconciliation, which is why the ladder is normally invisible and why the ladder
 *     scenarios have to starve every status producer at once.
 *   - The ladder arms four real `setTimeout`s when an optimistic non-idle status is first
 *     set: redispatch 8s (silent bookkeeping), pending 20s ("Still working…"), long 45s
 *     ("This is taking a while" + Cancel), failed 300s ("unresponsive" + Cancel/Retry).
 *     Reaching a stage rewrites `session.status` to a synthetic `{type:"retry"}` without
 *     clearing the timer chain.
 *   - Two reconciliation paths run beside the SSE stream: accepted-prompt refresh on
 *     delays `[0, 600, 1200, 2400, 4000, 8000, 12000]`ms, and an active-turn poll of the
 *     bulk `/session/status` map that first fires ~60s after the turn goes active. In that
 *     map an absent session key is the wire representation of idle.
 *   - A turn is settled once its assistant message has `time.completed` or an `error`. The
 *     content slot's `aria-hidden` is `workingTurn(...)`, which does NOT require
 *     `session.status` to be idle — so a settled reply stays rendered while the status is
 *     still wrongly "busy" (e2e/INVARIANTS.md #2, the "stale-busy" regression this spec
 *     pins permanently). The composer's busy/"stoppable" state is a separate derivation
 *     that ignores settlement entirely: `status.type === "busy" || "retry"`.
 *   - SDK cancellation lives in the session's `lastTurn` and must name the assistant
 *     message. Native abort errors also produce interruption dividers. A stopped turn
 *     may have no reply text; its cancellation divider is that turn's visual oracle.
 *   - `[data-slot="session-turn-compaction"]` wraps BOTH the "Session compacted" and the
 *     interrupted dividers; only the child `[data-slot="compaction-part-label"]` carries
 *     text that tells them apart.
 *   - Enter on a blank composer while busy is an intentional no-op — `editor-keymap.ts`
 *     returns early on `deps.working() && deps.blank()`, pinned by its "busy-blank guards"
 *     unit case — so it neither submits nor aborts.
 *
 * Submit gating (e2e/INVARIANTS.md #4): the submit control's `data-icon` is the single
 * source of truth for busy vs ready, so readiness is never asserted via `waitForTimeout`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { writeFile } from "node:fs/promises"
import { sampleElementDuringAction } from "../helpers/geometry-oracle"
import { installMockRuntime, type MockMessageRow } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-busy-abort-errors"
const SESSION_ID = "ses_core_busy_abort_errors"

// The mock's default opencode model is already submit-ready, so pinning is not needed to
// dispatch; it is here so the assertions have a named model to match.
const PIN_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

const SELECTORS_retry = {
  banner: '[data-slot="session-turn-retry"]',
  message: '[data-slot="session-turn-retry-message"]',
} as const

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
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

/** Leaves the bulk `/session/status` request permanently unanswered.
 *
 * Answering it is itself a server-source reconciliation: `syncSessionMeta` reads
 * `status[sessionID]` out of that map and dispatches `session.status` from it, falling
 * back to idle when the key is absent — and an idle session IS an absent key on the wire.
 * So the moment the first-fold hydrate resolves, the turn is declared idle no matter how
 * busy it really is. Scenarios that must observe busy state, or that simulate a server
 * which never answers anything, leave the route unresolved; scenarios that only assert the
 * settled end state do not register it at all. */
async function neutralizeStatusPoll(page: Page) {
  await page.route("**/session/status**", () => {
    // Intentionally never fulfilled or continued — any resolved response, including the
    // mock's empty (= all idle) status map, is a premature reconciliation here.
  })
}

/** Accepts `prompt_async` with 204 and emits nothing after it, so the turn stays busy
 * until the test intervenes. Register after `installMockRuntime`: Playwright tries the
 * most recently added route first. */
async function silencePromptAsync(page: Page) {
  const state: { count: number; lastMessageID?: string } = { count: 0 }
  await page.route("**/session/*/prompt_async**", async (route) => {
    const type = route.request().resourceType()
    if (type !== "fetch" && type !== "xhr") return route.continue()
    state.count += 1
    try {
      const body = route.request().postDataJSON() as { messageID?: string }
      state.lastMessageID = body?.messageID
    } catch {
      // ignore — best-effort capture only
    }
    await route.fulfill({ status: 204, body: "" })
  })
  return state
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function sendPrompt(page: Page, input: Locator, text: string) {
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  // The composer's busy/"stop" indicator is derived from `sessionController`,
  // which returns `activeTurn()===false` unconditionally while the route's
  // sessionID is still "new"/undefined (session-controller.ts) — so
  // every busy assertion below is only meaningful once the URL has actually
  // moved onto the created session's route (mirrors core-first-prompt-local's
  // behavior 2 wait).
  await expect(page, "URL never moved onto the created session's route").toHaveURL(sessionUrlPattern(SESSION_ID), {
    timeout: 20_000,
  })
}

const submitIcon = (page: Page) => page.locator(SELECTORS.submitControl).last()

/** `sendPromptRequest` registers the outgoing prompt as an abortable pending prompt
 * BEFORE it awaits `prepareLiveEventsBestEffort` (bounded to 1.5s), and only POSTs
 * `prompt_async` once that resolves and the controller was not aborted meanwhile. Stop
 * clicked inside that pre-dispatch window finds the prompt still pending, flips status to
 * idle optimistically, aborts locally and returns WITHOUT ever calling the network abort —
 * no `prompt_async` POST fires at all. The Thinking row and the "stop" icon are satisfied
 * by the optimistic status alone, so both can already be true inside that window,
 * especially on a fast machine. Waiting until the mock has actually received the dispatch
 * is what makes a test exercise "abort an already-dispatched turn". */
async function waitForDispatchReceived(promptState: { count: number }) {
  await expect.poll(() => promptState.count, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
}

test.describe("core busy / abort / errors @core", () => {
  // Sibling suites share this machine; every assertion polls DOM state, so a longer
  // ceiling only delays reporting a stuck state.
  test.describe.configure({ timeout: 120_000 })
  test("Thinking stays painted until the follow-up reply begins", async ({ page }, testInfo) => {
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS,
      existingSession: { prompt: "previous prompt", reply: "previous completed reply" },
      messageRefreshOnly: { responseDelayMs: 700 },
      timingsMs: { busy: 60, pending: 150, delta: 3000, completed: 300, idle: 150 },
    })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
    await expectAssistantReplyVisible(page, "previous completed reply")
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    const samples = await sampleElementDuringAction(page, `${SELECTORS.thinkingRow}, ${SELECTORS.assistantContent}`, async () => {
      await ensureComposerModelSelected(page)
      await input.fill("Thinking continuity probe")
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible()
      await expectAssistantReplyVisible(page, "ack 1: Thinking continuity probe")
    })
    expect(mock.requests.promptCount).toBe(1)
    const messageID = mock.requests.promptBodies[0]?.messageID
    expect(messageID).toBeTruthy()
    const thinking = (sample: typeof samples[number]) => sample.elements.some(element =>
      element.messageID === messageID && element.slot === "session-turn-thinking" && element.painted)
    const firstThinking = samples.findIndex(thinking)
    const firstReply = samples.findIndex(sample => sample.elements.some(element =>
      element.messageID === messageID && element.slot === "session-turn-assistant-content" && element.hasText && element.painted))
    await writeFile(testInfo.outputPath("thinking-continuity.json"), JSON.stringify({ messageID, firstThinking, firstReply, eventWebSocketConnections: mock.requests.eventWebSocketConnections, samples }, null, 2))
    expect(mock.requests.eventWebSocketConnections).toBeGreaterThan(0)
    expect(firstThinking).toBeGreaterThanOrEqual(0)
    expect(firstReply).toBeGreaterThan(firstThinking)
    expect(samples.slice(firstThinking, firstReply).filter(sample => !thinking(sample))).toEqual([])
  })

  test("Thinking belongs to the new prompt throughout a follow-up send", async ({ page }, testInfo) => {
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server",
      harnessModels: { "codex-app-server": [{ id: "gpt-5", name: "GPT-5" }] },
      existingSession: { prompt: "previous prompt", reply: "previous completed reply" },
      timingsMs: { busy: 60, pending: 150, delta: 2000, completed: 300, idle: 150 },
    })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
    await expectAssistantReplyVisible(page, "previous completed reply")
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    const samples = await sampleElementDuringAction(page, SELECTORS.thinkingRow, async () => {
      await ensureComposerModelSelected(page)
      await input.fill("Thinking ownership probe")
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible()
      await expectAssistantReplyVisible(page, "ack 1: Thinking ownership probe")
    })
    expect(mock.requests.promptCount).toBe(1)
    const messageID = mock.requests.promptBodies[0]?.messageID
    expect(messageID).toBeTruthy()
    await writeFile(testInfo.outputPath("thinking-ownership.json"), JSON.stringify({ messageID, samples }, null, 2))
    expect(samples.some(sample => sample.visible > 0)).toBe(true)
    expect(samples.flatMap(sample => sample.messageIDs).filter(owner => owner !== messageID)).toEqual([])
  })

  test("Thinking stays with the new prompt while the previous turn's completion envelope is in flight", async ({ page }, testInfo) => {
    const prevUserId = `${SESSION_ID}_prev`
    const prevAssistantId = `${prevUserId}_r`
    const created = 1_700_000_000_000
    const messages = [
      {
        info: {
          id: prevUserId, sessionID: SESSION_ID, role: "user",
          time: { created },
          agent: "build", model: { providerID: "codex", modelID: "gpt-5" },
        },
        parts: [{ id: `prt_${prevUserId}`, sessionID: SESSION_ID, messageID: prevUserId, type: "text", text: "previous prompt" }],
      },
      {
        // Reply parts are painted, but the envelope completion has not landed:
        // the producer's `message.updated` (with time.completed) is still in
        // flight — the state the original send observed at 0.57–1.05s.
        info: {
          id: prevAssistantId, sessionID: SESSION_ID, role: "assistant", parentID: prevUserId,
          time: { created: created + 1000 },
          modelID: "gpt-5", providerID: "codex", mode: "auto", agent: "build",
          path: { cwd: DIR, root: DIR }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: `prt_${prevAssistantId}`, sessionID: SESSION_ID, messageID: prevAssistantId, type: "text", text: "previous completed reply" }],
      },
    ]
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, harness: "codex-app-server",
      harnessModels: { "codex-app-server": [{ id: "gpt-5", name: "GPT-5" }] },
      existingSession: { messages: messages as MockMessageRow[] },
      sessionStatuses: { [SESSION_ID]: { type: "busy" } },
      // The defect window is busy-before-pending: the new turn's assistant
      // envelope has not announced itself, so the un-completed previous
      // assistant still owns the Thinking anchor.
      timingsMs: { busy: 60, pending: 4000, delta: 4000, completed: 300, idle: 150 },
    })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
    // The reply IS painted — the in-flight turn marks its content aria-hidden
    // while the completion envelope is out, so the strict visible-slot oracle
    // cannot see it; presence in the content slot is the honest setup check.
    await expect(
      page.locator(SELECTORS.assistantContent).filter({ hasText: "previous completed reply" }),
    ).toHaveCount(1)
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    let submitAt = 0
    const samples = await sampleElementDuringAction(page, SELECTORS.thinkingRow, async () => {
      await ensureComposerModelSelected(page)
      await input.fill("Thinking ownership probe")
      await page.locator(SELECTORS.submitControl).last().click()
      submitAt = await page.evaluate(() => performance.now())
      await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible()
      await expectAssistantReplyVisible(page, "ack 1: Thinking ownership probe")
    })
    expect(mock.requests.promptCount).toBe(1)
    const messageID = mock.requests.promptBodies[0]?.messageID
    expect(messageID).toBeTruthy()
    await writeFile(testInfo.outputPath("thinking-ownership-tail.json"), JSON.stringify({ messageID, prevUserId, submitAt, samples }, null, 2))
    const afterSubmit = samples.filter(sample => sample.time >= submitAt)
    expect(afterSubmit.some(sample => sample.messageIDs.includes(messageID ?? null))).toBe(true)
    expect(afterSubmit.flatMap(sample => sample.messageIDs).filter(owner => owner !== messageID)).toEqual([])
  })

  test("Thinking renders while busy, then gives way to the visible reply", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // Busy ends when the first assistant content lands (~busy + pending + delta/2), so
      // a wide delta leaves room for the busy assertions under contention.
      timingsMs: { busy: 60, pending: 150, delta: 12_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "busy abort errors turn one thinking"
    await sendPrompt(page, input, promptText)

    await expect(page.locator(SELECTORS.thinkingRow), "Thinking row never appeared while busy").toBeVisible({
      timeout: 20_000,
    })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    await expect(page.locator(SELECTORS.thinkingRow)).toHaveCount(0)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("stale-busy: completed reply stays visible and status reconciles without user action", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      staleBusy: true,
      timingsMs: { busy: 40, pending: 80, delta: 300, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "stale busy regression reply must stay visible"
    await sendPrompt(page, input, promptText)

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("Stop click aborts the turn and status reconciles optimistically before the network responds", async ({
    page,
  }) => {
    // The abort response is held until `releaseAbort()`, so ready-before-response is under test.
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      holdAbort: true,
    })
    const promptState = await silencePromptAsync(page)
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "abort this turn please")
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    await waitForDispatchReceived(promptState)

    await submitIcon(page).click()

    // The abort has reached the network and its response is still held, so only the
    // optimistic idle write can have moved the control.
    await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    await expect(
      submitIcon(page),
      "submit control did not return to ready while the abort response was still held open",
    ).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    expect(promptState.count).toBe(1)

    // Release the held response so teardown is clean.
    mock.releaseAbort()
  })

  test("Stop shows the canonical cancelled-turn outcome without reloading", async ({ page }, testInfo) => {
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS,
      existingSession: { prompt: "previous prompt", reply: "previous completed reply" },
      holdTurn: true, messageRefreshOnly: { responseDelayMs: 0 },
    })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session/${SESSION_ID}`)
    await expectAssistantReplyVisible(page, "previous completed reply")
    await ensureComposerModelSelected(page)
    const pending = page.waitForResponse(async response => {
      if (!response.url().includes(`/session/${SESSION_ID}/message?`) || response.status() !== 200) return false
      const body = await response.json()
      return body.messages.some((row: { info: { id: string; role: string; time: { completed?: number } } }) =>
        row.info.id === mock.requests.promptBodies[0]?.assistantID && row.info.role === "assistant" && !row.info.time.completed)
    })
    await page.getByRole("textbox", { name: /Ask anything/i }).last().fill("Stop outcome probe")
    await page.locator(SELECTORS.submitControl).last().click()
    await pending
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible()
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.abortCount).toBe(1)
    await expect(page.locator(SELECTORS.submitControl).last()).not.toHaveAttribute("data-icon", "stop")
    const divider = page.locator('[data-slot="compaction-part-label"]').filter({ hasText: /You stopped after/ })
    await expect.soft(divider, "the cancelled turn explains Stop before navigation or reload").toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: testInfo.outputPath("before-reload.png") })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(divider, "persisted cancellation renders after reload").toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("after-reload.png") })
    expect(mock.requests.promptCount).toBe(1)
    expect(mock.requests.eventWebSocketConnections).toBeGreaterThan(0)
  })

  test("an aborted assistant message renders an Interrupted divider at its position", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
    const promptState = await silencePromptAsync(page)
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "please stop before you answer")
    await expect(page.locator(SELECTORS.thinkingRow), "pending assistant row never registered").toBeVisible({
      timeout: 20_000,
    })
    await waitForDispatchReceived(promptState)

    await submitIcon(page).click()
    await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    const userID = promptState.lastMessageID
    expect(userID, "mock never recorded the user messageID").toBeTruthy()
    const assistantID = "msg_assistant_manual_abort"
    const now = Date.now()
    mock.emit({
      type: "message.updated",
      properties: {
        sessionID: SESSION_ID,
        info: {
          id: assistantID,
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: now, completed: now },
          parentID: userID!,
          agent: "build",
          providerID: "opencode",
          modelID: "gpt-5",
          error: { name: "MessageAbortedError", data: { message: "Aborted by user" } },
        },
      },
    })
    mock.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } })

    // The redesigned timeline renders the interrupted-turn divider — a
    // `TimelineRow.TurnDivider` with `label: "interrupted"`
    // (message-timeline.data.ts) — using the duration-aware copy
    // "You stopped after {duration}" (`ui.message.interruptedDuration`,
    // ui/src/i18n/en.ts → message-timeline.tsx) whenever a
    // duration is derivable. The aborted assistant message carries a
    // `time.completed`, so `durationMs` resolves (to 0s here) and this variant
    // is used; the bare "Interrupted" (`ui.message.interrupted`) only appears
    // when no duration can be computed. Either way it is the interrupted
    // divider this behavior asserts, at the aborted message's position.
    const dividerLabel = page.locator('[data-slot="compaction-part-label"]').filter({ hasText: /You stopped after/ })
    await expect(dividerLabel, "Interrupted divider never rendered").toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })

    // No assistant text exists here, so the evidence capture is the divider itself.
    await dividerLabel.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: "test-results/evidence/core-busy-abort-errors/interrupted-divider-at-abort-part-index.png",
    })
  })

  test("Enter on a blank composer while busy is an intentional no-op", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // Busy must outlast the blank-Enter probe and its request-count checks while the
      // turn still settles inside the oracle's 20s window.
      timingsMs: { busy: 60, pending: 150, delta: 16_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "enter on blank composer must not abort"
    await sendPrompt(page, input, promptText)
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    await waitForDispatchReceived({ get count() { return mock.requests.promptCount } })

    // Submit clears the composer; confirm it is blank before probing the guard.
    await expect(input).toHaveText("", { timeout: 20_000 })
    await input.click()
    await page.keyboard.press("Enter")

    // Give a stray request time to land before checking the counts.
    await page.waitForTimeout(400)
    expect(mock.requests.promptCount, "Enter-on-blank must not submit a second prompt").toBe(1)
    expect(mock.requests.abortCount, "Enter-on-blank must not call session.abort").toBe(0)
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
  })

  test("a message sent mid-turn joins the running turn instead of stopping it", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // The turn must still be running when the second message is sent.
      timingsMs: { busy: 60, pending: 150, delta: 16_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "start the long job")
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
    await waitForDispatchReceived({ get count() { return mock.requests.promptCount } })
    await expect(input).toHaveText("", { timeout: 20_000 })

    const steered = "also update the readme"
    await input.click()
    await input.fill(steered)
    // A draft written mid-turn turns the control back into Send: there is
    // something to send, so the primary control is not Stop.
    await expect(submitIcon(page)).toHaveAttribute("data-icon", "send", { timeout: 15_000 })
    await page.keyboard.press("Enter")

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
    expect(mock.requests.promptBodies[1]?.delivery, "the second message must ask to steer the running turn").toBe("steer")
    expect(mock.requests.abortCount, "sending mid-turn must not stop the running turn").toBe(0)
    await expect(page.getByText(steered).last(), "the steered message never reached the transcript")
      .toBeVisible({ timeout: 20_000 })
    await expect(page.locator(SELECTORS.thinkingRow), "the running turn must still be running")
      .toBeVisible({ timeout: 5_000 })
  })

  test("a retry/ACP-recovery status renders the retry banner, then the turn recovers and completes", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      // `pending` sizes the window in which the injected retry status is the whole
      // truth: driveTurn only creates the assistant message row after `busy + pending`,
      // and once that row carries content the app's own REST reconciliation dispatches
      // `session.status: idle` (source "server") — `conversationHasAssistantMessage` →
      // `dispatchSessionStatusEvent(idle)`, session-controller.ts. Asserting the
      // banner inside the pre-assistant-row stretch keeps the injected status and the
      // mocked server's state consistent with each other; `delta` is then short so the
      // turn still settles well inside the oracle's own 20s window.
      //
      // 10s (not 5s): suite-load cold reconnect often spends ~2s on the events reconnect
      // floor plus ~2s on the draft→session quiet window before the first retry emit can
      // stick. Under that latency a 5s pending window expires before the banner poll sees
      // a rendered row, even though the same scenario is green in isolation.
      timingsMs: { busy: 60, pending: 10_000, delta: 2_000, completed: 300, idle: 150 },
    })
    await neutralizeStatusPoll(page)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "recover after an ACP retry"
    await sendPrompt(page, input, promptText)
    await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })

    const retryStatus = {
      type: "retry" as const,
      attempt: 1,
      message: "Reconnecting to the ACP client",
      next: Date.now() + 2_000,
    }
    // Emitted on a poll rather than once because the FIRST emit lands DURING the
    // consumer's reconnect gap, not because it is lost. An instrumented run showed the
    // emit issued immediately after the Thinking row appears leaves the banner absent for
    // ~2.5s, while a re-emit ~2s later applies within 500ms and sticks. Nothing drops the
    // frame: the mock's `EventBus` is an append-only log and `ClaxedoEventsProvider`
    // reconnects with its own `Last-Event-ID`. What the poll absorbs is claxedo-app's ~2s
    // reconnect floor (`app/providers/claxedo-events-reconnect.ts`) plus the 2s
    // session-switch quiet window the draft→session navigation arms
    // (`platform/runtime/session-switch.ts`) — a latency property of the consumer's
    // reconnect policy, not app behavior. Re-emitting is harmless for this frame
    // (`session.status` is a state assignment: applying "retry" twice equals applying it
    // once). The poll stops emitting the moment the banner exists, and nothing re-emits
    // during the oracle below, so this can never mask the oracle's "submit control back to
    // ready" layer.
    const retryBanner = page.locator(SELECTORS_retry.banner)
    await expect
      .poll(
        async () => {
          mock.emit({ type: "session.status", properties: { sessionID: SESSION_ID, status: retryStatus } })
          if ((await retryBanner.count()) === 0) return ""
          return await page.locator(SELECTORS_retry.message).textContent() ?? ""
        },
        { timeout: 20_000, intervals: [500], message: "retry banner never rendered on status:retry" },
      )
      .toContain("Reconnecting to the ACP client")

    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptCount).toBe(1)
  })

  test("a non-abort assistant error renders an error card with the JSON envelope unwrapped", async ({
    page,
  }) => {
    const errorEnvelope = JSON.stringify({
      error: { type: "overloaded_error", message: "The server is overloaded, please retry later." },
    })
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      errorMidTurn: errorEnvelope,
      timingsMs: { busy: 40, pending: 80, delta: 200, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "trigger a mid-turn error")

    // Every non-abort turn error renders as the FirstTurnRecoveryCard, not the legacy bare
    // `.error-card` — that fallback is unreachable because `sessionRecoveryClass`
    // (first-turn-recovery.ts) always returns a class, "unknown" at worst. The JSON
    // envelope still unwraps to "<type>: <message>" and is shown in the card's collapsed
    // raw detail; this error classifies as "unknown" because it matches none of the
    // credential/session/harness/model/workspace regexes.
    // Keep this locator pinned to the original failed turn. Resending creates a
    // second legitimate failed turn and therefore a second recovery card.
    const errorCard = page.getByTestId("first-turn-recovery-card").first()
    await expect(errorCard, "recovery/error card never rendered").toBeVisible({ timeout: 20_000 })
    await expect(errorCard).toHaveAttribute("data-recovery-class", "unknown")
    await expect(errorCard).toContainText("overloaded_error: The server is overloaded, please retry later.")

    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
    expect(mock.requests.promptCount).toBe(1)

    const original = mock.requests.promptBodies[0]
    await errorCard.getByRole("button", { name: "Resend last prompt" }).click()

    await expect.poll(() => mock.requests.promptCount, {
      timeout: 15_000,
      message: "first-turn recovery did not resubmit the failed prompt",
    }).toBe(2)
    expect(mock.requests.createSessionCount).toBe(1)
    expect(mock.requests.promptBodies[1]?.sessionID).toBe(SESSION_ID)
    expect(mock.requests.promptBodies[1]?.sessionID).toBe(original?.sessionID)
    expect(mock.requests.promptBodies[1]?.text).toBe(original?.text)

    await errorCard.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: "test-results/evidence/core-busy-abort-errors/error-card-json-envelope-unwrapped.png",
    })
  })

  test("a persisted turn-admission conflict renders compact status text instead of an error card", async ({ page }) => {
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: PIN_MODELS,
      errorMidTurn: "Session is already processing a message",
      timingsMs: { busy: 40, pending: 80, delta: 200, completed: 80, idle: 30 },
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await sendPrompt(page, input, "replay a persisted turn admission conflict")

    const status = page.getByTestId("turn-admission-status-message")
    await expect(status).toBeVisible({ timeout: 20_000 })
    await expect(status).toContainText("Message wasn’t sent")
    await expect(status).toContainText("The previous message was still finishing. Try again.")
    await expect(page.getByTestId("first-turn-recovery-card")).toHaveCount(0)
    await expect(page.locator(".error-card")).toHaveCount(0)
    await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
    expect(mock.requests.promptCount).toBe(1)
  })

  test(
    "escalation ladder: a genuinely silent server surfaces pending then long, and Cancel aborts",
    async ({ page }) => {
      test.setTimeout(300_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
      await silencePromptAsync(page)

      // Simulate a backend that accepts the dispatch and then goes completely silent: no
      // SSE session.status/session.idle ever (silencePromptAsync above), and
      // /session/status never resolves at all. Every reconciliation path has to be starved
      // at once, because any server-source status event — including the mock's normal
      // early busy ack — otherwise clears the optimistic escalation timers within
      // milliseconds of every send. Two paths are starved here: the ~1.5s first-fold
      // hydrate (see neutralizeStatusPoll) and the slower ~60s active-turn status poll.
      await neutralizeStatusPoll(page)

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)
      await sendPrompt(page, input, "is anyone still there")

      await expect(page.locator(SELECTORS.thinkingRow)).toBeVisible({ timeout: 20_000 })

      const stage = page.getByTestId("session-status-stage")
      // The 20s pending timer starts at send, not here; the ceiling absorbs contention.
      await expect(stage, "pending stage (~20s) never appeared").toBeVisible({ timeout: 90_000 })
      await expect(stage).toHaveAttribute("data-stage", "pending")
      await expect(stage).toContainText("Still working")

      await expect(stage).toHaveAttribute("data-stage", "long", { timeout: 90_000 })
      await expect(stage).toContainText("taking a while")

      await page.locator('[data-action="session-status-cancel"]').click()
      await expect(stage, "escalation banner did not clear after Cancel").toHaveCount(0, { timeout: 15_000 })
      await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
      await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    },
  )

  test(
    "escalation ladder reaches the failed/unresponsive stage with Cancel and Retry",
    async ({ page }) => {
      // The "failed" stage otherwise fires at OPTIMISTIC_STATUS_FAILURE_MS =
      // 5 * 60_000 of real wall-clock (session-status-dispatcher.ts), impractical
      // at CI speed. Instead of freezing time (page.clock would also stall the mock's
      // SSE reconnect backoff), we set the dispatcher's gated `__claxedoStatusTimerScale`
      // hook BEFORE first navigation so ONLY the four escalation delays scale down
      // proportionally — order between stages is preserved, so this reaches "failed"
      // through the exact same redispatch→pending→long→failed timer ladder the
      // "pending"/"long" test above proves, just faster. The mock's own backoff timer
      // is untouched.
      const STATUS_TIMER_SCALE = 0.02 // redispatch 160ms · pending 400ms · long 900ms · failed 6s
      await page.addInitScript((scale: number) => {
        ;(window as typeof window & { __claxedoStatusTimerScale?: number }).__claxedoStatusTimerScale = scale
      }, STATUS_TIMER_SCALE)

      test.setTimeout(120_000)
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: PIN_MODELS })
      const promptState = await silencePromptAsync(page)
      await neutralizeStatusPoll(page)

      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      // The Retry snapshot lives per composer instance and the draft→session handoff
      // swaps instances, so the first send settles the scope and a second send arms Retry.
      await sendPrompt(page, input, "is anyone still there")
      await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
      // The composer swap can land after the URL moves; wait for the session composer
      // itself, or the second send arms Retry on the draft instance.
      await expect(
        page.locator('[data-component="session-new-composer"]'),
        "draft composer never handed off to the session composer",
      ).toHaveCount(0, { timeout: 20_000 })
      await expect(page.locator('[data-component="session-composer"]').last()).toBeVisible({ timeout: 20_000 })
      // A Stop before dispatch leaves the first send's late reconcile to land during the
      // second turn and clear its status meta.
      await waitForDispatchReceived(promptState)

      await submitIcon(page).click()
      await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })

      await input.click()
      await input.fill("still nothing?")
      // A blank submit arms no Retry snapshot, so confirm the text committed first.
      await expect(input).toContainText("still nothing?", { timeout: 10_000 })
      await page.locator(SELECTORS.submitControl).last().click()
      await expect(submitIcon(page)).toHaveAttribute("data-icon", "stop", { timeout: 20_000 })
      // Optimistic busy precedes dispatch; the ladder is measured from a dispatched turn.
      await expect.poll(() => promptState.count, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

      const stage = page.getByTestId("session-status-stage")
      // Setup latency is not scaled, so pending/long may already have elapsed; "failed"
      // is terminal and stable until Cancel.
      await expect(stage, "escalation banner never appeared").toBeVisible({ timeout: 30_000 })
      await expect(stage).toHaveAttribute("data-stage", "failed", { timeout: 30_000 })
      await expect(stage).toContainText("unresponsive")

      await expect(page.locator('[data-action="session-status-cancel"]')).toBeVisible()
      await expect(
        page.locator('[data-action="session-status-retry"]'),
        "failed stage offered Cancel but no Retry — the composer's last-submitted snapshot was dropped",
      ).toBeVisible()

      await page.locator('[data-action="session-status-cancel"]').click()
      await expect(stage, "escalation banner did not clear after Cancel").toHaveCount(0, { timeout: 15_000 })
      await expect(submitIcon(page)).not.toHaveAttribute("data-icon", "stop", { timeout: 15_000 })
      await expect.poll(() => mock.requests.abortCount, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    },
  )
})
