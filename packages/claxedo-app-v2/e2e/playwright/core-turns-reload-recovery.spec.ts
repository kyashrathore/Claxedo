/**
 * A local session's life after its first turn: sending further turns, reloading
 * mid-conversation, recalling and editing already-sent prompts, recovering from a failed
 * send, and the client-side window that keeps only recent turns mounted. The first turn
 * itself belongs to core-first-prompt-local.spec.ts.
 *
 * The timeline is server-authoritative. `GET /session/:id/message` is the truth; the client
 * renders the user's own turn optimistically and reconciles against the server row. Nothing
 * about a sent turn lives only in memory, so a reload must reproduce the same rows exactly
 * once and reuse the same session.
 *
 * `createSessionHistoryWindow` (src/pages/session/history-window.ts) slices the fetched
 * turns down to what is mounted — turnInit=4, turnBatch=8, turnScrollThreshold=200, all
 * purely client-side and reset on session switch. `[data-testid="session-page-root"]`
 * carries `data-session-visible-user-count` (fetched) and `data-session-rendered-user-count`
 * (mounted). Scrolling near the top re-slices already-fetched turns; the server-cursor path
 * (`historyMore()` / `x-next-cursor` / `sessionController.loadMore`) is unreachable through
 * the shared mock's non-paginated `/session/:id/message` and is not exercised here.
 *
 * Prompt history is per session: it lives beside the session's draft under
 * `claxedo.workspace.<scope>.dat:workspace:prompt-history`, and ArrowUp reads the stack the
 * composer's mode selects for the mounted session. The entry is written by the post-send
 * clear, so a failed send restores the draft instead of recording it. There is no Edit
 * control on a sent row — `UserActions` exposes only fork/revert — so recall-then-edit is
 * the edit affordance.
 *
 * A thrown `POST /session/:id/prompt_async` runs `rollbackPromptDispatch`: the optimistic
 * user row is removed and the composer's text, image attachments, and context items are
 * restored byte-for-byte. No Retry action is attached to the toast; the restored composer's
 * own Send control is the retry.
 *
 * The harness is fixed to `opencode` throughout — harness selection belongs to
 * core-harness-ownership-local.spec.ts.
 */
import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, expectTurnCounts, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-turns-reload-recovery"
const SESSION_ID = "ses_core_turns_reload_recovery"

// The mock's default opencode model is the `big-pickle` placeholder, which
// `model-strategy.ts` filters out of the auto-selected default so it can never be
// picked — submit stays blocked with `no-model` until a real model is connected.
// Every send here needs one.
const HARNESS_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

