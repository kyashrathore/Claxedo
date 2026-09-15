/**
 * Timeline rendering — tool defaults, context grouping, diff summary, scroll.
 *
 * Adjacent territory belongs to sibling specs: the send flow and its optimistic
 * rows (`core-first-prompt-local`), reload/duplicate-row recovery and the
 * pixel-level scroll-anchor proof for `backfillTurns`
 * (`core-turns-reload-recovery`), the per-harness tool-renderer matrix
 * (`core-harness-rendering-matrix`), the question-answering dock (`core-docks`),
 * and harness selection (`core-harness-ownership-local`).
 *
 * Payloads here are constructed directly in the already-normalized OpenCode v2
 * `Part`/`Message` shape the client stores internally, so grouping and scroll
 * behavior is isolated from harness translation.
 *
 * Server-cursor pagination (`x-next-cursor` on `/session/:id/message`) is
 * unreachable here: the shared mock never sets that header.
 *
 * Known app gap, reproduced deterministically but not fixed: `seek()` in
 * `use-session-hash-scroll.ts` corrects a `#message-<id>` deep-link's scroll
 * offset exactly once, from `getBoundingClientRect()` at the first moment the
 * target exists in the DOM. Rows above the target that are still sized by the
 * virtualizer's `estimateSize()` grow once their real heights are reported, and
 * `shouldAdjustScrollPositionOnItemSizeChange` (`message-timeline.tsx`) only
 * re-corrects rows whose measured end is already `<= scrollOffset`. So a deep
 * link into a tall session can settle permanently short of the target, leaving
 * the jump-to-bottom control visibly stuck showing.
 */

import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime, type MockRuntimeOptions } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-timeline-rendering-scroll"
const SESSION_ID = "ses_core_timeline_rendering_scroll"
const PROJECT_ID = "proj_mock_runtime"

// The mock's default opencode model is a placeholder the app filters out of model
// selection, so composer submit stays blocked on "Choose a model to continue" until a real
// model is connected. The one scenario here that drives a real send needs this.
const HARNESS_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

type AnyPart = Record<string, unknown>
type AnyInfo = Record<string, unknown>

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

function composer(page: Page) {
  return page.getByRole("textbox", { name: /Ask anything/i }).last()
}

function submitControl(page: Page) {
  return page.locator(SELECTORS.submitControl).last()
}

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function sendAndProve(page: Page, text: string, expectedSubstring: string) {
  const input = composer(page)
  await ensureComposerModelSelected(page)
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await submitControl(page).click()
  await expectAssistantReplyVisible(page, expectedSubstring)
}

async function openSessionWithFirstSend(page: Page, options?: Partial<MockRuntimeOptions>) {
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, ...options })
  await seedOneProject(page, DIR)
  await openDraftPrompt(page, DIR)
  await sendAndProve(page, "hello timeline", "ack 1: hello timeline")
  await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID), { timeout: 20_000 })
  return { mock }
}

function userInfo(id: string, text: string, extra?: Record<string, unknown>): AnyInfo {
  return {
    id,
    sessionID: SESSION_ID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "opencode", modelID: "big-pickle" },
    ...extra,
  }
}

