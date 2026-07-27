/**
 * SPEC: Timeline rendering — tool defaults, context grouping, diff summary, scroll
 *
 * PURPOSE — once a turn has content beyond plain text (tool calls, questions, file
 * diffs) and once a session has more than a screenful of history, the timeline module
 * (`src/pages/session/message-timeline.tsx` + `.data.ts`) is what decides what's shown
 * by default, what's grouped together, and how the viewport tracks new content vs. the
 * user's own scrolling. This spec owns that rendering/scroll layer — NOT the send flow
 * (`core-first-prompt-local`, `core-turns-reload-recovery`) and NOT the full
 * per-harness tool-renderer matrix (`core-harness-rendering-matrix`).
 *
 * STATE MODEL —
 *   Row derivation is pure and per-user-turn: `Timeline.constructMessageRows` (in
 *   `message-timeline.data.ts`) takes one `UserMessage` + its assistant reply
 *   message(s) and produces an ordered `TimelineRow.TimelineRow[]` (`TurnGap`,
 *   `CommentStrip`, `UserMessage`, `TurnDivider`, `AssistantPart`, `Thinking`, `Retry`,
 *   `DiffSummary`, `Error`). Rows are identity-keyed (`TimelineRow.key`) and reused
 *   across renders (`TimelineRow.reuse`) so a virtualizer (`@tanstack/solid-virtual`)
 *   can keep stable DOM nodes.
 *   Tool-part grouping: consecutive `read`/`glob`/`grep`/`list` tool parts are merged
 *   into one `{type:"context"}` `PartGroup` by `groupParts`; any other part type
 *   "flushes" the run, so two context runs separated by an unrelated tool become two
 *   separate groups. `groupParts` itself just walks whatever order it's given, but its
 *   input (`getMessageParts(messageID)`) always comes from the client's part store,
 *   which sorts every part list by `id` (`sortMessageParts` in
 *   `src/session/store/message-page.ts`) — real part IDs are monotonically increasing
 *   so this is a no-op for genuine traffic, but a fixture using descriptive, non-
 *   sortable IDs (e.g. this spec's own `toolPart` calls) must pick IDs that already sort
 *   in the intended emission order, or "consecutive" silently stops meaning what the
 *   test intends. `todowrite` is filtered out
 *   entirely (dock-only, never a row — see `hiddenTools`); a `question` tool part is
 *   filtered out of the row list ENTIRELY while `state.status` is `"pending"` or
 *   `"running"` (not just visually hidden — see `renderablePart` in
 *   `message-timeline.data.ts`).
 *   Tool-part open/closed default: `partDefaultOpen` (session-ui
 *   `message-part.tsx`) returns `settings.general.shellToolPartsExpanded()` for
 *   `bash`, `settings.general.editToolPartsExpanded()` for `edit`/`write`/`apply_patch`,
 *   and `undefined` (→ collapsed) for every other tool kind — these two booleans live
 *   in the persisted `Settings` store (`src/context/settings.tsx`, localStorage key
 *   `settings.v3`) and are toggled from Settings → General
 *   (`[data-action="settings-feed-shell-tool-parts-expanded"]` /
 *   `-edit-tool-parts-expanded`). This value only seeds a tool part's INITIAL open
 *   state; message-timeline.tsx passes it through a per-part `toolOpen` store
 *   (`toolOpen[part.id] ?? defaultOpen()`) so an untouched part stays reactive to the
 *   setting even after it renders. The `question` tool's own renderer overrides this
 *   with `defaultOpen={completed()}` (answers present ⇒ open), independent of the
 *   shell/edit settings.
 *   Diff summary: `DiffSummary` row's data comes from `UserMessage.summary.diffs`
 *   (per-turn, server-attached — not a stream event), deduped by file with the LAST
 *   occurrence in the array winning (`reduceRight` + skip-if-seen, then `.reverse()`),
 *   and only rendered when `status === "idle" || !isActive` (i.e., hidden for the
 *   turn that is still the live/busy one; visible for every settled or non-active
 *   turn) — this is enforced in `Timeline.constructMessageRows`, not CSS.
 *   Scroll: `createAutoScroll` (`packages/ui/src/hooks/create-auto-scroll.tsx`) owns
 *   "stay pinned to bottom while active, unless the user scrolled" — a `ResizeObserver`
 *   on the content re-triggers `scrollToBottom` on every size change (i.e., on every
 *   streamed delta) as long as `userScrolled()` is false; a real wheel/touch gesture
 *   away from the bottom flips `userScrolled` true and stops the auto-follow.
 *   Independently, `session.tsx` computes `ui.scroll.{overflow,bottom,jump}` from raw
 *   `scrollTop`/`scrollHeight` on every scroll frame; `jump` (the jump-to-bottom
 *   affordance) is true only once the viewport is more than
 *   `max(400, clientHeight)` px from the bottom of overflowing content. A bounded
 *   "history window" (`src/pages/session/history-window.ts`, `turnInit=4`,
 *   `turnBatch=8`, `turnScrollThreshold=200px`) renders only the most recent N
 *   already-fetched turns; scrolling within `turnScrollThreshold` of the top reveals
 *   more of the already-fetched (not re-fetched) turns via `backfillTurns`, adjusting
 *   `scrollTop` by the exact height delta added above (`preserveScroll`) so the
 *   viewport doesn't visibly jump — the deep pixel-preservation proof for THIS specific
 *   mechanism is `core-turns-reload-recovery`'s behavior 9; this spec's own "prepend"
 *   scenario instead pins the composition contract (no duplicate/orphaned rows, and
 *   jump-to-bottom still works correctly once older history has been revealed).
 *   Hash deep-link: `#message-<userMessageID>` is written/read by
 *   `useSessionHashScroll` (`src/pages/session/use-session-hash-scroll.ts`); the
 *   scrollable target's DOM id (`props.anchor(id)` = `message-<id>`, set in
 *   `session.tsx`) is placed on the `CommentStrip` row when the turn has inline review
 *   comments, and on the `UserMessage` row otherwise (`TimelineRowFrame`'s `anchor()`
 *   check in `message-timeline.tsx`) — so a commented turn's hash target scrolls to the
 *   comment strip, not the bubble underneath it.
 *
 * ANATOMY —
 *   `[data-message-id="<userMessageID>"]` — wraps EVERY row belonging to one turn
 *     (`TimelineRowFrame`); also carries `data-timeline-row="<TurnGap|CommentStrip|
 *     UserMessage|TurnDivider|AssistantPart|Thinking|Retry|DiffSummary|Error>"`.
 *   `[data-timeline-part-id="<partID>"]` — one tool/text part's wrapper
 *     (`data-component="tool-part-wrapper"` for tools); `[data-timeline-part-ids="id1,
 *     id2,..."]` — a `ContextToolGroup`'s wrapper (comma-joined member part ids).
 *   `[data-component="collapsible"]` / `[data-slot="collapsible-content"]` — every
 *     tool/context-group collapsible; the content element is only PRESENT in the DOM
 *     while open (Kobalte presence-unmounts it on close — `packages/ui/src/components/
 *     collapsible.tsx`), so its mere existence is a reliable open/closed signal.
 *   `[data-slot="context-tool-group-label"]` (shows "Exploring…"/"Explored") and
 *     `[data-slot="context-tool-group-summary"]` (e.g. "1 read · 2 searches · 1 list")
 *     inside a context group's trigger; `[data-slot="context-tool-group-item"]` per
 *     member once expanded.
 *   `[data-component="question-answers"]` / `[data-slot="question-answer-item"]` —
 *     rendered inside an answered `question` tool part.
 *   `[data-slot="session-turn-diffs"]` — the per-turn diff-summary row;
 *     `[data-slot="session-turn-diff-trigger"]` per file, `-diff-filename` for its
 *     basename text; `[data-slot="session-turn-diffs-more"]` ("+N more files", shown
 *     only when overflowing the 10-file preview) and `[data-slot="session-turn-diffs-
 *     toggle"]` (header "Show all"/"Show less") both flip the same `showAll` flag;
 *     `[data-slot="session-turn-diff-view"]` only mounts once its accordion item is
 *     expanded (lazy).
 *   The jump-to-bottom button has no stable data-attribute of its own; it is located
 *     via its icon (`[data-icon="scroll-to-latest"]`, the theme-independent semantic id)
 *     is controlled by the CSS `opacity`/`pointer-events` of its ancestor wrapper (see
 *     HARNESS/finding notes below for why a testid would help here).
 *   `[data-scrollable]:has([data-slot="session-turn-message-content"])` — the
 *     timeline's own scroll viewport (there can be other nested `[data-scrollable]`
 *     regions, e.g. a bash tool's output pane or a diff view).
 *   `[data-testid="session-page-root"]` carries `data-session-visible-user-count`
 *     (all fetched turns) and `data-session-rendered-user-count` (currently windowed
 *     subset) as plain string integers (`src/pages/session.tsx`).
 *   `#message-<userMessageID>` — the DOM id a hash deep-link targets (see STATE MODEL).
 *
 * BEHAVIORS —
 *   1. A `bash` tool part's default open/closed state follows
 *      `settings.general.shellToolPartsExpanded`, an `edit` tool part follows
 *      `settings.general.editToolPartsExpanded`, and an unrelated tool kind (e.g.
 *      `webfetch`) stays collapsed regardless of either setting.
 *   2. A `question` tool part renders no row at all while pending/running; once
 *      answered it renders already open, showing each question/answer pair.
 *   3. Consecutive `read`/`glob`/`grep`/`list` tool parts collapse into one expandable
 *      "Gathered context" group showing an aggregate read/search/list count; expanding
 *      it reveals one row per underlying call.
 *   4. A context-eligible run interrupted by an unrelated tool call (e.g.
 *      `read, read, bash, read`) renders as two independent groups, not one merged run.
 *   5. The diff-summary accordion is absent while its turn is the live/busy one and
 *      appears once the turn settles; multiple diff entries for the same file are
 *      deduped to one (the last-occurring entry wins); each file's diff view only
 *      mounts once its accordion item is expanded (lazy).
 *   6. When a turn's diff summary has more than 10 files, only the first 10 render
 *      initially with a "+N more files" affordance; expanding it reveals the rest and
 *      offers a "Show less" affordance that collapses back to the 10-file preview.
 *   7. The jump-to-bottom control is hidden while the viewport is at (or the content
 *      doesn't overflow) the bottom, appears once a real scroll gesture moves the
 *      viewport far enough from the bottom of overflowing content, and clicking it
 *      returns to the bottom.
 *   8. While a reply is actively streaming in, the timeline keeps itself pinned to the
 *      bottom as new content arrives, with no manual scrolling required.
 *   9. Scrolling to the top of a session with more already-fetched history than is
 *      initially rendered reveals the older turns in place without duplicating any row,
 *      and the jump-to-bottom control still correctly returns to (and stays at) the
 *      latest turn afterward.
 *   10. Navigating to a URL with a `#message-<id>` hash scrolls the timeline to that
 *       message on load; when the target turn carries an inline review-comment strip,
 *       the scroll lands on the comment strip (not the user bubble underneath it).
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state (#2 in
 *   e2e/INVARIANTS.md) — every turn proven here that carries a final text part goes
 *   through the shared oracle; the diff-summary busy/settle gate (behavior 5) is a
 *   second, row-specific instance of the same "never hide settled content, never show
 *   settle-only content early" discipline. Harness is fixed to `opencode` throughout
 *   (harness selection is `core-harness-ownership-local`'s territory).
 *
 * HARNESS NOTES — none directly; tool-part rendering IS harness-shape-sensitive in
 *   general (raw event traces differ per harness), but that full matrix is
 *   `core-harness-rendering-matrix`'s territory. This spec constructs `Part`/`Message`
 *   payloads directly in the already-normalized OpenCode v2 shape the client stores
 *   internally, to isolate rendering/grouping/scroll behavior from harness-translation
 *   concerns.
 *
 * OUT OF SCOPE — the send flow and its optimistic-row mechanics
 *   (`core-first-prompt-local`); reload/duplicate-row recovery, prompt history, and the
 *   deep pixel-level scroll-anchor-preservation proof for `backfillTurns`
 *   (`core-turns-reload-recovery`, its behavior 9); per-harness tool-renderer identity
 *   and event-trace fidelity (`core-harness-rendering-matrix`); permission/question
 *   DOCK mechanics — this spec only touches the `question` TOOL PART rendering, not the
 *   question-answering dock UI (`core-docks`); session rename/fork/revert/archive
 *   (`core-session-actions`); server-cursor-based `historyMore`/`loadMore` pagination
 *   (`x-next-cursor`) — the shared mock's `/session/:id/message` route never sets that
 *   header, so that path is unreachable here (same limitation `core-turns-reload-
 *   recovery` documents) and is left as a finding.
 *
 * FINDINGS (reported, not fixed here — see task output) — the jump-to-bottom control
 *   has no `data-testid`/`data-slot`/`aria-label` of its own; it can only be located via
 *   its icon's sprite href, which is more brittle than the rest of this module's very
 *   consistent `data-slot` contract. Separately: `installMockRuntime`'s `/api/workspace/
 *   resolve` mock always reports a `workspaceId` (even for `kind:"local"`), which makes
 *   `workspaceRuntimeOwnsLiveEvents()` (`src/context/global-sdk.tsx`) true for every
 *   mocked session and routes live event consumption through `/api/wr/runtime-events`
 *   instead of `/global/event` — unmocked outside `installMockRuntime`'s `cloud` option,
 *   so `bus.emit()`-pushed SSE events for a turn never reach the browser here. A real
 *   send still renders because `session-controller.ts`'s `activeTurnTransition` forces a
 *   `GET .../message` refetch once the LOCAL, submit-set `activeTurn()` flag settles —
 *   a path only a real composer submit enters. Behaviors 1–6 below therefore build their
 *   tool/diff/question content through mutable overrides of the `/session/:id/message`
 *   and `/session/status` GET routes (see `installMutableSession`'s doc comment) instead
 *   of the SSE bus; only behavior 8 (which needs a genuine multi-turn stream) drives a
 *   real send. A related Playwright gotcha found while wiring those overrides: a bare
 *   `page.route()` glob pattern with no trailing wildcard suffix (e.g. a pattern ending
 *   literally in `.../session/status`, no `**` after it) requires an EXACT end-of-URL
 *   match and silently fails to match once the app appends `?directory=...` (which it
 *   does on nearly every request) — the request then falls through to the shared mock's
 *   own generic single-segment `.../session/*` catch-all (which, being a wildcard, DOES
 *   swallow query-string characters) and gets served the
 *   wrong shape with no error of any kind. Confirmed via an isolated repro outside this
 *   suite. Every override pattern in `installSeededSession`/`installMutableSession` below
 *   carries a trailing `**` for exactly this reason — a future edit that drops one will
 *   silently start being served by the wrong handler. A third, app-level finding (this
 *   spec's own investigation, reproduced deterministically, not fixed here):
 *   `useSessionHashScroll`'s `seek()` (`src/pages/session/use-session-hash-scroll.ts`)
 *   corrects the scroll offset for a `#message-<id>` deep-link exactly ONCE, from
 *   `getBoundingClientRect()` at the first moment the target element exists in the DOM.
 *   For a session tall enough that rows above the target haven't been measured yet, the
 *   virtualizer (`message-timeline.tsx`) positions those rows using its fallback
 *   `estimateSize()` until each one's real height is reported (asynchronously, per-row);
 *   once real (larger) heights land, `virtualizer.shouldAdjustScrollPositionOnItemSizeChange`
 *   (message-timeline.tsx, right after the virtualizer's construction) only auto-corrects
 *   scroll for rows whose measured end is already `<= scrollOffset` (content already fully
 *   scrolled past) — it does not cover a target further down whose preceding rows just
 *   grew past the current scroll offset. Net effect: deep-linking to a message that isn't
 *   near the top of a long/virtualized session's initially-rendered window can leave the
 *   viewport permanently short of the true target position (by however much the
 *   preceding rows' real heights exceeded the estimate), with the jump-to-bottom control
 *   visibly stuck showing even though the user just navigated to the latest message —
 *   observed directly via this spec's own attempted "jump-to-bottom" scenario before it
 *   was reworked to establish its rest position without a hash (see that test's comments).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime, type MockRuntimeOptions } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, expectNoDuplicateRows, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-timeline-rendering-scroll"
const SESSION_ID = "ses_core_timeline_rendering_scroll"
const PROJECT_ID = "proj_mock_runtime"

// The mock's DEFAULT opencode model is the `big-pickle` placeholder
// (`signed-workspace-model.ts` `SIGNED_WORKSPACE_DEFAULT_MODEL`), which the app
// deliberately filters out of `firstConnectedModelInfo`/`selectRuntimeModel`
// (`src/features/session/composer/model-strategy.ts`) so it can never be picked as a
// real default — composer submit stays blocked with "Choose a model to continue"
// (`no-model`, `submit-block-reason.ts`) until a real model is connected. The one
// scenario in this spec that drives a real composer send (behavior 8) needs a real,
// non-placeholder model available, matching the pattern `core-first-prompt-local.spec.ts`
// already uses for its own send test.
const HARNESS_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

type AnyPart = Record<string, unknown>
type AnyInfo = Record<string, unknown>

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
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

// --- Part/message builders -------------------------------------------------
// These construct raw SDK v2 `Part`/`Message` shapes. Every scenario below that
// needs tool/diff/question content it can't get from the shared mock's
// text-only `driveTurn` serves these shapes through a MUTABLE override of the
// `/session/:id/message` (+ `/session/status`) routes rather than pushing them
// onto the SSE bus directly — see `installMutableSession`'s doc comment for why
// (this spec's own finding, not a documented app contract).

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
  // `patch` is required here even though the SDK's `SnapshotFileDiff.patch` is
  // typed optional: the client-side `diff()` type-guard in `src/utils/diffs.ts`
  // requires `typeof value.patch === "string"` at runtime (any value without it
  // is silently dropped), and the real snapshot pipeline
  // (`packages/opencode/src/snapshot/index.ts`) always sets it — `""` for
  // binary files, the formatted patch text otherwise — so a patch-less diff
  // fixture here would exercise a shape the real server never actually sends.
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

// Session timeline redesign (docs/plans/2026-07-16-003-...-session-timeline-redesign*,
// ~complete as of 2026-07-18): a settled turn whose tool activity produces >=2
// "foldable" rows (work groups, context groups, or standalone tool parts) now folds
// behind one "Worked for Xs" `TurnFold` divider by default (`message-timeline.data.ts`
// `canFoldSettled`/`shouldFold`) — its `Collapsible.Content` (and therefore every row
// underneath, including nested group/tool wrappers that otherwise stay mounted
// regardless of THEIR OWN open state) is presence-unmounted until unfolded. Every
// scenario below that seeds >=2 foldable rows for one turn must unfold it before
// asserting on anything nested inside.
async function unfoldTurnIfNeeded(page: Page, userMessageID: string) {
  const trigger = page.locator(`[data-message-id="${userMessageID}"][data-timeline-row="TurnFold"] button`)
  if ((await trigger.count()) === 0) return
  if ((await trigger.getAttribute("aria-expanded")) === "true") return
  await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
}

// Consecutive work-type tool parts (bash/edit/write/apply_patch/web — see `workGroupTool`
// in `message-timeline.data.ts`) fold into ONE `WorkGroup` when the run has >=2 members
// (a lone work tool stays a standalone row). Like `TurnFold`, `WorkGroup`'s own
// `Collapsible.Content` presence-unmounts its member rows (each still carrying its own
// independent `data-timeline-part-id`/settings-driven open state) until expanded.
async function expandWorkGroupIfPresent(page: Page, partIds: string) {
  const trigger = page.locator(`[data-timeline-part-ids="${partIds}"] [data-component="work-group-trigger"]`)
  if ((await trigger.count()) === 0) return
  // Kobalte presence-unmounts `Collapsible.Content` (here `[data-component="work-group-
  // list"]`) while closed — the same reliable open/closed signal `collapsibleContent`'s
  // own doc comment relies on — so its mere presence means the group is already open.
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

// --- Seeded (already-settled) history, for the scroll-only scenarios -------
// These scenarios test rendering/scroll of ALREADY-RESOLVED history, not a live
// send, so they skip the composer/oracle entirely and seed `/session/:id/message`
// (and the session GET/list routes) directly — the same "override a route the
// shared mock already registers" pattern the pilot spec uses for its zero-
// workspace scenario, scoped to these tests only.

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
          // Deliberately short (not the long repeated-paragraph text this
          // fixture used earlier): the "jump-to-bottom appears once scrolled
          // away" scenario navigates straight to `#message-<lastUserID>`,
          // and per `session.tsx`'s `shouldAnchorBottom`
          // (`!location.hash && ...`) a hash on load disables bottom-
          // anchoring entirely in favor of `useSessionHashScroll`'s
          // scroll-to-element. That scroll is computed once, from the
          // virtualizer's estimated (not-yet-measured) row heights for
          // whatever precedes the target — tall, not-yet-measured rows
          // there make the one-shot correction undershoot the real
          // position by however much those estimates were off (a real
          // gap in `use-session-hash-scroll.ts`'s `seek()`, which never
          // re-corrects once it succeeds once; see this spec's FINDINGS).
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
  const messageBody = JSON.stringify(rows)
  // Every pattern below needs a trailing `**` (even the ones with no query
  // params of their own) — Playwright's glob matching requires an exact
  // end-of-URL match unless the pattern ends in a wildcard, and the real app
  // appends `?directory=...` to nearly every request. A bare `**/session/
  // <id>` pattern silently fails to match `.../session/<id>?directory=...`
  // and falls through to the shared mock's own generic `**/session/*`
  // catch-all (a single-segment wildcard, which — unlike a bare literal
  // pattern — DOES swallow query-string characters) instead of this route.
  await page.route("**/session", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  await page.route("**/session?**", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  // Bound to the session ROW only — deliberately NOT `**/session/${SESSION_ID}**`.
  // A trailing `**` compiles to `(.*)`, so that pattern also swallows every
  // SUB-resource of the session, including `GET /session/:id/permission-mode`,
  // which the composer fetches on every mount since the per-harness mode picker
  // landed. Answered with the session row instead of a mode report, the picker
  // read `modes` off a body that has none — which used to throw during render and
  // take the whole shell into the ErrorBoundary, so `[data-claxedo]` never
  // appeared and all nine tests here died in `gotoSession`. Two patterns for the
  // same reason the `**/session` pair above needs two: a bare literal pattern
  // requires an exact end-of-URL match, and the app appends `?directory=...`.
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

// --- Mutable seeded session, for the busy→settle / pending→answered
// transitions (behaviors 1, 2, 5) -------------------------------------------
//
// FINDING (this spec's own investigation, not a documented app contract): in
// this mock topology `/api/workspace/resolve` always reports a `workspaceId`
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
  // Every pattern below needs a trailing `**` — Playwright's glob matching
  // requires an exact end-of-URL match unless the pattern ends in a
  // wildcard, and the real app appends `?directory=...` to nearly every
  // request. A bare `**/session/status` pattern silently fails to match
  // `.../session/status?directory=...` and falls through to the shared
  // mock's own generic `**/session/*` catch-all (a single-segment wildcard,
  // which — unlike a bare literal pattern — DOES swallow query-string
  // characters) instead of this route, serving the wrong shape (a generic
  // session row) with no visible error. Confirmed via an isolated Playwright
  // repro during this spec's authoring; see the FINDINGS note in the SPEC
  // block above.
  await page.route("**/session", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  await page.route("**/session?**", (route) => (route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: listBody }) : route.fallback()))
  // Bound to the session ROW only — deliberately NOT `**/session/${SESSION_ID}**`.
  // A trailing `**` compiles to `(.*)`, so that pattern also swallows every
  // SUB-resource of the session, including `GET /session/:id/permission-mode`,
  // which the composer fetches on every mount since the per-harness mode picker
  // landed. Answered with the session row instead of a mode report, the picker
  // read `modes` off a body that has none — which used to throw during render and
  // take the whole shell into the ErrorBoundary, so `[data-claxedo]` never
  // appeared and all nine tests here died in `gotoSession`. Two patterns for the
  // same reason the `**/session` pair above needs two: a bare literal pattern
  // requires an exact end-of-URL match, and the app appends `?directory=...`.
  await page.route(`**/session/${SESSION_ID}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }))
  await page.route(`**/session/${SESSION_ID}?**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: sessionBody }))
  await page.route(`**/session/${SESSION_ID}/message**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) }))
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
    const scrollTop = await scroller.evaluate((el) => el.scrollTop)
    if (scrollTop < 100) break
  }
}

/**
 * Found by the SEMANTIC icon id, never by a sprite href.
 *
 * `use[href="#opencode-icon-arrow-down-to-line"]` named the opencode theme's
 * glyph for `scroll-to-latest`; the Codex theme draws the same semantic icon
 * from an external sprite (`codex-20-012`), so that selector silently matched
 * nothing and the opacity read came back `null` instead of "0". `data-icon`
 * carries the semantic name in every theme.
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
  // This spec's seeded-session scenarios each cost a full navigation (or a
  // navigation + reload for the busy→settle transition), which on a loaded
  // shared runner can outrun the default per-test timeout well before
  // anything the app does is actually slow — give every test in this file
  // extra headroom rather than tuning each `page.goto` timeout individually.
  test.beforeEach(() => {
    test.slow()
  })

  test("tool call default-open state follows shell/edit settings; unrelated tools stay collapsed — behavior 1", async ({ page }) => {
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

    // Session timeline redesign: 3 consecutive work-type tool parts (bash, edit,
    // webfetch) fold into ONE `WorkGroup` (`groupParts` in message-timeline.data.ts —
    // a work run merges once it has >=2 members). The turn itself has only that single
    // foldable row, so it stays un-turn-folded (`canFoldSettled` needs >=2 foldable
    // rows) — but the WorkGroup's own collapsible must be expanded before any member's
    // nested collapsible-content can be asserted on, same presence-unmount mechanism.
    await unfoldTurnIfNeeded(page, userID)
    const workGroupPartIds = "tools_bash,tools_edit,tools_web"
    await expandWorkGroupIfPresent(page, workGroupPartIds)

    // Settings at their default (both false) — bash/edit/webfetch all collapsed.
    await expect(collapsibleContent(page, "tools_bash")).toHaveCount(0)
    await expect(collapsibleContent(page, "tools_edit")).toHaveCount(0)
    await expect(collapsibleContent(page, "tools_web")).toHaveCount(0)

    // Flip both settings on. An already-rendered, never-manually-toggled tool
    // part's open state is seeded from a reactive memo (`toolOpen[id] ??
    // defaultOpen()`), so it flips live — no reload/new turn required.
    await openSettings(page)
    await setSwitch(page, "settings-feed-shell-tool-parts-expanded", true)
    await setSwitch(page, "settings-feed-edit-tool-parts-expanded", true)
    await page.keyboard.press("Escape")

    await expect(collapsibleContent(page, "tools_bash")).toHaveCount(1)
    await expect(collapsibleContent(page, "tools_edit")).toHaveCount(1)
    // An unrelated tool kind stays collapsed regardless of either setting.
    await expect(collapsibleContent(page, "tools_web")).toHaveCount(0)
  })

  test("a pending question tool call renders no row; an answered one opens automatically — behavior 2", async ({ page }) => {
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

    // Pending question renders no timeline row at all — not merely collapsed.
    await expect(page.locator('[data-timeline-part-id="q_pending"]')).toHaveCount(0)

    // Answered question renders already open, showing its question/answer pair.
    const answeredContent = collapsibleContent(page, "q_answered")
    await expect(answeredContent).toHaveCount(1)
    await expect(answeredContent.locator('[data-slot="question-answer-item"]')).toHaveCount(1)
  })

  test("consecutive read/glob/grep/list calls collapse into one expandable Gathered-context group — behavior 3", async ({ page }) => {
    const userID = "msg_user_context"
    const assistantID = "msg_assistant_context"
    await installSeededSession(page, [
      userRow({ id: userID, text: "look around the repo" }),
      assistantRow({
        id: assistantID,
        parentID: userID,
        completed: true,
        toolParts: [
          // IDs are zero-padded so `sortMessageParts`'s lexicographic sort
          // (`src/session/store/message-page.ts` — every part list the store
          // holds is sorted by `id`, not insertion order; real part IDs are
          // monotonic so this is a no-op in production, but a fixture using
          // descriptive names must sort correctly on its own) preserves this
          // emission order — the context-group locator below asserts the
          // exact joined id string, which depends on it.
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

    // Collapsed by default.
    await expect(group.locator('[data-slot="context-tool-group-item"]')).toHaveCount(0)
    await group.locator('[data-component="context-tool-group-trigger"]').click()
    await expect(group.locator('[data-slot="context-tool-group-item"]')).toHaveCount(4)
  })

  test("a context-tool run split by an unrelated tool call forms two separate groups — behavior 4", async ({ page }) => {
    const userID = "msg_user_split"
    const assistantID = "msg_assistant_split"
    await installSeededSession(page, [
      userRow({ id: userID, text: "read a couple files, run a command, read one more" }),
      assistantRow({
        id: assistantID,
        parentID: userID,
        completed: true,
        toolParts: [
          // Zero-padded IDs — see behavior 3's comment above on why (sort-by-id
          // part storage). Unpadded "split_bash" < "split_read1" lexicographically
          // would sort bash BEFORE the reads and silently merge this into one group.
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

    // Session timeline redesign: this turn has 3 foldable rows (the 2-read context
    // group, the standalone bash part, the standalone trailing read) — >=2, so it
    // auto-folds behind a "Worked for Xs" `TurnFold` divider that presence-unmounts
    // everything below it until unfolded (unlike behavior 3's single-group turn, which
    // stays under the foldable-row threshold and needs no unfold).
    await unfoldTurnIfNeeded(page, userID)

    await expect(page.locator('[data-timeline-part-ids="split1_read,split2_read"]')).toHaveCount(1)
    await expect(page.locator('[data-timeline-part-ids="split4_read"]')).toHaveCount(1)
    await expect(page.locator('[data-timeline-part-id="split3_bash"]')).toHaveCount(1)
  })

  test("diff-summary accordion is hidden while busy, appears on settle, dedupes same-file entries, and lazy-mounts its diff view — behavior 5", async ({ page }) => {
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

    // Confirm the turn is actually rendering as busy before proving the diff row's
    // absence — a positive signal, not absence-by-default. `sessionStatus()`
    // only reflects the overridden `/session/status` GET after the app's
    // ~1.5s first-fold meta hydrate delay (`FIRST_FOLD_SESSION_META_HYDRATE_
    // DELAY_MS`), hence the generous timeout.
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

    // Lazy diff view: absent until its accordion item is expanded.
    await expect(diffRow.locator('[data-slot="session-turn-diff-view"]')).toHaveCount(0)
    await triggers.first().click()
    await expect(diffRow.locator('[data-slot="session-turn-diff-view"]')).toHaveCount(1)
  })

  test("diff-summary caps the preview at 3 files with a show all/less toggle — behavior 6", async ({ page }) => {
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

    // Session timeline redesign: the diff-summary preview cap dropped from 10 to 3
    // (`maxFiles` in `TimelineDiffSummaryRow`, src/features/session/ui/message-
    // timeline.tsx) and the separate "+N more files" affordance was removed —
    // overflow is surfaced only via the single `session-turn-diffs-toggle`
    // ("Show all"/"Show less", no count), which now does double duty as both the
    // expand and collapse control.
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

  test("jump-to-bottom appears once scrolled away from the bottom and returns there on click, clearing any hash — behaviors 7,9", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 })
    await installSeededSession(page, seededTurnRows(8))
    await gotoSession(page, "#message-msg_user_08")

    const root = page.locator('[data-testid="session-page-root"]')
    await expect(root).toHaveAttribute("data-session-visible-user-count", "8", { timeout: 20_000 })
    // Let the initial hash-scroll settle before reading the jump-to-bottom
    // control's rest state, so the very first poll isn't racing the
    // mount-time scroll. A `#message-<id>` hash on load disables the
    // bottom-anchor entirely (`shouldAnchorBottom` in session.tsx is
    // `!location.hash && ...`) in favor of `useSessionHashScroll` scrolling
    // the target message to the top of the viewport — so "at rest" here
    // lands wherever that puts the target, not necessarily flush with the
    // document's true bottom (this turn's own short reply trails the
    // anchored user bubble by a small, non-zero amount). Waiting for the
    // scroll position to stop moving (rather than asserting an exact
    // pixel distance from the bottom) is the correct settle signal; the
    // actual behavior-7 contract this proves is the jump-to-bottom
    // control's own hidden/visible threshold below, not pixel-exactness.
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

    // At rest (settled on the hash-scrolled target): jump-to-bottom hidden —
    // the control's own visibility threshold (`ui.scroll.jump`,
    // `max(400, clientHeight)` px from the bottom) is what behavior 7
    // actually pins, not a specific scroll offset.
    await expect.poll(() => jumpToBottomOpacity(page), { timeout: 30_000 }).toBe("0")
    const renderedAtRest = Number(await root.getAttribute("data-session-rendered-user-count"))
    expect(renderedAtRest).toBeLessThan(8)

    // Real wheel-scroll gesture (programmatic scrollTop writes are treated as
    // non-user by the app's gesture tracking and get snapped back).
    await scrollTimelineToTop(page)

    // Behavior 9: older, previously-windowed-out turns get revealed with no dups.
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "8", { timeout: 30_000 })
    await expectNoDuplicateRows(page)

    // Behavior 7: jump-to-bottom now visible.
    await expect.poll(() => jumpToBottomOpacity(page), { timeout: 30_000 }).toBe("1")

    await jumpToBottomButton(page).click()

    // Returns to the bottom and clears the hash that was active on load.
    await expect.poll(() => jumpToBottomOpacity(page), { timeout: 30_000 }).toBe("0")
    await expect.poll(() => new URL(page.url()).hash).toBe("")
    const distance = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    expect(distance).toBeLessThan(20)

    // The reveal from scrolling up is not undone by returning to the bottom.
    await expect(root).toHaveAttribute("data-session-rendered-user-count", "8")
  })

  test("the timeline stays pinned to the bottom while a reply streams in — behavior 8", async ({ page }) => {
    // Tall enough that 3 turns cumulatively overflow the viewport, but each
    // individual reply stays well under the viewport height itself — the
    // oracle's geometric-truth layer requires the claimed reply's WHOLE
    // bounding box to fit inside the viewport, which a single overflowing
    // message could never satisfy regardless of scroll position.
    await page.setViewportSize({ width: 1280, height: 600 })
    const longReply = (turn: number, text: string) =>
      `ack ${turn}: ${text}\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(8)}`
    await openSessionWithFirstSend(page, { replyText: longReply, harnessModels: HARNESS_MODELS })
    // Build up enough height that the timeline genuinely overflows before the
    // final, observed turn streams in.
    await sendAndProve(page, "second timeline message", "ack 2: second timeline message")
    await sendAndProve(page, "third timeline message", "ack 3: third timeline message")

    const scroller = timelineScroller(page)
    await expect.poll(async () => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 50), { timeout: 30_000 }).toBe(true)

    // No manual scroll interaction happens here — the final assertion proves the
    // auto-follow tracked the stream all the way to the end.
    const distance = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
    expect(distance).toBeLessThan(20)
  })

  test("a #message-<id> hash deep-link scrolls to the target message, including the comment-strip case — behavior 10", async ({ page }) => {
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
            metadata: { opencodeComment: { path: "src/app.ts", comment: "please fix this", selection: { startLine: 10, startChar: 0, endLine: 10, endChar: 0 } } },
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

    // Plain case: the anchor lands directly on the UserMessage row.
    await gotoSession(page, `#message-${plainUserID}`)
    const plainAnchor = page.locator(`#message-${plainUserID}`)
    await expect(plainAnchor).toHaveAttribute("data-timeline-row", "UserMessage", { timeout: 15_000 })
    await expect.poll(async () => {
      const box = await plainAnchor.boundingBox()
      const viewport = page.viewportSize()
      if (!box || !viewport) return false
      return box.y >= -1 && box.y < viewport.height
    }, { timeout: 15_000 }).toBe(true)

    // Commented case: the anchor lands on the CommentStrip row, not the bubble.
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
