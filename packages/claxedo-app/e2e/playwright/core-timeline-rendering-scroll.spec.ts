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
import { readFile, writeFile } from "node:fs/promises"
import { installMockRuntime, type MockRuntimeOptions, type MockMessageRow } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"
import { readTextRangeGeometry, readScrollPosition, sampleElementDuringAction, sampleTranscriptGeometry, timelineScroller, scrollTimelineToTop } from "../helpers/geometry-oracle"

import { expectRailRowVisible } from "../helpers/rail-oracle"

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

async function seedOneProject(page: Page, dir: string, scheme?: "light" | "dark") {
  await page.addInitScript(({ d, scheme }: { d: string; scheme?: "light" | "dark" }) => {
    localStorage.clear()
    if (scheme) {
      localStorage.setItem("opencode-theme-id", "codex")
      localStorage.setItem("opencode-color-scheme", scheme)
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
  }, { d: dir, scheme })
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
  return page.getByRole("textbox", { name: /Ask anything/i }).filter({ visible: true }).last()
}

function submitControl(page: Page) {
  return page.locator(`${SELECTORS.submitControl}:visible`).last()
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

// This spec proves what a freshly (re)loaded session renders from its REST
// reads alone, independent of the live stream: the unconditional first-fold
// hydrate in `session-controller.ts` (the `shouldHydrateSession` effect) —
// `syncCompatSession` (`GET .../message`) fires once on mount, and
// `refreshMeta` (`GET /session/status`) ~1.5s later. So it drives
// busy→settle and pending→answered transitions by overriding those two GET
// routes with MUTABLE state and calling `page.reload()` between assertions,
// instead of a live SSE push.
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

  test("a pending question tool call renders no row; an answered one renders its answer card", async ({ page }) => {
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

    const answeredContent = page.locator('[data-timeline-part-id="q_answered"] [data-component="question-card"]')
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

  for (const scheme of ["light", "dark"] as const) {
    test(`expanded output is readable with visible scrollbars in ${scheme} theme`, async ({ page }, testInfo) => {
      const rows = seededTurnRows(1)
      rows[1].parts.unshift(toolPart({
        id: "readable_output", messageID: "msg_assistant_01", tool: "bash",
        input: { command: "print numbered lines" },
        output: Array.from({ length: 100 }, (_, i) => `readable line ${i + 1}`).join("\n"),
      }))
      rows[1].parts.splice(1, 0, toolPart({
        id: "readable_web", messageID: "msg_assistant_01", tool: "webfetch",
        input: { url: "https://example.com" }, output: Array.from({ length: 100 }, (_, i) => `web line ${i + 1}`).join("\n\n"),
      }))
      await installMockRuntime(page, {
        dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
        existingSession: { messages: rows as unknown as MockMessageRow[] },
      })
      await seedOneProject(page, DIR, scheme)
      await gotoSession(page)
      await expandWorkGroupIfPresent(page, "readable_output,readable_web")
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme)
      const group = page.locator('[data-component="work-group-list"]')
      const tool = page.locator('[data-timeline-part-id="readable_output"]')
      const trigger = tool.locator('[data-slot="collapsible-trigger"]')
      await expect(trigger).toBeVisible()
      if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
      const output = tool.locator('[data-slot="bash-scroll"]')
      await expect(output).toContainText("readable line 100")
      await page.mouse.move(0, 0)
      const style = await output.evaluate(element => {
        const code = element.querySelector("code")!
        return {
          text: getComputedStyle(code).color,
          scrollbar: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
          scrollbarDisplay: getComputedStyle(element, "::-webkit-scrollbar").display,
          scrollbarWidth: getComputedStyle(element).scrollbarWidth,
          overflow: element.scrollHeight > element.clientHeight,

        }
      })
      await writeFile(testInfo.outputPath("output-styles.json"), JSON.stringify(style, null, 2))
      await page.screenshot({ path: testInfo.outputPath("expanded-output.png") })
      const color = style.text.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      const luminance = color.map(c => c / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      const light = 0.2126 * luminance[0] + 0.7152 * luminance[1] + 0.0722 * luminance[2]
      expect(scheme === "light" ? 1.05 / (light + 0.05) : (light + 0.05) / 0.05).toBeGreaterThan(4.5)
      expect(await group.evaluate(element => getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor)).not.toBe("rgba(0, 0, 0, 0)")
      await expect(tool.locator('[data-slot="basic-tool-tool-leading-icon"]')).toBeVisible()
      expect(style.scrollbarDisplay).not.toBe("none")
      expect(style.scrollbarWidth).not.toBe("none")
      expect(style.overflow).toBe(true)
      expect(style.scrollbar).not.toBe("rgba(0, 0, 0, 0)")
      await output.evaluate(element => { element.scrollTop = 120 })
      await expect.poll(() => output.evaluate(element => element.scrollTop)).toBe(120)
    })
  }

  test("Show all preserves the visible line in already scrolled shell output", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const rows = seededTurnRows(1)
    rows[1].parts.unshift(toolPart({
      id: "reading_output", messageID: "msg_assistant_01", tool: "bash",
      input: { command: "print 300 numbered lines" },
      output: Array.from({ length: 300 }, (_, index) => `reading line ${index + 1}`).join("\n"),
    }))
    await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
      existingSession: { messages: rows as unknown as MockMessageRow[] },
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await sendAndProve(page, "output reading probe", "ack 1: output reading probe")
    const scroller = timelineScroller(page)
    await scroller.evaluate(element => { element.scrollTop = 0 })
    const tool = page.locator('[data-timeline-part-id="reading_output"]')
    const trigger = tool.locator('[data-slot="collapsible-trigger"]')
    await expect(trigger).toBeVisible()
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
    const toggle = tool.locator('[data-slot="scrollable-output-toggle"]')
    await expect(toggle).toHaveText("Show all")
    const output = tool.locator('[data-slot="bash-scroll"]')
    await output.evaluate(element => { element.scrollTop = 280 })
    await expect.poll(async () => (await readScrollPosition(output)).top).toBe(280)
    const line = tool.locator('[data-slot="bash-pre"] code')
    const before = await readTextRangeGeometry(line, "reading line 16")
    const box = await output.boundingBox()
    expect(box).not.toBeNull()
    expect(before.y).toBeGreaterThan(box!.y)
    expect(before.y + before.height).toBeLessThan(box!.y + box!.height)
    await page.screenshot({ path: testInfo.outputPath("reading-before.png") })
    await toggle.click()
    await expect(toggle).toHaveText("Show less")
    const firstAfter = await readTextRangeGeometry(line, "reading line 16")
    await page.screenshot({ path: testInfo.outputPath("reading-after.png") })
    const afterScreenshot = await readTextRangeGeometry(line, "reading line 16")
    await writeFile(testInfo.outputPath("reading-position.json"), JSON.stringify({ before, firstAfter, afterScreenshot }, null, 2))
    expect(Math.max(Math.abs(firstAfter.y - before.y), Math.abs(afterScreenshot.y - before.y))).toBeLessThanOrEqual(2)
  })

  test("expanded shell output survives scrolling out of the virtualized transcript", async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    const rows = seededTurnRows(30)
    rows[1].parts.unshift(toolPart({
      id: "retained_output", messageID: "msg_assistant_01", tool: "bash",
      input: { command: "print 300 numbered lines" },
      output: Array.from({ length: 300 }, (_, index) => `retention line ${index + 1}`).join("\n"),
    }))
    await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
      existingSession: { messages: rows as unknown as MockMessageRow[] },
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await sendAndProve(page, "output retention probe", "ack 1: output retention probe")
    const root = page.locator('[data-testid="session-page-root"]')
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await root.getAttribute("data-session-rendered-user-count") === "31") break
      await scrollTimelineToTop(page)
      await page.getByRole("button", { name: /^\d+ previous messages$/ }).click()
    }
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "31")
    const scroller = timelineScroller(page)
    await scroller.evaluate(element => { element.scrollTop = 0 })
    const tool = page.locator('[data-timeline-part-id="retained_output"]')
    await expect(tool).toBeVisible()
    const trigger = tool.locator('[data-slot="collapsible-trigger"]')
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
    const toggle = tool.locator('[data-slot="scrollable-output-toggle"]')
    await expect(toggle).toHaveText("Show all")
    await toggle.click()
    await expect(toggle).toHaveText("Show less")
    await page.screenshot({ path: testInfo.outputPath("output-expanded.png") })
    await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect(tool).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="UserMessage"]').filter({ hasText: "output retention probe" })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath("output-unmounted.png") })
    await scroller.evaluate(element => { element.scrollTop = 0 })
    await expect(tool).toBeVisible()
    await expect(trigger).toHaveAttribute("aria-expanded", "true")
    await page.screenshot({ path: testInfo.outputPath("output-returned.png") })
    await expect(toggle).toHaveText("Show less")
    await expect(tool.locator('[data-slot="bash-scroll"]')).toHaveAttribute("data-revealed", "true")
  })

  test("Home and End reach the endpoints of a fully loaded heavy transcript", async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
      existingSession: { messages: seededTurnRows(60) as unknown as MockMessageRow[] },
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await sendAndProve(page, "keyboard endpoint probe", "ack 1: keyboard endpoint probe")
    const root = page.locator('[data-testid="session-page-root"]')
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await root.getAttribute("data-session-rendered-user-count") === "61") break
      await scrollTimelineToTop(page)
      await page.getByRole("button", { name: /^\d+ previous messages$/ }).click()
    }
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "61")
    const scroller = timelineScroller(page)
    await scroller.hover()
    await page.mouse.wheel(0, (await readScrollPosition(scroller)).max / 2)
    const before = await readScrollPosition(scroller)
    expect(before.max).toBeGreaterThan(5000)
    expect(before.top).toBeGreaterThan(1000)
    await scroller.focus()
    await expect(scroller).toBeFocused()
    await page.keyboard.press("Home")
    await expect.soft.poll(async () => (await readScrollPosition(scroller)).top, { timeout: 10_000 }).toBeLessThanOrEqual(2)
    const home = await readScrollPosition(scroller)
    await page.screenshot({ path: testInfo.outputPath("home-endpoint.png") })
    await expect.soft(page.locator('[data-message-id="msg_user_01"][data-timeline-row="UserMessage"]')).toBeInViewport()
    await page.keyboard.press("End")
    await expect.soft.poll(async () => {
      const position = await readScrollPosition(scroller)
      return position.max - position.top
    }, { timeout: 10_000 }).toBeLessThanOrEqual(2)
    const end = await readScrollPosition(scroller)
    await page.screenshot({ path: testInfo.outputPath("end-endpoint.png") })
    await expect.soft(page.locator('[data-timeline-row="UserMessage"]').filter({ hasText: "keyboard endpoint probe" })).toBeInViewport()
    await writeFile(testInfo.outputPath("keyboard-endpoints.json"), JSON.stringify({ before, home, end }, null, 2))
  })

  for (const mode of ["idle", "streaming", "finishes-hidden"] as const) test(`returning to a ${mode} heavy session restores the reading position`, async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const otherId = "ses_idle_return_other"
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
      holdTurn: mode !== "idle",
      existingSession: { messages: seededTurnRows(60) as unknown as MockMessageRow[] },
      otherSessions: [{ id: otherId, title: "Other idle session", prompt: "Other idle prompt", reply: "Other idle reply" }],
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await ensureComposerModelSelected(page)
    await composer(page).fill("idle return probe")
    await submitControl(page).click()
    if (mode === "idle") {
      await expectAssistantReplyVisible(page, "ack 1: idle return probe", { spec: "core-timeline-rendering-scroll", scenario: `idle-first-${testInfo.repeatEachIndex}` })
    } else {
      await expect(submitControl(page)).toHaveAttribute("data-icon", "stop")
    }
    let runningAssistant: AnyInfo = {}
    if (mode !== "idle") await expect.poll(async () => {
      const body = await page.evaluate(async id => (await fetch(`/session/${id}/message`)).json(), SESSION_ID)
      runningAssistant = body.messages?.find((row: MockMessageRow) => row.info.id === mock.requests.promptBodies[0]?.assistantID)?.info ?? {}
      return runningAssistant.id
    }).toBeTruthy()
    const root = page.locator('[data-testid="session-page-root"]')
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await root.getAttribute("data-session-rendered-user-count") === "61") break
      await scrollTimelineToTop(page)
      await page.getByRole("button", { name: /^\d+ previous messages$/ }).click()
    }
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "61")
    const scroller = timelineScroller(page)
    await scroller.hover()
    await page.mouse.wheel(0, (await readScrollPosition(scroller)).max / 2)
    await expect.poll(async () => (await readScrollPosition(scroller)).top).toBeGreaterThan(1000)
    const before = await readScrollPosition(scroller)
    expect(before.max).toBeGreaterThan(5000)
    expect(before.top).toBeLessThan(before.max * 0.8)
    await page.screenshot({ path: testInfo.outputPath("idle-middle.png") })
    await (await expectRailRowVisible({ page, sessionId: otherId })).click()
    await expect(page.locator(SELECTORS.assistantContent).filter({ hasText: "Other idle reply" })).toBeVisible()
    if (mode !== "idle") {
      const assistant = runningAssistant
      mock.emit({ type: "message.part.updated", properties: { part: {
        id: `${assistant.id}_text`, messageID: assistant.id, sessionID: SESSION_ID,
        type: "text", text: "Output that arrived while you read another session.\n\n".repeat(50),
      } } } as never, DIR)
      if (mode === "finishes-hidden") {
        mock.emit({ type: "message.updated", properties: { info: { ...assistant, time: { ...(assistant.time as Record<string, unknown>), completed: Date.now() } } } } as never, DIR)
        mock.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } }, DIR)
      }
    }
    const returningFrames = page.evaluate(async sessionId => {
      const samples: number[] = []
      for (let frame = 0; frame < 120; frame++) {
        await new Promise(requestAnimationFrame)
        if (!location.pathname.endsWith(`/session/${sessionId}`) && !location.pathname.endsWith(`/s/${sessionId}`)) continue
        const pageRoot = document.querySelector(`[data-testid="session-page-root"][data-session-id="${sessionId}"]`)
        const element = pageRoot?.querySelector('[data-slot="session-timeline-scroll"] [data-scrollable]')
        if (element instanceof HTMLElement && element.checkVisibility() && element.clientHeight > 0) samples.push(element.scrollTop)
      }
      return samples
    }, SESSION_ID)
    await (await expectRailRowVisible({ page, sessionId: SESSION_ID })).click()
    await expect(page).toHaveURL(sessionUrlPattern(SESSION_ID))
    if (mode === "streaming") {
      await expect(submitControl(page)).toHaveAttribute("data-icon", "stop")
    }
    else await expect(submitControl(page)).not.toHaveAttribute("data-icon", "stop")
    await expect.poll(async () => Math.abs((await readScrollPosition(timelineScroller(page))).top - before.top), { timeout: 10_000 }).toBeLessThanOrEqual(2)
    const returned = await readScrollPosition(timelineScroller(page))
    const frames = await returningFrames
    await writeFile(testInfo.outputPath("return-frames.json"), JSON.stringify(frames))
    expect(frames.length).toBeGreaterThan(10)
    expect(Math.max(...frames.map(top => Math.abs(top - before.top))), "every visible return frame preserves the reading position").toBeLessThanOrEqual(2)
    await writeFile(testInfo.outputPath("idle-return-position.json"), JSON.stringify({ before, returned }, null, 2))
    await page.screenshot({ path: testInfo.outputPath("idle-return.png") })
    expect(mock.requests.unhandled).toEqual([])
    await scrollTimelineToTop(page)
    await expect(page.locator(SELECTORS.assistantContent).filter({ hasText: "Reply 1. A short acknowledgement for turn 1." })).toBeVisible()
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

  test("the first wheel keeps the visible answer in place when cold history expands @first-interaction", async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 600 })
    const base = seededTurnRows(1)
    const assistant = base[1]
    const rows = [base[0], ...Array.from({ length: 12 }, (_, index) => {
      const id = `msg_assistant_cold_${String(index).padStart(2, "0")}`
      return {
        info: { ...assistant.info, id },
        parts: [{ id: `${id}_text`, sessionID: SESSION_ID, messageID: id, type: "text", text:
          index === 11
            ? Array.from({ length: 9 }, (_, line) => `Final answer paragraph ${line}. This is the response the reader is looking at.`).join("\n\n")
            : `Earlier analysis ${index}. ` + "Working through the details. ".repeat(8),
        }, ...(index === 11 ? [] : [{ id: `${id}_tool`, sessionID: SESSION_ID, messageID: id,
          type: "tool", tool: "bash", callID: `${id}_call`, state: { status: "completed", input: { command: "pwd" }, output: DIR, title: "pwd", metadata: {}, time: { start: 1, end: 2 } },
        }])],
      }
    })]
    await installSeededSession(page, rows)
    await gotoSession(page)
    const answerSelector = '[data-timeline-part-id="msg_assistant_cold_11_text"] [data-markdown-block]:last-child p'
    const answer = page.locator(answerSelector)
    await expect(answer).toBeAttached()
    const before = await answer.boundingBox()
    expect(before).not.toBeNull()
    await timelineScroller(page).hover()
    await page.mouse.wheel(0, -1)
    const samples = await sampleTranscriptGeometry(page, {
      rowSelector: answerSelector,
      composerSelector: '[data-component="prompt-input"]',
      submitSelector: SELECTORS.submitControl,
      frames: 45,
    })
    await writeFile(testInfo.outputPath("cold-history-wheel-geometry.json"), JSON.stringify({ before, samples }, null, 2))
    expect(samples.every(sample => sample.row !== null), "the measured paragraph remains mounted").toBe(true)
    expect(Math.max(...samples.map(sample => Math.abs(sample.row!.y - before!.y)))).toBeLessThan(5)
    await expectAssistantReplyVisible(page, "Final answer paragraph 8.", { spec: "core-timeline-rendering-scroll", scenario: "cold-history-first-wheel" })
  })

  test("a short follow-up preserves the existing transcript row with a stationary composer", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const { mock } = await openSessionWithFirstSend(page, { harnessModels: HARNESS_MODELS })
    await composer(page).fill("short follow-up")
    const [samples] = await Promise.all([
      sampleTranscriptGeometry(page, {
        rowSelector: SELECTORS.userMessageContent,
        composerSelector: '[data-component="prompt-input"]',
        submitSelector: SELECTORS.submitControl,
        frames: 180,
      }),
      submitControl(page).click(),
    ])
    await testInfo.attach("transcript-and-composer-geometry", {
      body: JSON.stringify(samples), contentType: "application/json",
    })
    await writeFile(testInfo.outputPath("geometry-and-transport.json"), JSON.stringify({
      samples, eventWebSocketConnections: mock.requests.eventWebSocketConnections,
      unhandled: mock.requests.unhandled, failed: mock.requests.failed,
      badResponses: mock.requests.badResponses,
    }, null, 2))
    expect(mock.requests.unhandled, "no API request escapes the mock").toEqual([])
    expect(mock.requests.eventWebSocketConnections, "the app consumes the shared central event transport").toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath("geometry-after-send.png") })
    expect(mock.requests.promptCount).toBe(2)
    expect(samples.some(sample => sample.submitIcon === "stop"), "sample window includes the running turn").toBe(true)
    expect(samples.at(-1)?.submitIcon, "sample window reaches the ready composer").toMatch(/^(send|arrow-undo-down)$/)
    expect(samples.every(sample => sample.row !== null && sample.composer !== null)).toBe(true)
    const first = samples[0]
    expect(first.row).not.toBeNull()
    expect(first.composer).not.toBeNull()
    expect(Math.max(...samples.map(sample => Math.abs(sample.composer!.y - first.composer!.y)))).toBeLessThanOrEqual(1)
    expect(Math.max(...samples.map(sample => Math.abs(sample.composer!.height - first.composer!.height)))).toBeLessThanOrEqual(1)
    expect(Math.max(...samples.map(sample => Math.abs(sample.row!.y - first.row!.y))), "existing row moves without composer movement or scroll input").toBeLessThanOrEqual(1)
    await expectAssistantReplyVisible(page, "ack 2: short follow-up")
  })

  test("a Codex first reply token preserves the existing prompt with a stationary composer", async ({ page }, testInfo) => {
    const fixture = JSON.parse(await readFile(new URL("../fixtures/codex-first-token-geometry.json", import.meta.url), "utf8")) as {
      previousMessages: MockMessageRow[]
      turn: MockMessageRow[]
    }
    await page.setViewportSize({ width: 1512, height: 861 })
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID,
      harness: "codex-app-server", holdTurn: true,
      existingSession: { messages: fixture.previousMessages },
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await expectAssistantReplyVisible(page, "QA_COMPLETE_DONE_987", {
      spec: "core-timeline-rendering-scroll",
      scenario: `first-token-previous-${testInfo.repeatEachIndex}`,
    })
    await ensureComposerModelSelected(page)
    const prompt = fixture.turn[0].parts[0].text
    await composer(page).fill(prompt)
    await submitControl(page).click()
    await expect(submitControl(page)).toHaveAttribute("data-icon", "stop")
    let assistant: AnyInfo = {}
    await expect.poll(async () => {
      const body = await page.evaluate(async id => (await fetch(`/session/${id}/message`)).json(), SESSION_ID)
      assistant = body.messages?.find((row: MockMessageRow) => row.info.id === mock.requests.promptBodies[0]?.assistantID)?.info ?? {}
      return assistant.id
    }).toBeTruthy()
    const assistantID = String(assistant.id)
    const tool = { ...fixture.turn[1].parts[0], messageID: assistantID }
    mock.emit({ type: "message.part.updated", properties: { part: tool } } as never, DIR)
    await expect(page.locator(`[data-timeline-part-id="${tool.id}"]`)).toBeVisible()
    const geometryInput = {
      rowSelector: `[data-message-id="${String(assistant.parentID)}"] ${SELECTORS.userMessageContent}`,
      composerSelector: '[data-component="prompt-input"]',
      submitSelector: SELECTORS.submitControl,
      frames: 90,
    }
    const before = await sampleTranscriptGeometry(page, { ...geometryInput, frames: 30 })
    const initial = before.at(-1)!
    expect(initial.row).not.toBeNull()
    expect(initial.composer).not.toBeNull()
    expect(Math.max(...before.slice(-10).map(sample => Math.abs(sample.row!.y - initial.row!.y))), "the completed tool settles before the first-token measurement").toBeLessThanOrEqual(1)
    const scrollBefore = await readScrollPosition(timelineScroller(page))
    await page.screenshot({ path: testInfo.outputPath("first-token-before.png") })
    const text = { ...fixture.turn[1].parts[1], messageID: assistantID, text: "QA_SH" }
    const [samples] = await Promise.all([
      sampleTranscriptGeometry(page, geometryInput),
      (async () => {
        mock.emit({ type: "message.part.updated", properties: { part: text } } as never, DIR)
        await expect(page.locator(`[data-timeline-part-id="${text.id}"]`)).toBeVisible()
        await page.screenshot({ path: testInfo.outputPath("first-token-arrived.png") })
      })(),
    ])
    const scrollAfter = await readScrollPosition(timelineScroller(page))
    await writeFile(testInfo.outputPath("first-token-geometry.json"), JSON.stringify({ before, samples, scrollBefore, scrollAfter }, null, 2))
    // The sampler's first entry is synchronous and can observe virtualizer layout before the next animation frame.
    const animationFrames = samples.slice(1)
    expect(samples.every(sample => sample.row !== null && sample.composer !== null)).toBe(true)
    expect(Math.max(...samples.map(sample => Math.abs(sample.composer!.y - initial.composer!.y)))).toBeLessThanOrEqual(1)
    expect(Math.max(...samples.map(sample => Math.abs(sample.composer!.height - initial.composer!.height)))).toBeLessThanOrEqual(1)
    expect.soft(Math.max(...animationFrames.map(sample => Math.abs(sample.row!.y - initial.row!.y))), "the existing prompt stays in place when the first reply token arrives").toBeLessThanOrEqual(1)
    mock.emit({ type: "message.part.updated", properties: { part: { ...text, text: fixture.turn[1].parts[1].text } } } as never, DIR)
    mock.emit({ type: "message.updated", properties: { info: {
      ...assistant, time: { ...(assistant.time as Record<string, unknown>), completed: Date.now() },
    } } } as never, DIR)
    mock.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } } as never, DIR)
    await expectAssistantReplyVisible(page, "QA_SHIMMER_DONE_989", {
      spec: "core-timeline-rendering-scroll",
      scenario: `first-token-completed-${testInfo.repeatEachIndex}`,
    })
    expect(mock.requests.promptCount).toBe(1)
    expect(mock.requests.unhandled).toEqual([])
  })

  test("streaming interleaved commands never duplicates paragraphs", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1200 })
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
      existingSession: { messages: seededTurnRows(1) as unknown as MockMessageRow[] }, holdTurn: true,
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await ensureComposerModelSelected(page)
    await composer(page).fill("Review interleaved rendering")
    await submitControl(page).click()
    await expect.poll(() => mock.requests.promptBodies[0]?.assistantID).toBeTruthy()
    const messageID = mock.requests.promptBodies[0]!.assistantID
    const emit = (part: AnyPart) => mock.emit({ type: "message.part.updated", properties: { part: { sessionID: SESSION_ID, messageID, ...part } } } as never, DIR)
    for (let i = 0; i < 5; i++) {
      emit({ id: `unique-text-${i}`, type: "text", text: `Unique paragraph ${i}`, time: { start: 1, end: 2 } })
      for (let j = 0; j < 4; j++) {
        const part = { id: `tool-${i}-${j}`, type: "tool", tool: "bash", callID: `call-${i}-${j}`,
          state: { status: "running", input: { command: `echo ${i}-${j}` }, time: { start: 1 } } }
        emit(part)
        await expect(page.locator(`[data-timeline-part-id="unique-text-${i}"]`)).toHaveCount(1)
        emit({ ...part, state: { ...part.state, status: "completed", output: "ok", title: "echo", time: { start: 1, end: 2 } } })
      }
      for (let k = 0; k <= i; k++) {
        await expect(page.locator(`[data-timeline-part-id="unique-text-${k}"]`)).toHaveCount(1)
      }
    }
  })

  test("streamed tables and ordered lists render available rows before completion", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1200 })
    const mock = await installMockRuntime(page, {
      dir: DIR, sessionId: SESSION_ID, projectId: PROJECT_ID, harnessModels: HARNESS_MODELS,
      existingSession: { messages: seededTurnRows(1) as unknown as MockMessageRow[] }, holdTurn: true,
    })
    await seedOneProject(page, DIR)
    await gotoSession(page)
    await ensureComposerModelSelected(page)
    await composer(page).fill("Stream a table then a list")
    await submitControl(page).click()
    let assistant: AnyInfo = {}
    await expect.poll(async () => {
      const body = await page.evaluate(async id => (await fetch(`/session/${id}/message`)).json(), SESSION_ID)
      assistant = body.messages?.find((row: MockMessageRow) => row.info.id === mock.requests.promptBodies[0]?.assistantID)?.info ?? {}
      return assistant.id
    }).toBeTruthy()
    const blocks = [
      { id: "live-table", selector: "tbody tr", prefix: "| Step | Result |\n| --- | --- |\n| 1 | First |\n", suffix: "| 2 | Second |\n" },
      { id: "live-list", selector: "li", prefix: "1. First item\n", suffix: "2. Second item\n" },
    ]
    for (const block of blocks) {
      const part = { id: block.id, sessionID: SESSION_ID, messageID: assistant.id, type: "text", text: block.prefix, time: { start: Date.now() } }
      mock.emit({ type: "message.part.updated", properties: { part } } as never, DIR)
      const body = page.locator(`[data-timeline-part-id="${block.id}"]`)
      // Check before the producer is allowed to send the rest or complete.
      await expect(body.locator(block.selector)).toHaveCount(1)
      await expect(body).toBeVisible()
      mock.emit({ type: "message.part.delta", properties: { sessionID: SESSION_ID, messageID: String(assistant.id), partID: block.id, field: "text", delta: block.suffix } }, DIR)
      await expect(body.locator(block.selector)).toHaveCount(2)
      mock.emit({ type: "message.part.updated", properties: { part: { ...part, text: block.prefix + block.suffix, time: { ...part.time, end: Date.now() } } } } as never, DIR)
      await expect(body.locator(block.selector)).toHaveCount(2)
    }
    await page.screenshot({ path: testInfo.outputPath("blocks-before-message-completion.png") })
    mock.emit({ type: "message.part.updated", properties: { part: { id: "later-text", messageID: assistant.id, sessionID: SESSION_ID, type: "text", text: "Later text is still streaming" } } } as never, DIR)
    await expect(page.locator('[data-timeline-part-id="later-text"]')).toBeVisible()
    for (const block of blocks) await expect(page.locator(`[data-timeline-part-id="${block.id}"]`).locator(block.selector)).toHaveCount(2)
    mock.emit({ type: "message.updated", properties: { info: { ...assistant, time: { ...(assistant.time as Record<string, unknown>), completed: Date.now() } } } } as never, DIR)
    mock.emit({ type: "session.idle", properties: { sessionID: SESSION_ID } }, DIR)
    for (const block of blocks) await expect(page.locator(`[data-timeline-part-id="${block.id}"]`).locator(block.selector)).toHaveCount(2)
    expect(mock.requests.unhandled).toEqual([])
  })

  test("loading a user Markdown image preserves its reserved space and the existing transcript position", async ({ page }, testInfo) => {
    let release!: () => void
    let requested = 0
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.setViewportSize({ width: 1280, height: 800 })
    const { mock } = await openSessionWithFirstSend(page, {
      harnessModels: HARNESS_MODELS,
      replyText: (turn, text) => turn === 1 ? `ack 1: ${text}` : "Image received",
      httpImages: [{
        pathname: "/qa-transcript-image.png",
        body: await readFile(new URL("../../public/web-app-manifest-512x512.png", import.meta.url)),
        beforeResponse: async () => { requested += 1; await pending },
      }, {
        pathname: "/qa-corrupt-image.png",
        body: Buffer.from("invalid PNG image bytes"),
      }, {
        pathname: "/qa-missing-image.png",
        status: 404,
        body: Buffer.from("Image not found"),
      }],
    })
    try {
      const imageUrl = new URL("/qa-transcript-image.png", page.url()).href
      const corruptUrl = new URL("/qa-corrupt-image.png", page.url()).href
      const missingUrl = new URL("/qa-missing-image.png", page.url()).href
      const missingResponse = page.waitForResponse(response => response.url() === missingUrl && response.status() === 404)
      await sendAndProve(page, `![QA image](${imageUrl}) ![QA corrupt image](${corruptUrl}) ![QA missing image](${missingUrl})`, "Image received")
      await missingResponse
      await expect.poll(() => requested).toBeGreaterThan(0)
      const image = page.locator(`${SELECTORS.userMessageContent} img`).last()
      const placeholder = page.locator(`${SELECTORS.userMessageContent} [data-state="loading"][aria-label="QA image"]`)
      await expect(placeholder).toBeVisible()
      await expect(placeholder).toHaveText("")
      const corrupt = page.locator(`${SELECTORS.userMessageContent} [data-component="markdown-image-fallback"]`).filter({ hasText: /^QA corrupt image$/ })
      await expect(corrupt).toBeVisible()
      const missing = page.locator(`${SELECTORS.userMessageContent} [data-component="markdown-image-fallback"]`).filter({ hasText: /^QA missing image$/ })
      await expect(missing).toBeVisible()
      const missingBefore = await missing.boundingBox()
      const decoded = await page.evaluate(async src => {
        const probe = new Image()
        probe.src = src
        return probe.decode().then(() => true, () => false)
      }, corruptUrl)
      expect(decoded, "the corrupt fixture fails the browser's image decoder").toBe(false)
      const corruptBefore = await corrupt.boundingBox()
      const messageId = await placeholder.evaluate(element => element.closest("[data-message-id]")?.getAttribute("data-message-id"))
      expect(messageId).toBeTruthy()
      const measure = (frames = 1) => sampleTranscriptGeometry(page, {
        rowSelector: `[data-message-id="${messageId}"] ${SELECTORS.userMessageContent}`,
        composerSelector: '[data-component="prompt-input"]',
        submitSelector: SELECTORS.submitControl,
        frames,
      })
      const before = (await measure())[0]
      const imageBefore = await placeholder.boundingBox()
      await page.screenshot({ path: testInfo.outputPath("image-before-load.png") })
      release()
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(512)
      const afterSamples = await measure(30)
      const after = afterSamples[afterSamples.length - 1]
      const imageAfter = await image.boundingBox()
      const corruptAfter = await corrupt.boundingBox()
      const missingAfter = await missing.boundingBox()
      await writeFile(testInfo.outputPath("image-geometry.json"), JSON.stringify({ before, after, afterSamples, imageBefore, imageAfter, corruptBefore, corruptAfter, missingBefore, missingAfter, decoded }, null, 2))
      await page.screenshot({ path: testInfo.outputPath("image-after-load.png") })
      expect(before.composer).not.toBeNull()
      expect(after.composer).not.toBeNull()
      expect(before.row).not.toBeNull()
      expect(after.row).not.toBeNull()
      expect(imageBefore).not.toBeNull()
      expect(imageAfter).not.toBeNull()
      expect(corruptBefore).not.toBeNull()
      expect(corruptAfter).not.toBeNull()
      expect(missingBefore).not.toBeNull()
      expect(missingAfter).not.toBeNull()
      for (const [state, box] of [["loading", imageBefore!], ["loaded", imageAfter!], ["corrupt", corruptBefore!], ["corrupt after adjacent load", corruptAfter!], ["HTTP 404", missingBefore!], ["HTTP 404 after adjacent load", missingAfter!]] as const) {
        expect.soft(Math.abs(box.width - 80), `${state} image tile is 80px wide`).toBeLessThanOrEqual(1)
        expect.soft(Math.abs(box.height - 80), `${state} image tile is 80px high`).toBeLessThanOrEqual(1)
      }
      expect(Math.abs(after.composer!.y - before.composer!.y)).toBeLessThanOrEqual(1)
      expect(Math.abs(after.composer!.height - before.composer!.height)).toBeLessThanOrEqual(1)
      expect.soft(Math.abs(imageAfter!.height - imageBefore!.height), "image load changes the space reserved in the user row").toBeLessThanOrEqual(1)
      expect(afterSamples.every(sample => sample.row && sample.composer), "the measured row and composer remain mounted").toBe(true)
      expect.soft(Math.max(...afterSamples.map(sample => Math.abs(sample.row!.y - before.row!.y))), "image load moves the existing transcript row").toBeLessThanOrEqual(1)
      expect(mock.requests.unhandled).toEqual([])
      await image.scrollIntoViewIfNeeded()
      const beforePreview = (await measure())[0]
      await image.click()
      const preview = page.locator('[data-slot="image-preview-image"]')
      await expect(preview).toBeVisible()
      await expect(preview).toHaveAttribute("src", imageUrl)
      await page.locator('[data-slot="image-preview-close"]').click()
      await expect(preview).toHaveCount(0)
      const afterPreview = (await measure())[0]
      expect(beforePreview.row).not.toBeNull()
      expect(afterPreview.row).not.toBeNull()
      expect(Math.abs(afterPreview.row!.y - beforePreview.row!.y), "closing the preview preserves the reading position").toBeLessThanOrEqual(1)
    } finally {
      release()
    }
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