function assistantInfo(id: string, parentID: string, opts?: { completed?: boolean }): AnyInfo {
  const created = Date.now()
  return {
    id,
    sessionID: SESSION_ID,
    role: "assistant",
    time: opts?.completed ? { created: created - 500, completed: created } : { created },
    parentID,
    agent: "build",
    providerID: "opencode",
    modelID: "big-pickle",
    mode: "code",
    path: { cwd: DIR, root: DIR },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function textPart(id: string, messageID: string, text: string, extra?: Record<string, unknown>): AnyPart {
  return { id, sessionID: SESSION_ID, messageID, type: "text", text, ...extra }
}

function toolPart(input: {
  id: string
  messageID: string
  tool: string
  status?: "pending" | "running" | "completed" | "error"
  input?: Record<string, unknown>
  output?: string
  title?: string
  metadata?: Record<string, unknown>
}): AnyPart {
  const status = input.status ?? "completed"
  const base = { id: input.id, sessionID: SESSION_ID, messageID: input.messageID, type: "tool", callID: `${input.id}_call`, tool: input.tool }
  const now = Date.now()
  if (status === "pending") return { ...base, state: { status, input: input.input ?? {}, raw: "" } }
  if (status === "running") return { ...base, state: { status, input: input.input ?? {}, time: { start: now - 50 } } }
  if (status === "error") return { ...base, state: { status, input: input.input ?? {}, error: input.output ?? "tool failed", time: { start: now - 100, end: now } } }
  return {
    ...base,
    state: {
      status: "completed",
      input: input.input ?? {},
      output: input.output ?? "",
      title: input.title ?? "",
      metadata: input.metadata ?? {},
      time: { start: now - 100, end: now },
    },
  }
}

function questionToolPart(input: {
  id: string
  messageID: string
  status: "pending" | "completed"
  questions: Array<{ question: string; header: string; options: Array<{ label: string; value: string }> }>
  answers?: string[][]
}): AnyPart {
  const base = { id: input.id, sessionID: SESSION_ID, messageID: input.messageID, type: "tool", callID: `${input.id}_call`, tool: "question" }
  if (input.status === "pending") {
    return { ...base, state: { status: "pending", input: { questions: input.questions }, raw: "" } }
  }
  return {
    ...base,
    state: {
      status: "completed",
      input: { questions: input.questions },
      output: "answered",
      title: "Questions",
      metadata: { answers: input.answers ?? [] },
      time: { start: Date.now() - 100, end: Date.now() },
    },
  }
}

function userRow(input: {
  id: string
  text: string
  // `patch` is typed optional on the SDK but required in practice: the client's `diff()`
  // guard drops any value without a string `patch`, and the snapshot pipeline always sets
  // one — `""` for binary files.
  summaryDiffs?: Array<{ file: string; additions: number; deletions: number; status?: string; patch: string }>
}): { info: AnyInfo; parts: AnyPart[] } {
  return {
    info: userInfo(input.id, input.text, input.summaryDiffs ? { summary: { diffs: input.summaryDiffs } } : undefined),
    parts: [textPart(`${input.id}_text`, input.id, input.text)],
  }
}

function assistantRow(input: {
  id: string
  parentID: string
  completed?: boolean
  toolParts?: AnyPart[]
  text?: string
}): { info: AnyInfo; parts: AnyPart[] } {
  const parts = [...(input.toolParts ?? [])]
  if (input.text) parts.push(textPart(`${input.id}_text`, input.id, input.text))
  return {
    info: assistantInfo(input.id, input.parentID, { completed: input.completed }),
    parts,
  }
}

function collapsibleContent(page: Page, partId: string) {
  return page.locator(`[data-timeline-part-id="${partId}"] [data-slot="collapsible-content"]`)
}

// A settled turn whose tool activity produces >=2 "foldable" rows (work groups, context
// groups, or standalone tool parts) folds behind one "Worked for Xs" `TurnFold` divider
// by default (`canFoldSettled`/`shouldFold` in `message-timeline.data.ts`) — its
// `Collapsible.Content`, and therefore every row underneath including nested group/tool
// wrappers that otherwise stay mounted regardless of THEIR OWN open state, is
// presence-unmounted until unfolded. Any scenario seeding >=2 foldable rows for one turn
// must unfold it before asserting on anything nested inside.
async function unfoldTurnIfNeeded(page: Page, userMessageID: string) {
  const trigger = page.locator(`[data-message-id="${userMessageID}"][data-timeline-row="TurnFold"] button`)
  if ((await trigger.count()) === 0) return
  if ((await trigger.getAttribute("aria-expanded")) === "true") return
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
}

// Consecutive work-type tool parts (bash/edit/write/apply_patch/web) fold into one work
// group once the run has two members; a lone one stays a standalone row. The group
// presence-unmounts its members until expanded, though each keeps its own open state.
async function expandWorkGroupIfPresent(page: Page, partIds: string) {
  const trigger = page.locator(`[data-timeline-part-ids="${partIds}"] [data-component="work-group-trigger"]`)
  if ((await trigger.count()) === 0) return
  // Kobalte presence-unmounts `Collapsible.Content` (here `[data-component="work-group-
  // list"]`) while closed, so its mere presence means the group is already open.
  const content = page.locator(`[data-timeline-part-ids="${partIds}"] [data-component="work-group-list"]`)
  if ((await content.count()) > 0) return
  await trigger.click()
  await expect(content).toHaveCount(1)
}

async function openSettings(page: Page) {
  await page.getByTestId("rail-account-trigger").click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expect(page.locator('[data-action="settings-feed-shell-tool-parts-expanded"]')).toBeVisible({ timeout: 10_000 })
}

async function setSwitch(page: Page, dataAction: string, checked: boolean) {
  const wrapper = page.locator(`[data-action="${dataAction}"]`)
  await expect(wrapper).toBeVisible({ timeout: 10_000 })
  const input = wrapper.locator("input")
  const isChecked = await input.isChecked()
  if (isChecked !== checked) await wrapper.locator('[data-slot="switch-control"]').click()
  await expect(input).toBeChecked({ checked, timeout: 5_000 })
}

function seededSessionRow() {
  return {
    id: SESSION_ID,
    slug: SESSION_ID,
    projectID: PROJECT_ID,
    directory: DIR,
    title: "core timeline history session",
    version: "2",
    time: { created: Date.now(), updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 },
    config: {
      harness: { type: "opencode", model: "big-pickle", status: "ready", ready: true },
      model: { providerID: "opencode", modelID: "big-pickle" },
      provider: { id: "opencode", model: "big-pickle" },
      agent: "build",
    },
  }
}

function seededTurnRows(count: number) {
  const rows: Array<{ info: AnyInfo; parts: AnyPart[] }> = []
  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(2, "0")
    const uid = `msg_user_${n}`
    const aid = `msg_assistant_${n}`
    const created = Date.now() - (count - i + 1) * 60_000
    rows.push({
      info: { id: uid, sessionID: SESSION_ID, role: "user", time: { created }, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } },
      parts: [{ id: `${uid}_text`, sessionID: SESSION_ID, messageID: uid, type: "text", text: `core timeline history message ${i}` }],
    })
    rows.push({
      info: {
        id: aid,
        sessionID: SESSION_ID,
        role: "assistant",
        time: { created: created + 500, completed: created + 1500 },
        parentID: uid,
        agent: "build",
        providerID: "opencode",
        modelID: "big-pickle",
        mode: "code",
        path: { cwd: DIR, root: DIR },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: `${aid}_text`,
          sessionID: SESSION_ID,
          messageID: aid,
          type: "text",
          // Kept short: the "jump-to-bottom appears once scrolled
          // away" scenario navigates straight to `#message-<lastUserID>`,
          // and per `session.tsx`'s `shouldAnchorBottom`
          // (`!location.hash && ...`) a hash on load disables bottom-
          // anchoring entirely in favor of `useSessionHashScroll`'s
          // scroll-to-element. That scroll is computed once, from the
          // virtualizer's estimated (not-yet-measured) row heights for
          // whatever precedes the target — tall, not-yet-measured rows
          // there make the one-shot correction undershoot the real
          // position by however much those estimates were off, and
          // `seek()` never re-corrects once it has succeeded once.
          // Eight short turns still comfortably overflow a 342px-tall
          // scroller (enough to exercise the scroll-up/jump-to-bottom
          // reveal below) without tripping that estimate-vs-real gap.
          text: `Reply ${i}. A short acknowledgement for turn ${i}.`,
        },
      ],
    })
  }
  return rows
}