// 1x1 transparent PNG, inlined so the attachment fixture needs no file on disk.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  // `addInitScript` re-runs on every navigation, `page.reload()` included. An unconditional
  // `localStorage.clear()` would wipe the prompt history this file reloads to prove persists,
  // so the clear sits behind a same-origin sentinel and fires only on the first load; later
  // loads just re-assert the in-memory `__CLAXEDO__` global, which a reload does wipe.
  await page.addInitScript((d: string) => {
    if (!localStorage.getItem("__e2e_seeded__")) {
      localStorage.clear()
      localStorage.setItem("__e2e_seeded__", "1")
    }
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

async function openDraftPrompt(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  // Drafts do not invent a catalog default — pick once here so later
  // sendAndProve / ArrowUp / Enter paths never re-enter the picker.
  await ensureComposerModelSelected(page)
  return input
}

function composer(page: Page) {
  // Not role+name: the composer's aria-label is its placeholder, which becomes "Enter shell
  // command..." once shell mode is entered (`!` at cursor 0), so a name-based locator
  // captured beforehand stops matching and hangs until timeout. `data-component` is on the
  // same contenteditable node and is mode-independent.
  return page.locator('[data-component="prompt-input"]').last()
}

function submitControl(page: Page) {
  return page.locator(SELECTORS.submitControl).last()
}

async function sendAndProve(page: Page, text: string, replyText: string) {
  const input = composer(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await submitControl(page).click()
  await expectAssistantReplyVisible(page, replyText)
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

test.describe("core turns, reload recovery, history & send-failure recovery (local) @core", () => {
  test("2nd/3rd sends survive reload with zero duplicate rows, the same session, and a bounded request pattern", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns first message", "ack 1: core turns first message")
    await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID), { timeout: 20_000 })
    expect(mock.requests.createSessionCount).toBe(1)

    // Turn 2 renders its own reply; turn 1's content is untouched.
    await sendAndProve(page, "core turns second message", "ack 2: core turns second message")
    await expectAssistantReplyVisible(page, "ack 1: core turns first message")
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.createSessionCount).toBe(1)

    // Track raw request traffic from here so the reload can prove no endpoint keeps
    // re-firing once the app has settled.
    const seen = new Map<string, number>()
    page.on("request", (request) => {
      const type = request.resourceType()
      if (type !== "fetch" && type !== "xhr") return
      const url = new URL(request.url())
      // Event streams are excluded: they are long-lived connections that re-establish by
      // design, so a reconnect is not the polling loop this guard looks for.
      if (
        url.pathname === "/api/cp/events" ||
        url.pathname === "/api/wr/events" ||
        url.pathname.endsWith("/health")
      ) {
        return
      }
      const key = `${request.method()} ${url.pathname}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    })

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expectAssistantReplyVisible(page, "ack 1: core turns first message")
    await expectAssistantReplyVisible(page, "ack 2: core turns second message")
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.createSessionCount).toBe(1)

    // Rate, not total: some endpoints legitimately poll slowly, so the question is whether
    // traffic scales with elapsed time. The window is wide enough and the bound loose enough
    // that a loaded runner's trailing stragglers cannot cross it, while a runaway re-fetch
    // (tens to hundreds of requests here) is unmistakable. The wait is only the settle
    // window; the per-endpoint delta below is the assertion.
    const afterSettle = new Map(seen)
    const settleWindowMs = 5_000
    await page.waitForTimeout(settleWindowMs)
    // Iterate the post-window map, not the snapshot: an endpoint that only starts firing
    // after settle is absent from the snapshot and would be checked by nobody, and a loop
    // that begins late is exactly the loop worth catching.
    for (const [key, after] of seen) {
      const before = afterSettle.get(key) ?? 0
      expect(
        after - before,
        `${key} kept firing after settle (before=${before}, after=${after}) over ${settleWindowMs}ms — looks like a request-storm/polling loop`,
      ).toBeLessThanOrEqual(8)
    }

    // A 3rd send after reload dispatches into the same session.
    await sendAndProve(page, "core turns third message", "ack 3: core turns third message")
    await expectTurnCounts(page, { user: 3, assistant: 3 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.createSessionCount).toBe(1)
    expect(mock.requests.promptCount).toBe(3)
  })

  test("ArrowUp/ArrowDown recall sent prompts in LIFO order and the recalled text can be edited and resent", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns history alpha", "ack 1: core turns history alpha")
    await sendAndProve(page, "core turns history beta", "ack 2: core turns history beta")

    const input = composer(page)
    await input.click()

    // LIFO recall — most recently sent prompt first.
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns history beta")
    await expect(input).not.toContainText("core turns history alpha")

    await input.press("ArrowUp")
    await expect(input).toContainText("core turns history alpha")
    await expect(input).not.toContainText("core turns history beta")

    await input.press("ArrowDown")
    await expect(input).toContainText("core turns history beta")
    await expect(input).not.toContainText("core turns history alpha")

    await input.press("ArrowDown")
    // Past the newest entry: back to the pre-navigation draft (empty here) — neither
    // recalled entry's text should remain.
    await expect(input).not.toContainText("core turns history alpha")
    await expect(input).not.toContainText("core turns history beta")

    // Recall once more: the recalled text is editable and resendable.
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns history beta")
    // Full replace rather than End+type: under load, End does not reliably place the caret
    // at the end of this contenteditable, and `type` then inserts mid-string.
    await input.fill("core turns history beta edited")
    await expect(input).toContainText("core turns history beta edited")
    await input.press("Enter")

    await expectAssistantReplyVisible(page, "ack 3: core turns history beta edited")
    await expectTurnCounts(page, { user: 3, assistant: 3 })
    await expectNoDuplicateRows(page)
  })

  test("prompt history is persisted and survives a reload", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns persisted before reload", "ack 1: core turns persisted before reload")

    const storedBeforeReload = await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((key) => key.endsWith(":workspace:prompt-history"))
      return { keys, values: keys.map((key) => localStorage.getItem(key) ?? "") }
    })
    expect(storedBeforeReload.keys).toHaveLength(1)
    expect(storedBeforeReload.keys[0]).toMatch(/^claxedo\.workspace\./)
    expect(storedBeforeReload.values[0]).toContain("core turns persisted before reload")
    expect(await page.evaluate(() => localStorage.getItem("claxedo.global.dat:prompt-history"))).toBeNull()

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expectAssistantReplyVisible(page, "ack 1: core turns persisted before reload")

    const input = composer(page)
    await input.click()
    await input.press("ArrowUp")
    await expect(input).toContainText("core turns persisted before reload")
  })

  test("a forced dispatch failure restores composer text + attachment, toasts, and a resend succeeds", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns dispatch failure setup", "ack 1: core turns dispatch failure setup")

    // Layer a fail-once override on top of the shared mock's prompt_async route. Playwright
    // runs the most-recently-registered matching route first, and `route.fallback()` hands
    // control back to installMockRuntime's own handler, so only this attempt fails and every
    // other one reuses the shared mock's real dispatch and turn-driving logic.
    let forceFailure = false
    let forcedFailureCount = 0
    await page.route("**/session/*/prompt_async**", async (route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) return route.fallback()
      if (!forceFailure) return route.fallback()
      forceFailure = false
      forcedFailureCount += 1
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "dispatch failed" }) })
    })

    const input = composer(page)
    const failingText = "core turns dispatch failure message"
    await input.click()
    await input.fill(failingText)
    await expect(input).toContainText(failingText, { timeout: 10_000 })

    // `.last()`: two `input[type="file"]` nodes exist — the active composer's hidden input
    // plus an inactive off-screen duplicate composer's — and DOM order does not reliably put
    // the visible one first, so `.first()` can attach the file where nothing renders it.
    // Same reason `composer()`/`submitControl()` above use `.last()`.
    const fileInput = page.locator('input[type="file"]').last()
    await fileInput.setInputFiles({ name: "attach.png", mimeType: "image/png", buffer: Buffer.from(PNG_1X1_BASE64, "base64") })
    await expect(page.getByAltText("attach.png")).toBeVisible({ timeout: 10_000 })

    forceFailure = true
    await submitControl(page).click()

    // The forced 500 is the deterministic signal that the failure round-trip happened.
    await expect.poll(() => forcedFailureCount, { timeout: 10_000 }).toBe(1)
    await expect
      .poll(() => mock.requests.badResponses.some((entry) => entry.includes("prompt_async")), { timeout: 10_000 })
      .toBe(true)

    await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to send prompt", { timeout: 10_000 })

    // Optimistic user row removed; still only turn 1 on the timeline.
    await expect(
      page.locator(SELECTORS.userMessageContent).getByText(failingText, { exact: true }),
    ).toHaveCount(0, { timeout: 10_000 })
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    await expect(input).toContainText(failingText, { timeout: 10_000 })
    await expect(page.getByAltText("attach.png")).toBeVisible({ timeout: 10_000 })

    // No dedicated Retry button: the restored composer's own Send control resubmits the
    // same content, and this time it succeeds.
    await submitControl(page).click()
    await expectAssistantReplyVisible(page, "ack 2: core turns dispatch failure message")
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.promptCount).toBe(2) // the forced-failed attempt never reached the real handler
  })

  test("a forced dispatch failure restores a context-item chip into the composer", async ({
    page,
  }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, harnessModels: HARNESS_MODELS })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await sendAndProve(page, "core turns chip dispatch failure setup", "ack 1: core turns chip dispatch failure setup")

    // Stub the composer's @-mention file-search endpoint (`GET /api/wr/find/file`).
    // installMockRuntime's default answers every query with `[]`; registering after install
    // wins under Playwright's last-registered-first matching.
    const MENTION_FILE_PATH = "src/chip-context-file.ts"
    await page.route("**/api/wr/find/file**", (route) => {
      const url = new URL(route.request().url())
      if (url.pathname !== "/api/wr/find/file") return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([MENTION_FILE_PATH]) })
    })

    let forceFailure = false
    let forcedFailureCount = 0
    await page.route("**/session/*/prompt_async**", async (route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) return route.fallback()
      if (!forceFailure) return route.fallback()
      forceFailure = false
      forcedFailureCount += 1
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "dispatch failed" }) })
    })

    const input = composer(page)
    const failingText = "core turns chip dispatch failure message"
    await input.click()
    await input.fill(failingText + " ")
    await expect(input).toContainText(failingText, { timeout: 10_000 })

    await page.keyboard.type("@chip-context")
    const fileOption = page.locator('button[role="option"]').filter({ hasText: MENTION_FILE_PATH })
    await expect(fileOption).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press("Enter")

    const pill = input.locator(`[data-type="file"][data-path="${MENTION_FILE_PATH}"]`)
    await expect(pill).toBeVisible({ timeout: 10_000 })

    await page.keyboard.type("please look")

    forceFailure = true
    await submitControl(page).click()

    // The forced 500 is the deterministic signal that the failure round-trip happened.
    await expect.poll(() => forcedFailureCount, { timeout: 10_000 }).toBe(1)
    await expect
      .poll(() => mock.requests.badResponses.some((entry) => entry.includes("prompt_async")), { timeout: 10_000 })
      .toBe(true)

    await expect(page.locator('[data-slot="toast-title"]')).toContainText("Failed to send prompt", { timeout: 10_000 })

    // Optimistic user row removed; still only turn 1 on the timeline.
    await expect(
      page.locator(SELECTORS.userMessageContent).getByText("please look", { exact: false }),
    ).toHaveCount(0, { timeout: 10_000 })
    await expectTurnCounts(page, { user: 1, assistant: 1 })

    await expect(input).toContainText(failingText, { timeout: 10_000 })
    await expect(pill).toBeVisible({ timeout: 10_000 })
    await expect(input).toContainText("please look", { timeout: 10_000 })

    // No dedicated Retry button: the restored composer's own Send control resubmits the
    // same content, and this time it succeeds.
    await submitControl(page).click()
    await expectAssistantReplyVisible(page, /^ack 2: /)
    await expectTurnCounts(page, { user: 2, assistant: 2 })
    await expectNoDuplicateRows(page)
    expect(mock.requests.promptCount).toBe(2) // the forced-failed attempt never reached the real handler
  })

  test("scrolling to the top loads older turns without duplicating rows and preserves the scroll anchor", async ({
    page,
  }) => {
    // Shrink the viewport so 6 short turns genuinely overflow the message list:
    // `scheduleHistoryFill` reveals everything whenever the content fits, so on a default
    // viewport nothing stays windowed. 460px rather than ~300px keeps turns near the top of
    // the list clear of the timeline's `sticky top-0 z-30` session-title bar, which the
    // oracle's hit-test would otherwise flag as a covering overlay.
    await page.setViewportSize({ width: 1280, height: 460 })

    // Exactly one filler line per reply sizes the hydrate-time window (turnInit=4) between
    // two bounds. Tall enough that `scheduleHistoryFill` does not immediately reveal
    // everything — it reveals whenever scrollHeight <= clientHeight + 1, and unpadded
    // single-line replies sit right at that line, where estimated (60px/row) and measured
    // heights disagree. Short enough that one wheel tick can cross it — the virtualizer only
    // mounts rows near the viewport, so a window over ~2 viewports tall leaves the
    // top-of-window turn unmounted, with no anchor or witness surviving the gesture.
    const mock = await installMockRuntime(page, {
      dir: DIR,
      sessionId: SESSION_ID,
      harnessModels: HARNESS_MODELS,
      replyText: (turn, promptText) => `ack ${turn}: ${promptText}\n${"history fill line\n".repeat(1)}`,
    })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    const turnCount = 6
    for (let i = 1; i <= turnCount; i++) {
      await sendAndProve(page, `core turns load older message ${i}`, `ack ${i}: core turns load older message ${i}`)
    }
    expect(mock.requests.promptCount).toBe(turnCount)

    // Reload before measuring the window. `initialTurnStart` — the thing that produces
    // `renderedBefore < turnCount` — is applied only at session-hydrate time, on the
    // `[sessionID, messagesReady]` transition, not as turns are appended to an already-open
    // session. Building all 6 turns live never engages it: `scheduleHistoryFill` sets
    // `turnStart` back to 0 while the rendered content does not yet overflow, and once every
    // existing turn is un-windowed nothing re-applies `initialTurnStart` for the rest of that
    // session.
    //
    // It has to be a document reload, not an in-app hop. This shell is a workbench: leaving
    // the session for the draft view backgrounds the tab without unmounting it, so its
    // `createSessionHistoryWindow` instance survives with an unchanged `sessionID()` and no
    // hydrate fires. Only a reload tears the tab down.
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    // `.filter({ visible: true })` guards against a backgrounded `session-page-root`
    // coexisting with the live one; only the focused tab's root is visible.
    const root = page.locator('[data-testid="session-page-root"]').filter({ visible: true }).last()
    await expect(root).toHaveAttribute("data-session-visible-user-count", String(turnCount), { timeout: 15_000 })
    // With turnInit=4 the window shows fewer than all fetched turns while unscrolled, which
    // is what proves windowing (and therefore overflow) is engaged.
    const renderedBefore = Number(await root.getAttribute("data-session-rendered-user-count"))
    expect(renderedBefore).toBeLessThan(turnCount)
    await expectNoDuplicateRows(page)

    // In-viewport witness: the turn just below the old window's top, which is what the user
    // is looking at once the wheel clamps. The window's literal top turn sits a few px above
    // the compensated scroll position by construction, so it is not a robust witness.
    // Asserted only after the reveal — the virtualizer unmounts off-viewport rows, so no row
    // stays measurable across the whole gesture.
    const witness = page
      .locator(SELECTORS.userMessageContent)
      .getByText(`core turns load older message ${turnCount - renderedBefore + 2}`, { exact: true })
    const scroller = page.locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()

    // Instrument the scroller before the gesture: every scroll event's (scrollTop,
    // scrollHeight) plus the sample where the rendered-count attribute flips. The
    // `preserveScroll` contract is checked from these samples rather than element anchors,
    // because the virtualizer unmounts off-viewport rows and estimates unmounted heights,
    // while scroll coordinates are virtualization-immune. The MutationObserver flushes after
    // the reveal's synchronous DOM update but before preserveScroll's rAF scrollTop write,
    // which is what captures the pre-compensation position.
    await page.evaluate(() => {
      const el = document.querySelector('[data-scrollable]:has([data-slot="session-turn-message-content"])')
      const rootEl = document.querySelector('[data-testid="session-page-root"]')
      if (!el || !rootEl) return
      const w = window as typeof window & {
        __e2eScrollSamples?: Array<{ kind: string; top: number; height: number; rendered: string | null }>
      }
      w.__e2eScrollSamples = []
      const sample = (kind: string) =>
        w.__e2eScrollSamples?.push({
          kind,
          top: (el as HTMLElement).scrollTop,
          height: (el as HTMLElement).scrollHeight,
          rendered: rootEl.getAttribute("data-session-rendered-user-count"),
        })
      el.addEventListener("scroll", () => sample("scroll"), { passive: true })
      new MutationObserver(() => sample("reveal")).observe(rootEl, {
        attributes: true,
        attributeFilter: ["data-session-rendered-user-count"],
      })
      sample("init")
    })

    // A real wheel gesture, not a programmatic scrollTop write, which the app's
    // gesture-tracking treats as non-user and snaps back to the bottom.
    //
    // Stop the instant the reveal fires rather than when scrollTop crosses a threshold:
    // `onScrollerScroll` reveals everything in one shot the first time scrollTop dips under
    // turnScrollThreshold, and further wheel deltas after that just scroll the now-taller
    // content, which has nothing to do with `preserveScroll`'s compensation.
    await scroller.hover()
    for (let attempt = 0; attempt < 30; attempt++) {
      // Check before dispatching another wheel: under load the flip can already be visible
      // from the previous wheel's processing, and a queued extra delta undoes the
      // compensation this test is measuring.
      if ((await root.getAttribute("data-session-rendered-user-count")) === String(turnCount)) break
      const topBefore = await scroller.evaluate((el) => (el as HTMLElement).scrollTop)
      // Smaller than -400: the wheel that crosses turnScrollThreshold still applies its full
      // delta in the same gesture, and -400 dragged the mid-list witness off-screen.
      await page.mouse.wheel(0, -160)
      // `mouse.wheel` resolves when the input is dispatched, not once the page has scrolled.
      // Wait for scrollTop to move or the reveal attribute to flip, then a double rAF so the
      // same-task reveal flush is visible to the next iteration.
      await page
        .waitForFunction(
          ({ scrollSel, top, count }) => {
            const roots = Array.from(document.querySelectorAll('[data-testid="session-page-root"]'))
            const live =
              roots.find((node) => {
                const style = window.getComputedStyle(node)
                return style.display !== "none" && style.visibility !== "hidden"
              }) ?? roots[roots.length - 1]
            if (live?.getAttribute("data-session-rendered-user-count") === count) return true
            const el = document.querySelector(scrollSel) as HTMLElement | null
            return !!el && el.scrollTop !== top
          },
          {
            scrollSel: '[data-scrollable]:has([data-slot="session-turn-message-content"])',
            top: topBefore,
            count: String(turnCount),
          },
          { timeout: 2_000, polling: "raf" },
        )
        .catch(() => undefined)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      if ((await root.getAttribute("data-session-rendered-user-count")) === String(turnCount)) break
    }

    // The older, previously-windowed-out turns get revealed.
    await expect(root).toHaveAttribute("data-session-rendered-user-count", String(turnCount), { timeout: 10_000 })
    await expectNoDuplicateRows(page)

    // The row count flips as soon as the prepended turns mount, but `preserveScroll`'s
    // compensating scrollTop write can land a frame or two later, so wait for the scroller
    // to stop moving and measure settled layout rather than a mid-compensation one.
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel) as HTMLElement | null
        if (!el) return false
        const w = window as typeof window & { __e2eScrollSettle?: { last: number; stable: number } }
        const state = w.__e2eScrollSettle ?? { last: el.scrollTop, stable: 0 }
        if (el.scrollTop === state.last) state.stable += 1
        else {
          state.last = el.scrollTop
          state.stable = 0
        }
        w.__e2eScrollSettle = state
        return state.stable >= 3
      },
      '[data-scrollable]:has([data-slot="session-turn-message-content"])',
      { timeout: 5_000, polling: "raf" },
    )

    // Scroll anchor preserved: when the reveal prepends content, `preserveScroll` bumps
    // scrollTop by the scroller's scrollHeight growth so the viewport does not visually jump.
    // Only the settled post-reveal geometry is a stable reference — an autoscroll bottom-snap
    // lands transiently mid-reveal before the compensating write wins. Nothing is
    // pixel-exact: the virtualizer estimates unmounted prepended rows until they mount, so
    // the compensation's input is approximate and corrects itself as rows measure. Sampled
    // before the nudge below, whose temporary scroll would skew it.
    const samples = await page.evaluate(() => {
      const w = window as typeof window & {
        __e2eScrollSamples?: Array<{ kind: string; top: number; height: number; rendered: string | null }>
      }
      return w.__e2eScrollSamples ?? []
    })
    const settled = await scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }))
    // That the reveal really prepended is proven by the rendered-count flip above, zero
    // duplicate rows, and the in-viewport witness below — not by a cross-gesture scrollHeight
    // delta, which compares two measurement regimes: the pre-gesture sample counts unmounted
    // windowed rows at the virtualizer's ~180px estimate while these single-line turns
    // measure ~65-74px once mounted, so the delta can read negative while the content grew.
    // What is left to assert is that the settled geometry still overflows, and that scrollTop
    // sits neither back in the <200px trigger zone (compensation no-oped or jumped to the
    // top) nor at maxScroll (autoscroll snapped back). The samples ride the failure messages.
    expect(
      settled.height,
      `revealed content must still overflow the scroller. samples=${JSON.stringify(samples)} settled=${JSON.stringify(settled)}`,
    ).toBeGreaterThan(settled.client + 100)
    expect(
      settled.top,
      `preserveScroll must compensate scrollTop by the prepended height (a no-op or jump-to-top leaves it in the <200px trigger zone) samples=${JSON.stringify(samples)} settled=${JSON.stringify(settled)}`,
    ).toBeGreaterThan(100)
    expect(
      settled.top,
      "scrollTop after the reveal must stay near the compensated position, well above maxScroll (a bottom snap-back lands at maxScroll)",
    ).toBeLessThan(settled.height - settled.client - 100)
    await expect(witness).toBeInViewport()

    // Wheel to the very top so the oldest turn enters the virtualizer's mounted range: with
    // TIMELINE_OVERSCAN=3 rows only exist in the DOM near the viewport, and the oracle's
    // scrollIntoViewIfNeeded cannot reach a row that was never mounted. At scrollTop 0 the
    // first reply's center clears the sticky session-title bar, so no extra nudge is needed,
    // and no further reveal can fire — turnStart is already 0 and a real gesture keeps
    // autoScroll's userScrolled latched.
    await scroller.hover()
    for (let attempt = 0; attempt < 30; attempt++) {
      const top = await scroller.evaluate((el) => el.scrollTop)
      if (top <= 0) break
      await page.mouse.wheel(0, -400)
    }

    // The earliest turn, previously windowed out entirely, is now genuinely rendered.
    await expectAssistantReplyVisible(page, "ack 1: core turns load older message 1")
  })
})