async function installSeededSession(page: Page, rows: Array<{ info: AnyInfo; parts: AnyPart[] }>) {
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })
  await seedOneProject(page, DIR)
  const sessionRow = seededSessionRow()
  const listBody = JSON.stringify([sessionRow])
  const sessionBody = JSON.stringify(sessionRow)
  const messageBody = JSON.stringify({ messages: rows, maxEventOrdinal: 0 })
  // Each literal route is registered twice, bare and with a `?**` suffix:
  // Playwright's glob matching requires an exact end-of-URL match unless the
  // pattern ends in a wildcard, and the real app appends `?directory=...` to
  // nearly every request. A bare `**/session/<id>` pattern alone silently fails
  // to match `.../session/<id>?directory=...`, and the request then falls
  // through to the shared mock's own generic `**/session/*` catch-all (a
  // single-segment wildcard, which — unlike a bare literal pattern — DOES
  // swallow query-string characters) instead of this route.
  await page.route("**/session", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  await page.route("**/session?**", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  // Bound to the session ROW only — deliberately NOT `**/session/${SESSION_ID}**`.
  // A trailing `**` compiles to `(.*)`, so that pattern also swallows every
  // SUB-resource of the session, including `GET /session/:id/permission-mode`,
  // which the composer fetches on every mount. Answered with the session row
  // instead of a mode report, the mode picker reads `modes` off a body that has
  // none and throws during render, taking the whole shell into the ErrorBoundary
  // so `[data-claxedo]` never appears and every test here fails in `gotoSession`.
  // Two patterns for the same reason the `**/session` pair above needs two: a
  // bare literal pattern requires an exact end-of-URL match, and the app appends
  // `?directory=...`.
  await page.route(`**/session/${SESSION_ID}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }))
  await page.route(`**/session/${SESSION_ID}?**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }))
  await page.route(`**/session/${SESSION_ID}/message**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: messageBody }))
  return mock
}

async function gotoSession(page: Page, hash?: string) {
  // `waitUntil: "domcontentloaded"` (not the default "load") + a generous
  // timeout: the very first navigation straight to a `/s/:id` route in a cold
  // dev server can take longer than the default 60s to satisfy "load" (full
  // on-demand Vite transform of the session-detail chunk graph), well before
  // any app-level slowness — `[data-claxedo]` below is the actual readiness
  // signal this helper's callers care about.
  await page.goto(`/s/${SESSION_ID}${hash ?? ""}`, { waitUntil: "domcontentloaded", timeout: 90_000 })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

// In this mock topology `/api/workspace/resolve` always reports a `workspaceId`
// (even for a `kind:"local"` directory), which makes `workspaceRuntimeOwnsLive
// Events()` (`src/context/global-sdk.tsx`) true and routes the client's live
// event consumption exclusively through `/api/wr/runtime-events` — never
// `/global/event` — for EVERY session, not just cloud ones. The shared mock
// only mounts `/api/wr/*` routes when `installMockRuntime`'s `cloud` option is
// passed, so in the default (local) mock configuration those runtime-event
// requests hit real network and fail; `bus.emit()`-pushed SSE events (the
// pattern `driveTurn` itself uses for the mocked text-only reply) are
// therefore NEVER delivered to the browser in this configuration. Rendering a
// real send's reply instead relies on `src/session/store/session-controller.ts`
// `activeTurnTransition` firing `syncCompatSession(id, {force:true})` once the
// LOCAL, submit-set-optimistic `activeTurn()` flag (`markBusy()` in
// `src/components/prompt-input/submit.ts`) settles back down — a path that
// only a real composer submit enters. A turn built by hand (no real submit)
// has no way to flip that local flag, so it is invisible no matter how many
// SSE events are pushed onto the bus.
// What DOES reliably reach a freshly (re)loaded session, independent of SSE:
// the unconditional first-fold hydrate in `session-controller.ts` (the
// `shouldHydrateSession` effect) — `syncCompatSession` (`GET .../message`)
// fires once on mount, and `refreshMeta` (`GET /session/status`) fires
// ~1.5s later. So this spec drives busy→settle and pending→answered
// transitions by overriding those two GET routes with MUTABLE state and
// calling `page.reload()` between assertions, instead of a live SSE push.
type MutableSession = {
  mock: Awaited<ReturnType<typeof installMockRuntime>>
  setRows: (rows: Array<{ info: AnyInfo; parts: AnyPart[] }>) => void
  setStatus: (status: "idle" | "busy") => void
  reload: () => Promise<void>
}

async function installMutableSession(
  page: Page,
  initial: { rows: Array<{ info: AnyInfo; parts: AnyPart[] }>; status?: "idle" | "busy" },
): Promise<MutableSession> {
  const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID })
  await seedOneProject(page, DIR)
  let rows = initial.rows
  let status: "idle" | "busy" = initial.status ?? "idle"
  const sessionRow = seededSessionRow()
  const listBody = JSON.stringify([sessionRow])
  const sessionBody = JSON.stringify(sessionRow)
  // Each literal route is registered twice, bare and with a `?**` suffix, and
  // `**/session/status**` carries a trailing wildcard: Playwright's glob
  // matching requires an exact end-of-URL match unless the pattern ends in a
  // wildcard, and the real app appends `?directory=...` to nearly every
  // request. A bare `**/session/status` pattern silently fails to match
  // `.../session/status?directory=...` and falls through to the shared mock's
  // own generic `**/session/*` catch-all (a single-segment wildcard, which —
  // unlike a bare literal pattern — DOES swallow query-string characters),
  // serving a generic session row with no visible error.
  await page.route("**/session", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  await page.route("**/session?**", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  // Bound to the session ROW only — deliberately NOT `**/session/${SESSION_ID}**`.
  // A trailing `**` compiles to `(.*)`, so that pattern also swallows every
  // SUB-resource of the session, including `GET /session/:id/permission-mode`,
  // which the composer fetches on every mount. Answered with the session row
  // instead of a mode report, the mode picker reads `modes` off a body that has
  // none and throws during render, taking the whole shell into the ErrorBoundary
  // so `[data-claxedo]` never appears and every test here fails in `gotoSession`.
  // Two patterns for the same reason the `**/session` pair above needs two: a
  // bare literal pattern requires an exact end-of-URL match, and the app appends
  // `?directory=...`.
  await page.route(`**/session/${SESSION_ID}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }))
  await page.route(`**/session/${SESSION_ID}?**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }))
  await page.route(`**/session/${SESSION_ID}/message**`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ messages: rows, maxEventOrdinal: 0 }),
  }))
  await page.route("**/session/status**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ [SESSION_ID]: { type: status } }) }))
  return {
    mock,
    setRows: (next) => {
      rows = next
    },
    setStatus: (next) => {
      status = next
    },
    reload: async () => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 })
      await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    },
  }
}

function timelineScroller(page: Page) {
  return page.locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()
}

async function scrollTimelineToTop(page: Page) {
  const scroller = timelineScroller(page)
  await scroller.hover()
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.mouse.wheel(0, -500)
    // Let each wheel fully apply (two rAFs) before deciding whether to wheel
    // again: an unsettled burst can land scrollTop at the top before the
    // app's gesture tracking has processed a single user scroll-up, leaving
    // the reveal logic with nothing left to trigger it.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const scrollTop = await scroller.evaluate((el) => el.scrollTop)
    if (scrollTop < 100) break
  }
}

/**
 * Found by the semantic icon id, never a sprite href: each theme draws this icon from its
 * own sprite, so an href selector matches nothing outside the theme it was written for and
 * the opacity read comes back null rather than "0".
 */
const JUMP_TO_BOTTOM_ICON = '[data-icon="scroll-to-latest"]'

async function jumpToBottomOpacity(page: Page) {
  return page.evaluate((selector) => {
    const icon = document.querySelector(selector)
    const box = icon?.closest("button")?.parentElement
    return box ? getComputedStyle(box).opacity : null
  }, JUMP_TO_BOTTOM_ICON)
}

function jumpToBottomButton(page: Page) {
  return page.locator(JUMP_TO_BOTTOM_ICON).locator("xpath=ancestor::button[1]")
}

test.describe("core timeline rendering & scroll (local) @core", () => {
  // Every scenario costs a full navigation, some a navigation plus reload, which outruns
  // the default per-test timeout on a loaded runner before anything the app does is slow.
  test.beforeEach(() => {
    test.slow()
  })

  test("tool call default-open state follows shell/edit settings; unrelated tools stay collapsed", async ({ page }) => {
    const userID = "msg_user_tools"
    const assistantID = "msg_assistant_tools"
    await installSeededSession(page, [
      userRow({ id: userID, text: "run a command and edit a file" }),
      assistantRow({
        id: assistantID,
        parentID: userID,
        completed: true,
        toolParts: [
          toolPart({ id: "tools_bash", messageID: assistantID, tool: "bash", input: { command: "ls" }, output: "file.txt" }),
          toolPart({ id: "tools_edit", messageID: assistantID, tool: "edit", input: { filePath: "src/app.ts" } }),
          toolPart({ id: "tools_web", messageID: assistantID, tool: "webfetch", input: { url: "https://example.com" } }),
        ],
        text: "turn done",
      }),
    ])
    await gotoSession(page)
    await expectAssistantReplyVisible(page, "turn done")

    // The 3 consecutive work-type tool parts (bash, edit,
    // webfetch) fold into ONE `WorkGroup` (`groupParts` in message-timeline.data.ts —
    // a work run merges once it has >=2 members). The turn itself has only that single
    // foldable row, so it stays un-turn-folded (`canFoldSettled` needs >=2 foldable
    // rows) — but the WorkGroup's own collapsible must be expanded before any member's
    // nested collapsible-content can be asserted on, same presence-unmount mechanism.
    await unfoldTurnIfNeeded(page, userID)
    const workGroupPartIds = "tools_bash,tools_edit,tools_web"
    await expandWorkGroupIfPresent(page, workGroupPartIds)

    // Both settings default to false, so all three start collapsed.
    await expect(collapsibleContent(page, "tools_bash")).toHaveCount(0)
    await expect(collapsibleContent(page, "tools_edit")).toHaveCount(0)
    await expect(collapsibleContent(page, "tools_web")).toHaveCount(0)

    // A never-toggled part reads through to the setting, so flipping it applies live.
    await openSettings(page)
    await setSwitch(page, "settings-feed-shell-tool-parts-expanded", true)
    await setSwitch(page, "settings-feed-edit-tool-parts-expanded", true)
    await page.keyboard.press("Escape")

    await expect(collapsibleContent(page, "tools_bash")).toHaveCount(1)
    await expect(collapsibleContent(page, "tools_edit")).toHaveCount(1)
    await expect(collapsibleContent(page, "tools_web")).toHaveCount(0)
  })

  test("a pending question tool call renders no row; an answered one opens automatically", async ({ page }) => {
    const userID = "msg_user_question"
    const assistantID = "msg_assistant_question"
    await installSeededSession(page, [
      userRow({ id: userID, text: "ask me two things" }),
      assistantRow({
        id: assistantID,
        parentID: userID,
        completed: true,
        toolParts: [
          questionToolPart({
            id: "q_pending",
            messageID: assistantID,
            status: "pending",
            questions: [{ question: "Which color?", header: "Color", options: [{ label: "Red", value: "red" }, { label: "Blue", value: "blue" }] }],
          }),
          questionToolPart({
            id: "q_answered",
            messageID: assistantID,
            status: "completed",
            questions: [{ question: "Proceed with the change?", header: "Proceed", options: [{ label: "Yes", value: "yes" }] }],
            answers: [["Yes"]],
          }),
        ],
        text: "question handled",
      }),
    ])
    await gotoSession(page)
    await expectAssistantReplyVisible(page, "question handled")

    // A pending question renders no row at all, not a collapsed one.
    await expect(page.locator('[data-timeline-part-id="q_pending"]')).toHaveCount(0)

    const answeredContent = collapsibleContent(page, "q_answered")
    await expect(answeredContent).toHaveCount(1)
    await expect(answeredContent.locator('[data-slot="question-answer-item"]')).toHaveCount(1)
  })

  test("consecutive read/glob/grep/list calls collapse into one expandable Gathered-context group", async ({ page }) => {
    const userID = "msg_user_context"
    const assistantID = "msg_assistant_context"
    await installSeededSession(page, [
      userRow({ id: userID, text: "look around the repo" }),
      assistantRow({
        id: assistantID,
        parentID: userID,
        completed: true,
        toolParts: [
          // Zero-padded so the store's lexicographic sort by part id preserves this
          // emission order; the group locator below asserts the joined id string.
          toolPart({ id: "ctx1_read", messageID: assistantID, tool: "read", input: { filePath: "src/a.ts" } }),
          toolPart({ id: "ctx2_glob", messageID: assistantID, tool: "glob", input: { pattern: "**/*.ts" } }),
          toolPart({ id: "ctx3_grep", messageID: assistantID, tool: "grep", input: { pattern: "TODO" } }),
          toolPart({ id: "ctx4_list", messageID: assistantID, tool: "list", input: { path: "src" } }),
        ],
        text: "context gathered",
      }),
    ])
    await gotoSession(page)
    await expectAssistantReplyVisible(page, "context gathered")

    const group = page.locator('[data-timeline-part-ids="ctx1_read,ctx2_glob,ctx3_grep,ctx4_list"]')
    await expect(group).toHaveCount(1)
    await expect(group.locator('[data-slot="context-tool-group-label"]')).toContainText("Explored")
    // The summary's digit uses an odometer-style `AnimatedNumber`
    // (packages/ui/src/components/animated-number.tsx) that renders a fixed
    // 30-cell 0-9 track and CSS-clips it to one visible cell — the cell text
    // is still present in `textContent`, so a plain toContainText("1 read")
    // against the whole summary span spuriously matches on digit-track noise
    // (e.g. "...789 read"). Assert the clean, non-animated pieces instead:
    // the accessible `aria-label` (the real numeric value) and the
    // `tool-count-label-stem` span (word text only, no digit track).
    const summary = group.locator('[data-slot="context-tool-group-summary"]')
    const items = summary.locator('[data-slot="tool-count-summary-item"]')
    await expect(items).toHaveCount(3)
    const [readItem, searchItem, listItem] = [items.nth(0), items.nth(1), items.nth(2)]
    await expect(readItem.locator('[data-component="animated-number"]')).toHaveAttribute("aria-label", "1")
    await expect(readItem.locator('[data-slot="tool-count-label-stem"]')).toContainText("read")
    await expect(searchItem.locator('[data-component="animated-number"]')).toHaveAttribute("aria-label", "2")
    await expect(searchItem.locator('[data-slot="tool-count-label-stem"]')).toContainText("search")
    await expect(listItem.locator('[data-component="animated-number"]')).toHaveAttribute("aria-label", "1")
    await expect(listItem.locator('[data-slot="tool-count-label-stem"]')).toContainText("list")

    // An expanded group holds each member's own tool row — it no longer wraps them in a
    // stripped-down item, so the rows are what the count is taken from.
    const members = group.locator('[data-component="context-tool-group-list"] [data-component="tool-trigger"]')
    await expect(members).toHaveCount(0)
    await group.locator('[data-component="context-tool-group-trigger"]').click()
    await expect(members).toHaveCount(4)
  })

  test("a context-tool run split by an unrelated tool call forms two separate groups", async ({ page }) => {
    const userID = "msg_user_split"
    const assistantID = "msg_assistant_split"
    await installSeededSession(page, [
      userRow({ id: userID, text: "read a couple files, run a command, read one more" }),
      assistantRow({
        id: assistantID,
        parentID: userID,
        completed: true,
        toolParts: [
          // Zero-padded for the same sort-by-id reason: unpadded, "split_bash" sorts
          // before "split_read1" and the two runs silently merge into one group.
          toolPart({ id: "split1_read", messageID: assistantID, tool: "read", input: { filePath: "a.ts" } }),
          toolPart({ id: "split2_read", messageID: assistantID, tool: "read", input: { filePath: "b.ts" } }),
          toolPart({ id: "split3_bash", messageID: assistantID, tool: "bash", input: { command: "echo hi" }, output: "hi" }),
          toolPart({ id: "split4_read", messageID: assistantID, tool: "read", input: { filePath: "c.ts" } }),
        ],
        text: "split done",
      }),
    ])
    await gotoSession(page)
    await expectAssistantReplyVisible(page, "split done")

    // This turn has 3 foldable rows (the 2-read context
    // group, the standalone bash part, the standalone trailing read) — >=2, so it
    // auto-folds behind a "Worked for Xs" `TurnFold` divider that presence-unmounts
    // everything below it until unfolded (unlike behavior 3's single-group turn, which
    // stays under the foldable-row threshold and needs no unfold).
    await unfoldTurnIfNeeded(page, userID)

    await expect(page.locator('[data-timeline-part-ids="split1_read,split2_read"]')).toHaveCount(1)
    await expect(page.locator('[data-timeline-part-ids="split4_read"]')).toHaveCount(1)
    await expect(page.locator('[data-timeline-part-id="split3_bash"]')).toHaveCount(1)
  })

  test("diff-summary accordion is hidden while busy, appears on settle, dedupes same-file entries, and lazy-mounts its diff view", async ({ page }) => {
    const userID = "msg_user_diffs"
    const assistantID = "msg_assistant_diffs"
    const summaryDiffs = [
      { file: "a.ts", additions: 1, deletions: 0, status: "modified", patch: "a.ts patch v1" },
      { file: "b.ts", additions: 5, deletions: 2, status: "modified", patch: "b.ts patch" },
      { file: "a.ts", additions: 9, deletions: 1, status: "modified", patch: "a.ts patch v2" },
    ]
    const session = await installMutableSession(page, {
      rows: [
        userRow({ id: userID, text: "please make some edits", summaryDiffs }),
        assistantRow({ id: assistantID, parentID: userID, completed: false }),
      ],
      status: "busy",
    })
    await gotoSession(page)

    // Confirm the turn renders busy before proving the diff row absent, so the absence is a
    // signal rather than a default. The status GET is only read after the ~1.5s first-fold
    // meta hydrate delay, hence the timeout.
    await expect(page.locator(`[data-message-id="${userID}"][data-timeline-row="Thinking"]`)).toBeVisible({ timeout: 30_000 })
    const diffRow = page.locator(`[data-message-id="${userID}"][data-timeline-row="DiffSummary"]`)
    await expect(diffRow).toHaveCount(0)

    session.setRows([
      userRow({ id: userID, text: "please make some edits", summaryDiffs }),
      assistantRow({ id: assistantID, parentID: userID, completed: true, text: "changes applied" }),
    ])
    session.setStatus("idle")
    await session.reload()
    await expectAssistantReplyVisible(page, "changes applied")

    await expect(diffRow).toHaveCount(1, { timeout: 30_000 })
    const triggers = diffRow.locator('[data-slot="session-turn-diff-trigger"]')
    await expect(triggers).toHaveCount(2)
    const filenames = diffRow.locator('[data-slot="session-turn-diff-filename"]')
    await expect(filenames).toHaveText(["b.ts", "a.ts"])

    await expect(diffRow.locator('[data-slot="session-turn-diff-view"]')).toHaveCount(0)
    await triggers.first().click()
    await expect(diffRow.locator('[data-slot="session-turn-diff-view"]')).toHaveCount(1)
  })

  test("diff-summary caps the preview at 3 files with a show all/less toggle", async ({ page }) => {
    const userID = "msg_user_diffs_overflow"
    const assistantID = "msg_assistant_diffs_overflow"
    const diffs = Array.from({ length: 12 }, (_, i) => ({
      file: `f${String(i + 1).padStart(2, "0")}.ts`,
      additions: 1,
      deletions: 0,
      status: "modified",
      patch: `f${String(i + 1).padStart(2, "0")}.ts patch`,
    }))
    await installSeededSession(page, [
      userRow({ id: userID, text: "touch a dozen files", summaryDiffs: diffs }),
      assistantRow({ id: assistantID, parentID: userID, completed: true, text: "many files changed" }),
    ])
    await gotoSession(page)
    await expectAssistantReplyVisible(page, "many files changed")

    // The diff-summary preview caps at 3 files (`maxFiles` in
    // `TimelineDiffSummaryRow`, src/features/session/ui/message-timeline.tsx).
    // Overflow is surfaced only by the single `session-turn-diffs-toggle`
    // ("Show all"/"Show less", no count), which does double duty as both the
    // expand and the collapse control — there is no separate "+N more files"
    // affordance.
    const diffRow = page.locator(`[data-message-id="${userID}"][data-timeline-row="DiffSummary"]`)
    const triggers = diffRow.locator('[data-slot="session-turn-diff-trigger"]')
    await expect(triggers).toHaveCount(3, { timeout: 30_000 })
    const toggle = diffRow.locator('[data-slot="session-turn-diffs-toggle"]')
    await expect(toggle).toContainText("Show all")

    await toggle.click()
    await expect(triggers).toHaveCount(12)
    await expect(toggle).toContainText("Show less")

    await toggle.click()
    await expect(triggers).toHaveCount(3)
  })

  test("jump-to-bottom appears once scrolled away from the bottom and returns there on click, clearing any hash", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await installSeededSession(page, seededTurnRows(8))
    await gotoSession(page, "#message-msg_user_08")

    const root = page.locator('[data-testid="session-page-root"]')
    await expect(root).toHaveAttribute("data-session-visible-user-count", "8", { timeout: 20_000 })
    // A hash on load disables bottom-anchoring in favour of scrolling the target to the top
    // of the viewport, so "at rest" is wherever that lands — not flush with the bottom.
    // Waiting for the position to stop moving is the settle signal; the contract under test
    // is the control's own visibility threshold, not a pixel offset.
    const scroller = timelineScroller(page)
    let stableReads = 0
    let lastScrollTop = -1
    await expect
      .poll(
        async () => {
          const current = await scroller.evaluate((el) => el.scrollTop)
          stableReads = current === lastScrollTop ? stableReads + 1 : 0
          lastScrollTop = current
          return stableReads
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(3)

    // At rest on the hash-scrolled target the control stays hidden: its threshold is
    // `max(400, clientHeight)` px from the bottom.
    await expect.poll(() => jumpToBottomOpacity(page), { timeout: 30_000 }).toBe("0")
    const renderedAtRest = Number(await root.getAttribute("data-session-rendered-user-count"))
    expect(renderedAtRest).toBeLessThan(8)

    // A real wheel gesture: programmatic `scrollTop` writes are treated as non-user and
    // snapped back.
    await scrollTimelineToTop(page)

    // Nudge-until-revealed: the reveal of older, previously-windowed-out turns
    // is gesture-driven, so if the scroller is already at the top with the
    // window still collapsed, only another wheel can trigger it — and an
    // already-expanded window short-circuits before wheeling again, so the
    // reveal is never overshot.
    await expect(async () => {
      const rendered = await root.getAttribute("data-session-rendered-user-count")
      if (rendered !== "8") {
        await page.mouse.wheel(0, -400)
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      }
      expect(rendered).toBe("8")
    }).toPass({ timeout: 30_000 })
    await expectNoDuplicateRows(page)

    await expect.poll(() => jumpToBottomOpacity(page), { timeout: 30_000 }).toBe("1")

    await jumpToBottomButton(page).click()

    // Returns to the bottom and clears the load-time hash. Late virtualizer measurements
    // can still grow the scroller, so settle the distance before reading opacity.
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
        timeout: 30_000,
      })
      .toBeLessThan(20)
    await expect.poll(() => jumpToBottomOpacity(page), { timeout: 15_000 }).toBe("0")
    await expect.poll(() => new URL(page.url()).hash).toBe("")
    const distance = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    expect(distance).toBeLessThan(20)

    // The reveal from scrolling up is not undone by returning to the bottom.
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "8")
  })

  test("scroll-to-bottom stays centered on the composer as the Environment card changes", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 700 })
    await installSeededSession(page, [
      userRow({ id: "msg_user_alignment", text: "Show a long answer" }),
      assistantRow({
        id: "msg_assistant_alignment",
        parentID: "msg_user_alignment",
        completed: true,
        text: Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: ${"Environment card alignment. ".repeat(8)}`).join("\n\n"),
      }),
    ])
    await gotoSession(page)
    const shell = page.locator(`.session-envcard-shell[data-session-id="${SESSION_ID}"]`)
    const jump = jumpToBottomButton(page)
    const dockColumn = shell.locator('[data-component="session-prompt-dock"] > div').first()
    const assertCentered = async () => {
      await scrollTimelineToTop(page)
      await expect.poll(() => jumpToBottomOpacity(page)).toBe("1")
      await expect.poll(async () => {
        const button = await jump.boundingBox()
        const column = await dockColumn.boundingBox()
        expect(button).not.toBeNull()
        expect(column).not.toBeNull()
        return Math.abs(button!.x + button!.width / 2 - column!.x - column!.width / 2)
      }).toBeLessThan(2)
    }

    await expect(shell).toHaveAttribute("data-session-envcard", "collapsed")
    await assertCentered()
    await page.getByRole("button", { name: "Expand Environment", exact: true }).click()
    await expect(shell).toHaveAttribute("data-session-envcard", "expanded")
    await assertCentered()
    await page.getByRole("button", { name: "Collapse Environment", exact: true }).click()
    await expect(shell).toHaveAttribute("data-session-envcard", "collapsed")
    await assertCentered()

    // A narrow pane inside a desktop viewport hides the rail and removes its gutter.
    await page.setViewportSize({ width: 1000, height: 700 })
    await expect(shell.locator(".session-envcard")).toBeHidden()
    await assertCentered()
    await page.setViewportSize({ width: 700, height: 700 })
    await assertCentered()
    await jump.click()
    await expect.poll(() => jumpToBottomOpacity(page)).toBe("0")
  })

  test("a user scroll held in the middle survives virtual-row measurement", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await installSeededSession(page, seededTurnRows(8))
    await gotoSession(page)

    const root = page.locator('[data-testid="session-page-root"]')
    const scroller = timelineScroller(page)
    await expect(root).toHaveAttribute("data-session-visible-user-count", "8", { timeout: 20_000 })

    // Reproduces the failure where the first interactive range expansion
    // remeasured rows and rewrote the scroll offset to 0.
    await scrollTimelineToTop(page)
    await scroller.hover()
    for (let attempt = 0; attempt < 12; attempt++) {
      const position = await scroller.evaluate((el) => ({
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
      }))
      if (position.max > 0 && position.top >= position.max * 0.35) break
      await page.mouse.wheel(0, 100)
      // A wheel returns before the browser applies the scroll frame; settle it, or the
      // final gesture reads as a virtualization-induced offset rewrite.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }

    const middle = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }))
    expect(middle.max).toBeGreaterThan(400)
    expect(middle.top).toBeGreaterThan(middle.max * 0.2)
    expect(middle.top).toBeLessThan(middle.max * 0.8)

    const samples = await scroller.evaluate(async (el) => {
      const values: number[] = []
      for (let index = 0; index < 60; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        values.push(el.scrollTop)
      }
      return values
    })

    const settled = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }))
    expect(Math.min(...samples), `scrollTop samples: ${samples.join(",")}`).toBeGreaterThan(settled.max * 0.15)
    expect(settled.top).toBeGreaterThan(settled.max * 0.15)
    expect(Math.abs(settled.top - middle.top)).toBeLessThan(100)
  })

  test("revealing cached turns above the second visible turn preserves the current turn", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    const rows = seededTurnRows(12)
    rows.forEach((row, index) => {
      if (row.info.role !== "assistant") return
      const text = row.parts.find((part) => part.type === "text")
      if (!text) return
      text.text = [
        `## Detailed reply ${Math.floor(index / 2) + 1}`,
        "",
        ...Array.from(
          { length: 12 + (index % 5) * 3 },
          (_, paragraph) => `Paragraph ${paragraph + 1}: ${"measured Markdown content ".repeat(8)}`,
        ),
      ].join("\n\n")
    })
    await installSeededSession(page, rows)
    await gotoSession(page)

    const root = page.locator('[data-testid="session-page-root"]')
    const scroller = timelineScroller(page)
    await expect(root).toHaveAttribute("data-session-visible-user-count", "12", { timeout: 20_000 })
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "4", { timeout: 20_000 })
    await expect(page.locator("[data-session-timeline-root]")).toHaveAttribute(
      "data-session-timeline-progressive-ready",
      "true",
      { timeout: 20_000 },
    )
    await expect(scroller.locator("[data-timeline-key]").first()).toBeAttached({ timeout: 20_000 })

    await scroller.hover()
    let beforeAnchor: { key: string; offset: number } | undefined
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await root.getAttribute("data-session-rendered-user-count")) === "12") break
      await scroller.evaluate((viewport) => {
        const state = window as unknown as { __cachedTurnAnchor?: { key: string; offset: number } }
        state.__cachedTurnAnchor = undefined
        viewport.addEventListener("scroll", () => {
          const view = viewport.getBoundingClientRect()
          const anchor = [...viewport.querySelectorAll<HTMLElement>("[data-timeline-key]")]
            .map((element) => ({ element, rect: element.getBoundingClientRect() }))
            .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
            .sort((a, b) => a.rect.top - b.rect.top)[0]
          const key = anchor?.element.dataset.timelineKey
          if (key) state.__cachedTurnAnchor = { key, offset: anchor.rect.top - view.top }
        }, { capture: true, once: true })
      })
      await page.mouse.wheel(0, -500)
      // A wheel can also trigger measurement and the cached reveal; let that settle before
      // deciding on another gesture, which would cancel it.
      await page.waitForTimeout(250)
      if ((await root.getAttribute("data-session-rendered-user-count")) !== "12") continue
      beforeAnchor = await page.evaluate(() =>
        (window as unknown as { __cachedTurnAnchor?: { key: string; offset: number } }).__cachedTurnAnchor,
      )
      break
    }
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "12", { timeout: 20_000 })
    expect(beforeAnchor).toBeDefined()

    await expect.poll(() => scroller.evaluate((viewport, anchor) => {
      const view = viewport.getBoundingClientRect()
      const retained = [...viewport.querySelectorAll<HTMLElement>("[data-timeline-key]")]
        .find((element) => element.dataset.timelineKey === anchor.key)
      if (!retained) return false
      const retainedRect = retained.getBoundingClientRect()
      return retainedRect.bottom > view.top && retainedRect.top < view.bottom
    }, beforeAnchor!), { timeout: 5_000 }).toBe(true)
  })

  test("a mounted user message never changes from a plain preview to the canonical renderer", async ({ page }) => {
    await page.addInitScript(() => {
      const state = { previewMounts: 0 }
      Object.defineProperty(window, "__claxedoTimelineRendererTransitions", {
        configurable: true,
        value: state,
      })
      const record = (node: Node) => {
        if (!(node instanceof Element)) return
        if (node.matches("[data-session-message-preview]")) state.previewMounts += 1
        state.previewMounts += node.querySelectorAll("[data-session-message-preview]").length
      }
      new MutationObserver((records) => {
        for (const mutation of records) {
          for (const node of mutation.addedNodes) record(node)
        }
      }).observe(document, { childList: true, subtree: true })
    })

    await page.setViewportSize({ width: 1280, height: 500 })
    const rows = seededTurnRows(8)
    const pendingAssistant = rows.at(-1)
    if (pendingAssistant?.info.time && typeof pendingAssistant.info.time === "object") {
      delete (pendingAssistant.info.time as Record<string, unknown>).completed
    }
    await installMutableSession(page, { rows, status: "busy" })
    await gotoSession(page)

    const timeline = page.locator("[data-session-timeline-root]")
    await expect(timeline).toHaveAttribute("data-session-timeline-progressive-ready", "true", { timeout: 20_000 })
    await scrollTimelineToTop(page)
    await timelineScroller(page).hover()
    await page.mouse.wheel(0, 500)

    const previewMounts = await page.evaluate(() => {
      return (
        window as typeof window & {
          __claxedoTimelineRendererTransitions?: { previewMounts: number }
        }
      ).__claxedoTimelineRendererTransitions?.previewMounts ?? 0
    })
    expect(previewMounts).toBe(0)
    await expect(page.locator("[data-session-message-preview]")).toHaveCount(0)
  })

  test("the timeline stays pinned to the bottom while a reply streams in", async ({ page }) => {
    // Three turns must overflow the viewport together while each reply stays well under it:
    // the oracle needs the claimed reply's whole bounding box inside the viewport, which no
    // single overflowing message can satisfy at any scroll position.
    await page.setViewportSize({ width: 1280, height: 600 })
    const longReply = (turn: number, text: string) =>
      `ack ${turn}: ${text}\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(8)}`
    await openSessionWithFirstSend(page, { replyText: longReply, harnessModels: HARNESS_MODELS })
    // Overflow the timeline before the final, observed turn streams in.
    await sendAndProve(page, "second timeline message", "ack 2: second timeline message")
    await sendAndProve(page, "third timeline message", "ack 3: third timeline message")

    const scroller = timelineScroller(page)
    await expect.poll(async () => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 50), { timeout: 30_000 }).toBe(true)

    // Nothing scrolls manually here. Polled rather than sampled once: auto-follow settles
    // asynchronously after the last content lands, so an immediate read catches a mid-scroll
    // offset. What matters is that it arrives, and a scroller that never does still fails.
    await expect
      .poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), { timeout: 10_000 })
      .toBeLessThan(20)
  })

  test("a #message-<id> hash deep-link scrolls to the target message, including the comment-strip case", async ({ page }) => {
    const plainUserID = "msg_user_plain"
    const commentedUserID = "msg_user_commented"
    const rows: Array<{ info: AnyInfo; parts: AnyPart[] }> = [
      {
        info: { id: plainUserID, sessionID: SESSION_ID, role: "user", time: { created: Date.now() - 60_000 }, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } },
        parts: [{ id: `${plainUserID}_text`, sessionID: SESSION_ID, messageID: plainUserID, type: "text", text: "a plain message with no comments" }],
      },
      {
        info: {
          id: "msg_assistant_plain",
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: Date.now() - 59_000, completed: Date.now() - 58_000 },
          parentID: plainUserID,
          agent: "build",
          providerID: "opencode",
          modelID: "big-pickle",
          mode: "code",
          path: { cwd: DIR, root: DIR },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: "msg_assistant_plain_text", sessionID: SESSION_ID, messageID: "msg_assistant_plain", type: "text", text: "acknowledged" }],
      },
      {
        info: { id: commentedUserID, sessionID: SESSION_ID, role: "user", time: { created: Date.now() - 30_000 }, agent: "build", model: { providerID: "opencode", modelID: "big-pickle" } },
        parts: [
          { id: `${commentedUserID}_text`, sessionID: SESSION_ID, messageID: commentedUserID, type: "text", text: "please look at this" },
          {
            id: `${commentedUserID}_comment`,
            sessionID: SESSION_ID,
            messageID: commentedUserID,
            type: "text",
            text: "The user made the following comment regarding line 10 of src/app.ts: please fix this",
            synthetic: true,
            metadata: { claxedoComment: { path: "src/app.ts", comment: "please fix this", selection: { startLine: 10, startChar: 0, endLine: 10, endChar: 0 } } },
          },
        ],
      },
      {
        info: {
          id: "msg_assistant_commented",
          sessionID: SESSION_ID,
          role: "assistant",
          time: { created: Date.now() - 29_000, completed: Date.now() - 28_000 },
          parentID: commentedUserID,
          agent: "build",
          providerID: "opencode",
          modelID: "big-pickle",
          mode: "code",
          path: { cwd: DIR, root: DIR },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [{ id: "msg_assistant_commented_text", sessionID: SESSION_ID, messageID: "msg_assistant_commented", type: "text", text: "looking into it" }],
      },
    ]
    await installSeededSession(page, rows)

    await gotoSession(page, `#message-${plainUserID}`)
    const plainAnchor = page.locator(`#message-${plainUserID}`)
    await expect(plainAnchor).toHaveAttribute("data-timeline-row", "UserMessage", { timeout: 15_000 })
    await expect.poll(async () => {
      const box = await plainAnchor.boundingBox()
      const viewport = page.viewportSize()
      if (!box || !viewport) return false
      return box.y >= -1 && box.y < viewport.height
    }, { timeout: 15_000 }).toBe(true)

    // With comments it lands on the comment strip instead of the bubble.
    await gotoSession(page, `#message-${commentedUserID}`)
    const commentedAnchor = page.locator(`#message-${commentedUserID}`)
    await expect(commentedAnchor).toHaveAttribute("data-timeline-row", "CommentStrip", { timeout: 15_000 })
    await expect.poll(async () => {
      const box = await commentedAnchor.boundingBox()
      const viewport = page.viewportSize()
      if (!box || !viewport) return false
      return box.y >= -1 && box.y < viewport.height
    }, { timeout: 15_000 }).toBe(true)
  })
})
