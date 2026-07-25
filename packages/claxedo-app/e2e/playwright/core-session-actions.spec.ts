/**
 * SPEC: Core session actions (rename, fork, revert, archive/delete, subagent)
 *
 * PURPOSE — every mutating action a user can take on a session AFTER it exists, short of
 * sending a prompt: rename it, branch it (fork), roll a turn back (revert/unrevert),
 * remove it (archive/delete), and navigate the parent/child relationship a subagent
 * (`task` tool) run creates. These are the "session as an object" affordances, as
 * distinct from spec 1/2's "session as a conversation" affordances.
 *
 * STATE MODEL —
 *   - **Title** lives on the server `Session.title` field, mirrored client-side in the
 *     per-directory `directorySessionCacheQueryOptions({directory})` TanStack Query cache
 *     (`src/shell/data/directory-session-cache.ts`). Renaming is local-first: the mutation
 *     in `src/pages/session/message-timeline.tsx` (`titleMutation`, ~line 849) calls
 *     `PATCH /session/{id}` with `{title}` and on success patches the cache directly via
 *     `updateDirectorySession(sdk.directory, id, ...)` — it does NOT wait for a re-fetch
 *     or an SSE echo. Every reactive reader of that same query key (the session header,
 *     `session-controller.ts`'s `info()`, `session-composer-region.tsx`'s `child()`/
 *     `parentID()` gate) therefore updates in the same tick, with no page reload. NOTE:
 *     `src/pages/session.tsx` (~lines 480-577) defines a byte-for-byte duplicate
 *     title-editor/`archiveSession` implementation (`openTitleEditor`, `closeTitleEditor`,
 *     `saveTitleEditor`, `title` store) that is never referenced from that file's JSX —
 *     it is dead code; the actually-rendered rename/archive/delete UI lives entirely in
 *     `message-timeline.tsx`. This spec drives the real, rendered path only.
 *   - **Editing** is transient component state (`title` store in `message-timeline.tsx`,
 *     ~line 713): `{draft, editing, menuOpen, pendingRename}`. It resets to
 *     closed whenever `sessionKey()` changes (session switch) — nothing here survives
 *     navigation or reload by design.
 *   - **Fork** creates a brand-new, independent session via `POST /session/{id}/fork`
 *     (body `{messageID}`) and navigates to it; the forked message's original draft
 *     (text/attachments/chips) is restored into the new session's composer via
 *     `prompt.set(restored, undefined, {dir, id})` (`src/components/dialog-fork.tsx`,
 *     `handleSelect`). Fork is reachable ONLY through the `/fork` slash command (builtin,
 *     `src/pages/session/use-session-commands.tsx` ~line 624, `id: "session.fork"`) which
 *     opens `DialogFork` — a searchable list of every user message in the session. NOTE:
 *     `session.tsx` also defines a `fork()` function (~line 1184) wired into the
 *     `actions` prop threaded down to `UserMessageDisplay`
 *     (`packages/session-ui/src/components/message-part.tsx` `UserActions.fork`), but
 *     `UserMessageDisplay` never renders a fork button or calls `props.actions.fork` —
 *     that path is unreachable dead code. `DialogFork` calls
 *     `sdk.client.session.fork(...)` directly instead.
 *   - **Revert** rolls the session back to a specific user message: `POST
 *     /session/{id}/revert` (body `{messageID}`, optionally `partID`). Trigger: the
 *     per-message "Revert message" icon button rendered by
 *     `UserMessageDisplay` (`packages/session-ui/src/components/message-part.tsx`
 *     ~line 1239, `revert()` → `props.actions.revert({sessionID, messageID})`, which IS
 *     wired all the way to `session.tsx`'s real `revert()` at ~line 1206). The reverted
 *     state (`Session.revert.messageID`) is server-authoritative and reaches the client
 *     only via a `session.updated` SSE event carrying the full `info` (see
 *     `src/shell/data/session-list-events.ts` ~line 52) — there is no optimistic local
 *     patch for revert (unlike title). `revertMessageID = () => info()?.revert?.messageID`
 *     (`session.tsx` ~line 447) drives `rolled()` — every visible user message whose id is
 *     `>=` the revert point — which session.tsx passes to `SessionComposerRegion` as
 *     `revert.items` and renders as `SessionRevertDock`
 *     (`src/pages/session/composer/session-revert-dock.tsx`). Revert prefills the composer
 *     via `prompt.set(draft(messageID))` using the reverted message's OWN original parts
 *     (`src/pages/session.tsx` `revert()`, ~line 1206-1215).
 *   - **Unrevert** (`POST /session/{id}/unrevert`, no body) clears `revert` entirely and
 *     resets the composer draft (`prompt.reset()`). The dock's per-row "Restore" button
 *     (`SessionRevertDock`, `onRestore`) maps to `session.tsx`'s `restore(id)` (~line
 *     1217): if there is a rolled-back message strictly AFTER `id`, it's a PARTIAL
 *     restore (`session.revert({messageID: next.id})`, prefills that message's draft);
 *     if `id` is the most-recently-rolled-back message (nothing after it), it's a FULL
 *     `unrevert` (draft cleared via `prompt.reset()`).
 *   - **Archive** (`PATCH /session/{id}` body `{time:{archived: <ms>}}`) and **Delete**
 *     (`DELETE /session/{id}`) both live in the ⋯ kebab menu
 *     (`message-timeline.tsx` ~lines 1516-1591), gated `<Show when={!parentID()}>` — a
 *     child/subagent session has NO kebab menu at all. Archive has no confirmation step;
 *     Delete opens `DialogDeleteSession` (~line 1000) which names the session
 *     (`session.delete.confirm` = `Delete session "{{name}}"?`) and requires an explicit
 *     "Delete session" click. Both remove the session from the directory cache
 *     (`removeDirectorySessionTree`) and navigate away if the CURRENT route was viewing
 *     the affected session (`navigateAfterSessionRemoval`, ~line 933): to the parent if
 *     one exists, else to the next sibling, else to a fresh draft on the same directory.
 *     Archived sessions are NOT deleted server-side — they are excluded from the default
 *     ("Active") sidebar filter but remain reachable; the sidebar's archived-radio filter
 *     UI itself (`src/claxedo-ui/layouts/rail-sidebar.tsx` ~line 1516-1545) is owned by
 *     spec 17 (`core-sidebar-tree`) — this spec proves only the archive/delete ACTION's
 *     request contract and its own-session navigation-away effect.
 *   - **Subagent (child) sessions** are ordinary `Session` rows with `parentID` set to
 *     the session that spawned them (via a `task` tool call). `message-timeline.tsx`'s
 *     `parentID`/`parent`/`parentTitle`/`childTitle` memos (~lines 415-445) derive the
 *     breadcrumb from `directorySession(parentID)`. `session-composer-region.tsx`'s
 *     `child()` memo (`!!parentID()`, ~line 99) forces the composer into a read-only
 *     "Subagent sessions cannot be prompted." banner with a "Back to main session." link
 *     regardless of any other gating (`showComposer = !blocked() || child()`). Permission
 *     and question requests raised BY a child session are surfaced on the PARENT's dock:
 *     `src/pages/session/composer/session-composer-state.ts` walks the whole descendant
 *     tree (`sessionTreeIds`, built by walking `parentID` edges) and
 *     `src/pages/session/composer/session-request-tree.ts` (`sessionPermissionRequest`/
 *     `sessionQuestionRequest`) returns the first pending request found anywhere in that
 *     tree when queried with the PARENT's own session id — so a parent viewing its own
 *     session sees a child's permission/question exactly like its own, and a child
 *     session viewed directly is never itself blocked (its composer is already fully
 *     disabled). `permission.asked`/`question.asked` SSE events are cache-only (
 *     `src/shell/data/directory-event-projector.ts` ~line 86) — no GET re-fetch is
 *     involved.
 *
 * ANATOMY —
 *   `[data-slot="session-title-child"]` — the session title element in the timeline
 *     header (`h1` when idle, `input[data-component="inline-input"]` while
 *     `title.editing`). Renders the CHILD's own (suffix-stripped) title for a subagent
 *     session, or the current session's title otherwise.
 *   `[data-slot="session-title-parent"]` — breadcrumb button showing the parent's title,
 *     present only when `parentID()` is set; click navigates to the parent.
 *   `[data-slot="session-title-separator"]` — the "/" between parent and child titles.
 *   `button[aria-label="More options"]` — the ⋯ kebab trigger (`icon="dot-grid"`); absent
 *     entirely for a child session. NOTE: the sidebar's own workspace-level menu trigger
 *     has aria-label "More options for main" — an exact-name match is required to avoid a
 *     Playwright strict-mode collision with that unrelated button.
 *   Kebab menu items (Kobalte `role="menuitem"`): "Rename", "Archive", "Delete". There is no
 *     "Share" item — Claxedo ships no session sharing, so nothing gates on config `share`.
 *   `[data-component="session-prompt-dock"]` → `[data-component="session-revert-dock"]`
 *     (`session-revert-dock.tsx`) — collapsed by default (`store.collapsed`), toggled by
 *     its own row or the `chevron-down` icon button (`aria-label` = "Expand"/"Collapse
 *     rolled back messages"); expanded state renders one row per rolled-back message with
 *     a "Restore message" button (`session.revertDock.restore`).
 *   `[data-component="user-message"]` — a rendered user turn; contains a "Revert message"
 *     icon button (`aria-label="Revert message"`, `packages/session-ui/src/components/
 *     message-part.tsx`) when `actions.revert` is provided.
 *   `[data-slot="dialog-title"]` = "Fork from message" — `DialogFork`'s title;
 *     `[data-slot="list-item"][data-key="<messageID>"]` — one row per forkable user
 *     message.
 *   `[data-slot="dialog-title"]` = "Delete session" — `DialogDeleteSession`'s title;
 *     body text `Delete session "<name>"?`; primary button "Delete session".
 *   `[data-component="session-prompt-dock"]` (child composer state) — when
 *     `parentID()` is set, renders `session.child.promptDisabled` ("Subagent sessions
 *     cannot be prompted.") plus a "Back to main session." link instead of `PromptInput`.
 *   `[data-slot="permission-header-title"]` / `[data-slot="permission-footer-actions"]`
 *     (`session-permission-dock.tsx`) — the permission dock; "Deny"/"Allow always"/
 *     "Allow once" buttons.
 *   `[data-slot="toast-title"]` — toast title text, e.g. "Request failed".
 *
 * BEHAVIORS —
 *   1. Double-clicking the session title opens an inline editor prefilled with the
 *      current title.
 *   2. Opening the ⋯ menu and choosing "Rename" opens the same inline editor.
 *   3. Enter commits the rename: a `PATCH /session/{id}` fires with the new `title`, and
 *      the header updates to the new text without a page reload.
 *   4. Escape cancels the edit: no PATCH fires, the header reverts to the original title.
 *   5. A failed rename PATCH keeps the editor open (does not force it closed) and shows a
 *      "Request failed" toast; the draft text the user typed is preserved in the input.
 *   6. Fork (via `/fork` → `DialogFork` → selecting a message) creates a new session,
 *      navigates the URL onto it, and restores that message's original text into the new
 *      session's composer draft.
 *   7. Reverting a message (per-message "Revert message" button) prefills the composer
 *      with that message's original text and renders the revert dock summarizing "N
 *      rolled back message(s)".
 *   8. The revert dock expands on click to show one row per rolled-back message with its
 *      own "Restore message" action.
 *   9. Restoring the sole/most-recent rolled-back row performs a full unrevert: the dock
 *      disappears and the composer draft is cleared.
 *   10. Archiving a session (⋯ → Archive, no confirmation) sends the archived timestamp
 *       and navigates away from the now-archived session's own route.
 *   11. Deleting a session (⋯ → Delete) opens a confirmation dialog naming the session;
 *       confirming issues the DELETE request and navigates away.
 *   12. A directly-opened child (subagent) session renders a disabled composer
 *       ("Subagent sessions cannot be prompted." + "Back to main session.") and a
 *       parent/child breadcrumb header; it has no ⋯ kebab menu at all.
 *   13. Clicking the parent breadcrumb from a child session navigates to the parent
 *       session's own route.
 *   14. A permission request raised on a CHILD session bubbles into the PARENT session's
 *       composer dock while the parent is being viewed (proving the descendant-tree walk
 *       in `session-request-tree.ts`), and deciding it (Allow once) clears the dock.
 *   15. FIXED BUG — a `session.updated` title event that cannot resolve a `projectID`
 *       itself (e.g. a non-opencode/harness session's auto-title fallback, which
 *       hardcodes `projectID: ""` — see `packages/agent-sdk-runtime/src/harnesses/acp/
 *       title.ts` `maybeAutoTitle`, combined with a `directory` string that does not
 *       exactly match any registered project's worktree — the directory-shape-routing
 *       debt referenced throughout this codebase's memory) still patches the SIDEBAR
 *       session inventory's title for a session already known there, instead of being
 *       silently dropped. Root cause was `applySessionInventoryLifecycle`
 *       (`src/shell/data/inventory-writers.ts`), which used to drop ANY lifecycle event
 *       (created OR updated) whose `projectID` could not be resolved — correct for
 *       "created" (a brand-new row has nowhere to be grouped without one) but wrong for
 *       "updated" on a row that already exists: it silently discarded title updates that
 *       reach the client for a harness session whose auto-title event can't resolve a
 *       project on its own. Fixed by falling back to the EXISTING row's already-known
 *       `projectID` for "updated" events. (Note: `event-ingress.ts`'s own
 *       `projectFor(info.directory)` backfill — the OUTER caller — already resolves
 *       `projectID` correctly whenever the event's `directory` string exactly matches a
 *       registered project's worktree, so this behavior is only observable when that
 *       exact-match ALSO fails, which is what this test constructs.)
 *
 * INVARIANTS — completed UI state is never silently reverted by a stale request (#2 in
 *   e2e/INVARIANTS.md is about assistant content specifically; this spec's analogous rule
 *   is: a failed rename PATCH must not force-close the editor or discard the user's typed
 *   draft — see behavior 5). Harness ownership (#1) is out of scope; every scenario here
 *   fixes the `opencode` harness except behavior 15, which is specifically about a
 *   non-opencode/harness session's auto-title event.
 *
 * HARNESS NOTES — none of these actions vary by harness; capabilities gating
 *   (`fork`/`revert`/`unrevert` booleans from `GET /session/{id}/capabilities`) is
 *   exercised implicitly (the mock always advertises all three as supported) and is not
 *   independently re-tested per harness here — that matrix is `core-harness-ownership-*`.
 *   Behavior 15 is the one harness-specific exception: it pins the sidebar-inventory
 *   consequence of a non-opencode harness's own auto-title mechanism (see
 *   `packages/agent-sdk-runtime/src/harnesses/acp/title.ts`).
 *
 * OUT OF SCOPE —
 *   - Behavior 15 pins the CLIENT-SIDE inventory-cache consequence only (via
 *     `mock.emit`), not the full end-to-end story: claxedo-server's own
 *     `services.projectionStore` (the persisted source `/api/control/session-list`
 *     reads for the sidebar TREE's own rows, as opposed to the `sessionInventoryQuery`
 *     cache this behavior covers) has no write path today for a harness's async
 *     auto-title event — that event is published over an SSE-only bus
 *     (`RuntimeEventHub.publishGlobal`), never an HTTP `PATCH /session/{id}`, and
 *     claxedo-server's response-sniffing session-meta bridge
 *     (`packages/claxedo-server/src/server.ts`, its `/session` create/update/delete tap)
 *     only observes HTTP verbs. Filed as a finding, not fixed here (too large for a
 *     minimal fix — see PR notes).
 *   - The sidebar's archived/all/active radio filter UI itself and its persistence
 *     (`core-sidebar-tree`, spec 17) — this spec proves only the archive action's own
 *     request + navigate-away contract.
 *   - Deny/Allow-always permission decisions and the auto-respond/question-wizard/todo
 *     dock machinery (`core-docks`, spec 7) — this spec drives exactly one decision (Allow
 *     once) to prove the bubble-and-close mechanics, nothing more.
 *   - Full harness-controls/model/effort payload assertions on forked/reverted turns
 *     (`core-model-effort-agent-controls`, spec 4).
 *   - "Title syncs to a second pane" is INTENTIONALLY NOT covered: the macOS-style tab
 *     strip that would show a second open session's live title
 *     (`src/components/titlebar.tsx`, `TabNavItem`) is never mounted — `src/shell/
 *     app-shell.tsx` line 115 passes `// titlebar={<Titlebar />}` commented out — and no
 *     labelled/keyboard-documented workbench-split-creation trigger exists in
 *     `src/claxedo-ui/layouts/rail-keyboard-commands.ts` (only focus-left/focus-right).
 *     See this file's returned findings.
 */
import { expect, test, type Page, type Route } from "@playwright/test"
import { installMockRuntime, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-session-actions"
const PROJECT_ID = "proj_core_session_actions"
const PROJECT_NAME = "core-session-actions"
// A concrete, serving model. The mock's DEFAULT harness model is the
// `big-pickle` placeholder (`SIGNED_WORKSPACE_DEFAULT_MODEL`), which the composer
// now deliberately treats as "no model configured" and refuses to submit with
// (`src/features/session/composer/signed-workspace-model.ts` — "has no serving
// path and must never make the composer submit-ready"; gate in
// `submit-block-wiring.ts`'s `needsModelSelection`). Every scenario in this spec
// acts on a session that only exists after a successful first send, so each
// `installMockRuntime` that precedes `sendFirstPrompt` must advertise a real
// model — exactly as the sibling `core-first-prompt-local` send test does.
const SEND_MODELS = { opencode: [{ id: "gpt-5", name: "GPT-5" }] }

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

function sessionUrlPattern(sessionId: string) {
  return new RegExp(`(?:/s/${sessionId}|/w/[^/]+/session/${sessionId})$`)
}

async function openSession(page: Page, dir: string, sessionId: string) {
  await page.goto(`/${slug(dir)}/session/${sessionId}`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

/**
 * Shared-helper gap workaround (spec-local, per the pooled-phase amendment: mock-runtime.ts
 * edits are forbidden while siblings are consuming it concurrently — work around a gap with
 * a spec-local page.route and file a finding instead).
 *
 * Confirmed via a trace network capture (not just source reading): this build's session
 * pages never request `/global/event` at all — they poll `/api/wr/events` and
 * `/api/wr/runtime-events` for their event stream, even for a purely local/non-cloud
 * session. `installMockRuntime` only mounts those two routes under its `cloud` option
 * (mock-runtime.ts lines ~806-831), so for every Tier M spec that omits `cloud`, they fall
 * through unmocked to the real backend at :3001 and hang forever on a directory/session
 * that only exists in this test's mock.
 *
 * Confirmed live, by instrumenting the submit control's `data-icon` every 500ms across two
 * consecutive turns in the same mounted session (no reload in between): the SECOND turn's
 * button reliably and durably shows `data-icon="stop"` for the entire window (never
 * transitions), while message CONTENT settles fine throughout (visible text, Thinking row
 * gone) via the separately, properly-mocked session-detail and session-message polling
 * routes — i.e. submit-readiness is a genuinely distinct signal from content-settled, and it
 * depends on a `session.idle`-shaped event actually reaching this relay channel. (The FIRST
 * turn in every other single-send test in this file "passes" only because the draft-URL ->
 * real-session-URL navigation on session creation remounts the composer; the button reads
 * back "arrow-up" from the instant of that remount, before promptCount even ticks — not
 * because idle genuinely converged. That first-turn read is therefore a false positive this
 * spec cannot fix from here; only this file's revert/unrevert scenarios need a second turn on
 * an already-mounted session, which is where the gap becomes observable.)
 *
 * This does not re-simulate message/part content (that already works via the properly-mocked
 * polling routes). It relays two things onto both unmocked channels, so the eventual real fix
 * (mounting equivalents of both in mock-runtime.ts unconditionally, not just under `cloud`) is
 * a straight superset of this behavior:
 *   1. A synthetic `session.idle`, shortly after each observed prompt dispatch (submit
 *      readiness, per above).
 *   2. Every event a test injects via `mock.emit(...)` — `mock.emit` is monkey-patched here to
 *      fork each call into this relay's own queues in addition to the original (which still
 *      only reaches the never-requested `/global/event`/`/event` routes). This spec's
 *      revert/unrevert scenarios and the subagent permission-bubble scenario all depend on a
 *      `mock.emit(...)`-pushed `session.updated`/`permission.asked` event actually reaching
 *      the app over SSE (per this spec's own SPEC block: revert state "reaches the client only
 *      via a session.updated SSE event... there is no optimistic local patch for revert") —
 *      without this fork they'd hang exactly like the stuck submit control above, for the
 *      identical root cause.
 *
 * The two channels are NOT interchangeable, and each gets its own independent queue rather than
 * sharing one (a shared queue lets whichever endpoint happens to be polled first "steal" an
 * event meant for the other, which is exactly the bug that made this workaround flaky in
 * development):
 *   - `/api/wr/events` is read via `compatEventEnvelope` (src/context/global-sdk.tsx) — a loose
 *     `{directory?, payload}` shape, satisfied by the plain OpenCode `Event` shape
 *     mock-runtime.ts's own `sseBody` already produces. This is the channel that actually
 *     carries the events pushed here.
 *   - `/api/wr/runtime-events` is read via `runtimeEnvelope` (same file), which requires a
 *     completely different, contract-versioned `{contractVersion, directory, sessionId,
 *     payload: AgentRuntimeEvent}` envelope that is then run through
 *     `createOpencodeCompatProjection(...).ingest(...)` — a real protocol-translation layer,
 *     not a shape this workaround can reasonably reproduce. Anything posted to that channel in
 *     the plain OpenCode `Event` shape is silently dropped (`runtimeEnvelope` returns
 *     `undefined`, the consumer `continue`s) — harmless, but it means this channel is only ever
 *     fed a heartbeat here; it is not part of the real fix's surface.
 */
async function installRelayEventDrainWorkaround(page: Page, mock: MockRuntimeHandles) {
  type Pending = { directory: string; payload: unknown }
  const makeChannel = () => {
    let pending: Pending[] = []
    let waiters: Array<() => void> = []
    const notify = () => {
      const fire = waiters
      waiters = []
      for (const resolve of fire) resolve()
    }
    const push = (directory: string, payload: unknown) => {
      pending.push({ directory, payload })
      notify()
    }
    const drain = async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback()
      if (pending.length === 0) {
        await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise<void>((resolve) => setTimeout(resolve, 3000))])
      }
      const batch = pending
      pending = []
      const body = batch.length === 0 ? ": heartbeat\n\n" : batch.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
      await route.fulfill({ status: 200, contentType: "text/event-stream", body }).catch(() => {})
    }
    return { push, drain }
  }
  const events = makeChannel()
  const runtimeEvents = makeChannel()
  const broadcast = (directory: string, payload: unknown) => {
    events.push(directory, payload)
    runtimeEvents.push(directory, payload)
  }

  const originalEmit = mock.emit
  mock.emit = (payload, directory) => {
    originalEmit(payload, directory)
    broadcast(directory ?? mock.session.dir, payload)
  }

  let lastSeenPromptCount = 0
  const poll = setInterval(() => {
    if (mock.requests.promptCount <= lastSeenPromptCount) return
    lastSeenPromptCount = mock.requests.promptCount
    // Give the mock's own driveTurn (busy -> pending -> deltas -> completed -> idle,
    // default timings well under 200ms total) a moment to finish before declaring idle,
    // so this never races ahead of the real message content settling.
    setTimeout(() => broadcast(mock.session.dir, { type: "session.idle", properties: { sessionID: mock.session.id } }), 200)
  }, 50)
  page.once("close", () => clearInterval(poll))

  await page.route("**/api/wr/events**", events.drain)
  await page.route("**/api/wr/runtime-events**", runtimeEvents.drain)
}

async function sendFirstPrompt(page: Page, mock: MockRuntimeHandles, text: string) {
  await installRelayEventDrainWorkaround(page, mock)
  await seedOneProject(page, DIR)
  await page.goto(`/${slug(DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await input.click()
  await input.fill(text)
  await expect(input).toContainText(text, { timeout: 10_000 })
  await page.locator('[data-action="prompt-submit"]').last().click()
  await expect(page).toHaveURL(sessionUrlPattern(mock.session.id), { timeout: 20_000 })
  await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
  // Prove the turn through the shared oracle (DOM + geometric + evidence) before any
  // later action (revert/fork/rename/archive) treats this message as settled.
  await expectAssistantReplyVisible(page, `ack 1: ${text}`)
  await dismissJumpToBottom(page)
}

/**
 * The oracle's geometric-truth check scrolls the reply element into view, which can
 * leave the timeline just short of true bottom and pop the floating "jump to bottom"
 * button into an interactive (non `pointer-events-none`) state — it then sits directly
 * over the composer/slash-popover area and intercepts later clicks (a real, reachable
 * overlap: `src/pages/session/message-timeline.tsx`'s jump button is only
 * `pointer-events-none` while `!scroll.jump`). Click it if present so every action after
 * a send starts from a clean, fully-scrolled-down state.
 */
async function dismissJumpToBottom(page: Page) {
  const jump = page.locator('button:has(use[href="#opencode-icon-arrow-down-to-line"])')
  if (await jump.count()) {
    await jump.first().click({ timeout: 2_000 }).catch(() => {})
  }
}

/** Captures PATCH/DELETE bodies for /session/{id} without disturbing GET handling. */
function trackSessionMutations(page: Page) {
  const patches: Array<{ id: string; body: unknown }> = []
  const deletes: string[] = []
  let failNextPatch = false
  const install = async () => {
    await page.route("**/session/*", async (route: Route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+$/.test(url.pathname)) return route.fallback()
      const method = route.request().method()
      const id = url.pathname.split("/").pop()!
      if (method === "PATCH") {
        let body: unknown
        try {
          body = route.request().postDataJSON()
        } catch {
          body = undefined
        }
        patches.push({ id, body })
        if (failNextPatch) {
          failNextPatch = false
          return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "failed" }) })
        }
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
      }
      if (method === "DELETE") {
        deletes.push(id)
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id }) })
      }
      return route.fallback()
    })
  }
  return {
    install,
    patches,
    deletes,
    failNextPatch: (value: boolean) => {
      failNextPatch = value
    },
  }
}

test.describe("core session actions: rename @core", () => {
  test("double-click opens the inline editor prefilled with the current title — behavior 1", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "rename dblclick original title")

    const display = page.locator('h1[data-slot="session-title-child"]')
    await expect(display).toHaveText("rename dblclick original title", { timeout: 10_000 })
    await display.dblclick()

    const editor = page.locator('input[data-slot="session-title-child"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await expect(editor).toHaveValue("rename dblclick original title")
  })

  test("kebab menu Rename opens the inline editor — behavior 2", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "rename via kebab menu original title")

    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Rename" }).click()

    const editor = page.locator('input[data-slot="session-title-child"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await expect(editor).toHaveValue("rename via kebab menu original title")
  })

  test("Enter commits the rename via PATCH and updates the header live — behaviors 3", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "rename enter commit original title")

    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await editor.fill("renamed via enter commit")
    await editor.press("Enter")

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const patch = mutations.patches.at(-1)!
    expect(patch.id).toBe(mock.session.id)
    expect((patch.body as { title?: string }).title).toBe("renamed via enter commit")

    // No page reload occurred: the header updates through the reactive cache write,
    // and the display element goes back to the non-editing <h1>.
    const display = page.locator('h1[data-slot="session-title-child"]')
    await expect(display).toHaveText("renamed via enter commit", { timeout: 5_000 })
    await expect(page.locator('input[data-slot="session-title-child"]')).toHaveCount(0)
  })

  test("Escape cancels the edit without sending a PATCH — behavior 4", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "rename escape cancel original title")

    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await editor.fill("this edit should never be saved")
    await editor.press("Escape")

    await expect(page.locator('input[data-slot="session-title-child"]')).toHaveCount(0)
    await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText(
      "rename escape cancel original title",
      { timeout: 5_000 },
    )
    // Guard the negative with a real signal (request log), not a bare sleep.
    expect(mutations.patches.some((p) => (p.body as { title?: string } | undefined)?.title)).toBe(false)
  })

  test("a failed rename PATCH keeps the editor open and shows a toast — behavior 5", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "rename failed save original title")

    mutations.failNextPatch(true)
    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await editor.fill("this rename will fail")
    await editor.press("Enter")

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect(page.locator('[data-slot="toast-title"]').filter({ hasText: "Request failed" })).toBeVisible({
      timeout: 10_000,
    })
    // Editor stays open (not force-closed) with the user's typed draft intact.
    await expect(editor).toBeVisible()
    await expect(editor).toHaveValue("this rename will fail")
  })
})

test.describe("core session actions: fork @core", () => {
  test("forking a message creates a new session and restores its draft — behavior 6", async ({ page }) => {
    // Fixed in Wave 2 (WP-B4): DialogFork now resolves the session id via
    // `resolveForkSessionId(params)` (src/components/dialogs/fork-messages.ts),
    // which returns `params.sessionId ?? params.id` — so the canonical
    // `/w/:workspaceId/session/:sessionId` route shape now populates the fork
    // list instead of falling back to the empty state. Un-fixme'd; awaiting
    // leader gate run.

    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const forkedText = "fork source message please branch me"
    await sendFirstPrompt(page, mock, forkedText)

    let forkedSessionId = ""
    await page.route("**/session/*/fork", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      forkedSessionId = "ses_core_session_actions_forked"
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: forkedSessionId,
          slug: forkedSessionId,
          projectID: PROJECT_ID,
          directory: DIR,
          title: forkedText,
          version: "2",
          time: { created: Date.now(), updated: Date.now() },
          summary: { additions: 0, deletions: 0, files: 0 },
        }),
      })
    })
    // The forked session's own detail GET must resolve once the app navigates onto it.
    await page.route("**/session/*", async (route: Route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+$/.test(url.pathname)) return route.fallback()
      const id = url.pathname.split("/").pop()
      if (id !== forkedSessionId || !forkedSessionId) return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: forkedSessionId,
          slug: forkedSessionId,
          projectID: PROJECT_ID,
          directory: DIR,
          title: forkedText,
          version: "2",
          time: { created: Date.now(), updated: Date.now() },
          summary: { additions: 0, deletions: 0, files: 0 },
        }),
      })
    })
    await page.route("**/session/*/message**", async (route) => {
      const url = new URL(route.request().url())
      if (!forkedSessionId || !url.pathname.includes(forkedSessionId)) return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })

    // NOT a role+name locator: typing "/fork" opens the slash popover, at which
    // point the composer becomes a WAI-ARIA combobox — its role flips from
    // "textbox" to "combobox" (WP-C1, src/components/prompt-input/frame.tsx) so a
    // `role="textbox"` locator captured before the popover opens stops matching
    // and the `Enter` selection below hangs. `data-component="prompt-input"` is on
    // the same contenteditable node regardless of the combobox/textbox role, so it
    // stays valid across the popover open — the same rationale the sibling
    // core-turns spec's `composer()` helper documents for the shell-mode aria-label
    // flip.
    const input = page.locator('[data-component="prompt-input"]').last()
    await input.click()
    await input.fill("/fork")
    await expect(page.locator('button[data-slash-id="session.fork"]')).toBeVisible({ timeout: 10_000 })
    // A mouse click on the popover row is flaky here: the oracle's earlier
    // geometric-truth scroll (in sendFirstPrompt) can leave the floating "jump to
    // bottom" button re-armed directly over this row's screen coordinates (see
    // dismissJumpToBottom above), and Playwright resolves a click by the real pixel
    // under the cursor — even with `force: true` — so the click can land on that
    // overlay instead of the popover button. Select via keyboard instead (Enter with
    // the popover open and a single filtered match, exactly how a real user would
    // confirm a slash command), which routes through `selectPopoverActive()`
    // (`src/components/prompt-input/editor-keymap.ts`) with no pointer-coordinate
    // dependency.
    await input.press("Enter")

    await expect(page.locator('[data-slot="dialog-title"]').filter({ hasText: "Fork from message" })).toBeVisible({
      timeout: 10_000,
    })
    await page.locator('[data-slot="list-item"]').first().click()

    await expect(page).toHaveURL(new RegExp(`/${slug(DIR)}/session/${forkedSessionId}$`), { timeout: 15_000 })
    // The forked message's original text is restored into the new session's draft.
    const forkedInput = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(forkedInput).toContainText(forkedText, { timeout: 10_000 })
  })
})

test.describe("core session actions: revert / unrevert @core", () => {
  async function sessionRowWithRevert(mock: MockRuntimeHandles, revertMessageID?: string) {
    return {
      id: mock.session.id,
      slug: mock.session.id,
      projectID: PROJECT_ID,
      directory: DIR,
      title: "revert flow first message",
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
      ...(revertMessageID ? { revert: { messageID: revertMessageID } } : {}),
    }
  }

  test("revert prefills the composer and renders the revert dock — behaviors 7,8", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "revert flow first message")

    // Second turn so there is a message to revert AWAY from (revert targets the
    // first message, rolling back the second).
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.click()
    await input.fill("revert flow second message")
    await page.locator('[data-action="prompt-submit"]').last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
    await expectAssistantReplyVisible(page, "ack 2: revert flow second message")
    await dismissJumpToBottom(page)

    let revertedMessageID = ""
    await page.route("**/session/*/revert", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const body = route.request().postDataJSON() as { messageID?: string }
      revertedMessageID = body?.messageID ?? ""
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      mock.emit({
        type: "session.updated",
        properties: { info: await sessionRowWithRevert(mock, revertedMessageID) },
      })
    })

    // Revert the FIRST user message. Per this file's own STATE MODEL section above,
    // `rolled()` is every visible user message whose id is >= the revert point — i.e.
    // reverting message 1 of 2 rolls back message 1 itself too, not just what comes
    // after it. With two total user messages this yields 2 rolled-back rows.
    const firstUserRow = page.locator('[data-component="user-message"]').first()
    await firstUserRow.hover()
    await firstUserRow.getByRole("button", { name: "Revert message" }).click()

    await expect.poll(() => revertedMessageID, { timeout: 10_000 }).not.toBe("")
    // Behavior 7: composer prefilled with the reverted message's own text.
    const composer = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(composer).toContainText("revert flow first message", { timeout: 10_000 })

    // Behavior 8: revert dock renders "2 rolled back messages" (see comment above).
    const dock = page.locator('[data-component="session-revert-dock"]')
    await expect(dock).toBeVisible({ timeout: 10_000 })
    await expect(dock).toContainText("2 rolled back messages")

    // Expand to see the per-row Restore action (one row per rolled-back message — 2 here).
    await dock.click()
    await expect(dock.getByRole("button", { name: "Restore message" })).toHaveCount(2, { timeout: 5_000 })
  })

  test("restoring the rolled-back row fully unreverts the session — behavior 9", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    await sendFirstPrompt(page, mock, "unrevert flow first message")

    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await input.click()
    await input.fill("unrevert flow second message")
    await page.locator('[data-action="prompt-submit"]').last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(2)
    await expectAssistantReplyVisible(page, "ack 2: unrevert flow second message")
    await dismissJumpToBottom(page)

    let revertedMessageID = ""
    await page.route("**/session/*/revert", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const body = route.request().postDataJSON() as { messageID?: string }
      revertedMessageID = body?.messageID ?? ""
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      mock.emit({ type: "session.updated", properties: { info: await sessionRowWithRevert(mock, revertedMessageID) } })
    })
    let unrevertCount = 0
    await page.route("**/session/*/unrevert", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      unrevertCount += 1
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      mock.emit({ type: "session.updated", properties: { info: await sessionRowWithRevert(mock, undefined) } })
    })

    const firstUserRow = page.locator('[data-component="user-message"]').first()
    await firstUserRow.hover()
    await firstUserRow.getByRole("button", { name: "Revert message" }).click()
    await expect.poll(() => revertedMessageID, { timeout: 10_000 }).not.toBe("")

    const dock = page.locator('[data-component="session-revert-dock"]')
    await expect(dock).toBeVisible({ timeout: 10_000 })
    await dock.click()
    // Reverting the first of two messages rolls back both (>= semantics, per this
    // file's own STATE MODEL section above), so the dock renders two rows. Per that
    // same section, restoring only produces a FULL unrevert (POST /unrevert, no body)
    // when the restored row is the most-recently-rolled-back one (nothing after it) —
    // here that's the SECOND row; restoring the first row would instead be a PARTIAL
    // restore (POST /revert with the next message's id). Target the last row to prove
    // behavior 9 (full unrevert).
    await expect(dock.getByRole("button", { name: "Restore message" })).toHaveCount(2, { timeout: 5_000 })
    await dock.getByRole("button", { name: "Restore message" }).last().click()

    await expect.poll(() => unrevertCount, { timeout: 10_000 }).toBe(1)
    await expect(page.locator('[data-component="session-revert-dock"]')).toHaveCount(0, { timeout: 10_000 })
  })
})

test.describe("core session actions: archive / delete @core", () => {
  test("archive sends the archived timestamp and navigates away — behavior 10", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "archive flow original title")

    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Archive" }).click()

    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const patch = mutations.patches.find((p) => (p.body as { time?: { archived?: number } } | undefined)?.time?.archived)
    expect(patch, `expected a PATCH with a time.archived timestamp, got: ${JSON.stringify(mutations.patches)}`).toBeTruthy()
    expect(patch!.id).toBe(mock.session.id)

    // Archive is not itself confirmed — no dialog appears.
    await expect(page.locator('[data-slot="dialog-title"]')).toHaveCount(0)

    // Navigating away from the now-archived session's own route (no parent/sibling
    // to fall back to in this single-session fixture).
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).not.toContain(mock.session.id)
  })

  test("delete requires confirming a dialog naming the session, then removes it — behavior 11", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "delete flow original title")

    await page.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: "Delete" }).click()

    await expect(page.locator('[data-slot="dialog-title"]').filter({ hasText: "Delete session" })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByText('Delete session "delete flow original title"?')).toBeVisible()

    await page.getByRole("button", { name: "Delete session" }).click()

    await expect.poll(() => mutations.deletes, { timeout: 10_000 }).toContain(mock.session.id)
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).not.toContain(mock.session.id)
  })
})

test.describe("core session actions: subagent (child session) @core", () => {
  const PARENT_ID = "ses_core_session_actions_parent"
  const CHILD_ID = "ses_core_session_actions_child"
  const PARENT_TITLE = "Core session actions parent"
  const CHILD_TITLE = "Debug flaky import (@general subagent)"

  function parentRow() {
    return {
      id: PARENT_ID,
      slug: PARENT_ID,
      projectID: PROJECT_ID,
      directory: DIR,
      title: PARENT_TITLE,
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
    }
  }

  function childRow() {
    return {
      id: CHILD_ID,
      slug: CHILD_ID,
      projectID: PROJECT_ID,
      directory: DIR,
      title: CHILD_TITLE,
      parentID: PARENT_ID,
      version: "2",
      time: { created: Date.now(), updated: Date.now() },
      summary: { additions: 0, deletions: 0, files: 0 },
    }
  }

  async function installParentChildFixture(page: Page) {
    const listHandler = async (route: Route) => {
      if (route.request().method() !== "GET") return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([parentRow(), childRow()]),
      })
    }
    await page.route("**/session", listHandler)
    await page.route("**/session?**", listHandler)

    await page.route("**/session/*", async (route: Route) => {
      const url = new URL(route.request().url())
      if (!/^\/session\/[^/]+$/.test(url.pathname)) return route.fallback()
      if (route.request().method() !== "GET") return route.fallback()
      const id = url.pathname.split("/").pop()
      if (id === CHILD_ID) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(childRow()) })
      if (id === PARENT_ID) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(parentRow()) })
      return route.fallback()
    })

    await page.route("**/session/*/message**", async (route) => {
      const url = new URL(route.request().url())
      if (!url.pathname.includes(CHILD_ID) && !url.pathname.includes(PARENT_ID)) return route.fallback()
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" })
    })
  }

  test("a directly-opened child session shows a disabled composer and breadcrumb, no kebab — behavior 12", async ({
    page,
  }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: PARENT_ID, projectId: PROJECT_ID, projectName: PROJECT_NAME })
    await installParentChildFixture(page)
    await seedOneProject(page, DIR)
    await openSession(page, DIR, CHILD_ID)

    await expect(page.getByText("Subagent sessions cannot be prompted.")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: "Back to main session." })).toBeVisible()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toHaveCount(0)

    // Breadcrumb: parent title / stripped child title.
    await expect(page.locator('[data-slot="session-title-parent"]')).toHaveText(PARENT_TITLE, { timeout: 10_000 })
    await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText("Debug flaky import", {
      timeout: 10_000,
    })

    // No ⋯ kebab menu at all for a child session.
    await expect(page.getByRole("button", { name: "More options", exact: true })).toHaveCount(0)
  })

  test("the parent breadcrumb navigates back to the parent session — behavior 13", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: PARENT_ID, projectId: PROJECT_ID, projectName: PROJECT_NAME })
    await installParentChildFixture(page)
    await seedOneProject(page, DIR)
    await openSession(page, DIR, CHILD_ID)

    await page.locator('[data-slot="session-title-parent"]').click()
    await expect(page).toHaveURL(sessionUrlPattern(PARENT_ID), { timeout: 15_000 })
  })

  test("a permission raised on the child bubbles into the parent's dock and resolves — behavior 14", async ({
    page,
  }) => {
    // HISTORY (un-fixme'd, entry #35): this was previously `test.fixme`'d on the
    // theory that a synthetic `permission.asked`'s `directory` — remapped by
    // `eventDirectoryForLiveSession` (src/app/providers/global-sdk/provider.tsx) to
    // the route's resolved workspaceId (`local-ses_core_session_actions_parent`) —
    // would fail the `children.has(directory)` gate
    // (src/app/integrations/session-events/event-ingress.ts) and so never reach
    // `applyDirectoryEventToShellQueries`, "the ONLY path that populates the
    // permission cache". That was true under the old `src/context/*` layout. The
    // app-shell refactor changed it: `applyDirectoryEventToShellQueries`
    // (src/features/session/data/sync/directory-event-projector.ts) now runs in
    // BOTH branches of the `children.has(directory)` check, and keys the
    // permission-request cache by `permission.sessionID` (the CHILD's id), not by
    // directory. So the child's permission reaches the parent's dock regardless of
    // how the workspace-id remap lands — no bypass, no forced binding. The mock
    // emits a production-shaped `permission.asked` (PermissionRequest properties,
    // sessionID = CHILD_ID) delivered over the real `/api/wr/events` +
    // `/api/wr/runtime-events` SSE channels via installRelayEventDrainWorkaround.
    // The `replied.sessionID === CHILD_ID` assertion below is the end-to-end oracle:
    // it can only hold if the dock rendered the CHILD's permission and the
    // Allow-once POST routed to `/session/CHILD_ID/permissions/...`. Negative
    // control (dropping the emit) leaves the header absent and times out.

    const mock = await installMockRuntime(page, { dir: DIR, sessionId: PARENT_ID, projectId: PROJECT_ID, projectName: PROJECT_NAME })
    await installRelayEventDrainWorkaround(page, mock)
    await installParentChildFixture(page)
    await seedOneProject(page, DIR)
    await openSession(page, DIR, PARENT_ID)
    // Wait until the parent's composer (and therefore its session-tree/request
    // queries, which key off the loaded directory session cache) is fully mounted
    // before emitting the child's permission — avoids a race against cache load.
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 15_000 })

    let replied: { sessionID: string; requestID: string } | undefined
    await page.route("**/session/*/permissions/*", async (route) => {
      if (route.request().method() !== "POST") return route.fallback()
      const url = new URL(route.request().url())
      const parts = url.pathname.split("/")
      const sessionID = parts[2]!
      const requestID = parts[4]!
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      replied = { sessionID, requestID }
      mock.emit({ type: "permission.replied", properties: { sessionID, requestID } })
    })

    mock.emit({
      type: "permission.asked",
      properties: {
        id: "perm_child_bash",
        sessionID: CHILD_ID,
        permission: "bash",
        patterns: ["rm -rf *"],
        metadata: {},
        always: [],
      },
    })

    await expect(page.locator('[data-slot="permission-header-title"]')).toBeVisible({ timeout: 15_000 })
    const actions = page.locator('[data-slot="permission-footer-actions"]')
    await expect(actions.getByRole("button", { name: "Allow once" })).toBeVisible()
    await actions.getByRole("button", { name: "Allow once" }).click()

    await expect.poll(() => replied?.sessionID, { timeout: 10_000 }).toBe(CHILD_ID)
    await expect(page.locator('[data-slot="permission-header-title"]')).toHaveCount(0, { timeout: 10_000 })
  })

  test("a harness session's auto-title patches the sidebar inventory even without a resolvable projectID — behavior 15", async ({ page }) => {
    // `installMockRuntime` does not mock `/api/control/sessions` (the session
    // inventory bootstrap endpoint, `src/context/global-sync/inventory-source.ts`
    // `fetchLocalControlSessions`) — spec-local route, same pattern
    // `core-sidebar-tree.spec.ts`'s `installSessionTreeFixtures` uses for the same
    // gap. Registered after `installMockRuntime` so it wins.
    const HARNESS_SESSION_ID = "ses_core_session_actions_harness_title"
    await page.route("**/api/control/sessions**", async (route) => {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{
            sessionID: HARNESS_SESSION_ID,
            title: "New Session",
            directory: DIR,
            projectID: PROJECT_ID,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }],
        }),
      })
    })

    await installMockRuntime(page, {
      dir: DIR,
      sessionId: HARNESS_SESSION_ID,
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      harness: "codex-acp",
    })
    await seedOneProject(page, DIR)
    await openSession(page, DIR, HARNESS_SESSION_ID)
    await expect(page.getByRole("textbox", { name: /Ask anything/i }).last()).toBeVisible({ timeout: 15_000 })

    // ORACLE NOTE: this behavior pins a QUERY-CACHE contract (the
    // sessionInventory row's title/projectID after the fallback), which has
    // no 1:1 DOM surface in this route's sidebar — the visible tree rows
    // render from `/api/control/session-list`, a different source. Prefer
    // DOM assertions wherever one exists (debug handles can be dev-gated and
    // dead-code-eliminated from production bundles); `__claxedoQueryClient`
    // specifically is safe here because its installation is UNCONDITIONAL
    // (src/shared/query/query-client.ts — no `import.meta.env.DEV` guard;
    // verified present in the built production bundle).
    const inventoryRow = async () =>
      page.evaluate((sessionId: string) => {
        const qc = (window as unknown as { __claxedoQueryClient?: { getQueryCache(): { findAll(): unknown[] } } })
          .__claxedoQueryClient
        if (!qc) return undefined
        const query = qc.getQueryCache().findAll().find((item) => {
          const key = (item as { queryKey?: unknown[] }).queryKey
          return Array.isArray(key) && key.includes("sessionInventory")
        }) as { state?: { data?: { sessions?: Array<{ id?: string; title?: string; projectID?: string }> } } } | undefined
        const sessions = query?.state?.data?.sessions
        return Array.isArray(sessions) ? sessions.find((item) => item?.id === sessionId) : undefined
      }, HARNESS_SESSION_ID)

    // Bootstrap has loaded the session inventory (via `layout.tsx`'s
    // `sessionInventoryActions.load()` on mount) with the ORIGINAL title.
    await expect.poll(async () => (await inventoryRow())?.title, { timeout: 15_000 }).toBe("New Session")

    // The harness's auto-title fallback (`maybeAutoTitle`,
    // packages/agent-sdk-runtime/src/harnesses/acp/title.ts) publishes a
    // `session.updated` event that hardcodes `projectID: ""`; combine that with a
    // `directory` that does NOT exactly match the registered project's worktree
    // (the directory-shape-routing debt) so `event-ingress.ts`'s OWN
    // `projectFor(info.directory)` backfill ALSO fails to resolve one — isolating
    // exactly the fallback path behavior 15 fixed in
    // `applySessionInventoryLifecycle` (src/shell/data/inventory-writers.ts).
    //
    // DELIVERY: direct route-fulfill (test-processes' `deliverCrashEvent`
    // technique), NOT `mock.emit()`. The `/api/wr/events` route is polled by
    // TWO app consumers at once — global-sdk's compat stream (`authFetch`
    // rewrites `/global/event` here, `signedRuntimeEventInput` in
    // src/utils/api.ts; it is the ONLY consumer that parses the
    // `{directory, payload}` envelope and feeds `event-ingress.ts`) and
    // ClaxedoEventsProvider's central stream (which silently DROPS envelope
    // frames — its `isClaxedoEvent` guard needs a top-level `.type`). The
    // shared mock's queue hands each emitted batch to exactly ONE of them,
    // so `mock.emit()` delivery is a coin flip that loses whenever
    // ClaxedoEventsProvider's (earlier-blocked, slower-cadence) connection
    // drains first — observed as this test's title patch never arriving.
    //
    // A prior `{ times: 2 }` cap assumed exactly ONE pending connection per
    // consumer at route-registration time — one slot each. That assumption
    // holds under the dev server (both consumers connect on a tight, similar
    // cadence) but not under the prebuilt production build: code-splitting
    // shifts when each stream's chunk mounts and starts reconnecting, so
    // ClaxedoEventsProvider's two rapid reconnects can swallow BOTH slots
    // before global-sdk's compat stream reconnects, starving the only
    // consumer that patches the inventory (~coin-flip failure, CLAXEDO_E2E_PREBUILT=1).
    // Fulfilling EVERY subsequent `/api/wr/events` GET with the same envelope
    // (no `times` cap) removes the timing dependency entirely: whichever poll
    // the compat stream lands on next carries the frame. The frame is a
    // same-payload idempotent upsert, so re-delivery to either consumer is a
    // no-op, and the route is torn down with the page context when the test ends.
    const titleEnvelope = {
      directory: DIR,
      payload: {
        type: "session.updated",
        properties: {
          info: {
            id: HARNESS_SESSION_ID,
            slug: HARNESS_SESSION_ID,
            projectID: "",
            directory: `${DIR}/.codex-sandbox-mismatched-shape`,
            title: "fix the flaky retry test",
            version: "2",
            time: { created: Date.now() - 1000, updated: Date.now() },
          },
        },
      },
    }
    await page.route(
      "**/api/wr/events**",
      async (route) => {
        await route
          .fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: `data: ${JSON.stringify(titleEnvelope)}\n\n`,
          })
          .catch(() => {})
      },
    )

    await expect.poll(async () => (await inventoryRow())?.title, { timeout: 15_000 }).toBe("fix the flaky retry test")
    // The row keeps its originally-known projectID/grouping rather than being
    // dropped from the inventory entirely.
    expect((await inventoryRow())?.projectID).toBe(PROJECT_ID)
  })
})

test.describe("core session actions: switcher tab title sync @core", () => {
  test("title syncs to the session's own switcher-strip tab label without reload", async ({ page }) => {
    // The real "second surface" for a session's title is the compact switcher strip
    // (src/app/workbench/compact-switcher/compact-switcher.tsx) rendered in the
    // workbench header — but ONLY while the sidebar rail is unpinned
    // (workbench-shell-header.tsx:80, `<Show when={!props.sidebarPinned()}>`, wired to
    // `CompactSwitcher`). `sidebarPinned` is `railRegion().docked !== false`
    // (app-shell-layout.tsx:231), so collapsing the rail via the `sidebar-toggle`
    // button (the collapse/expand bug fixed for behavior 13 in core-sidebar-tree)
    // un-docks it and reveals the strip. There's no per-pane `Titlebar` anymore —
    // that surface is dead/commented out — this switcher strip is what's real.
    const mock = await installMockRuntime(page, { dir: DIR, projectId: PROJECT_ID, projectName: PROJECT_NAME, harnessModels: SEND_MODELS })
    const mutations = trackSessionMutations(page)
    await mutations.install()
    await sendFirstPrompt(page, mock, "switcher tab title sync original title")

    // Collapse the sidebar rail to reveal the switcher strip.
    const toggle = page.locator('[data-testid="sidebar-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    await toggle.click()
    await expect(toggle).toHaveCount(0)

    const switcher = page.locator('[data-testid="compact-switcher"]')
    await expect(switcher).toBeVisible({ timeout: 10_000 })
    const tab = switcher.locator('[data-testid="compact-switcher-tab"]')
    await expect(tab).toHaveCount(1)
    const switcherTitle = tab.locator('[data-testid="switcher-title"]')
    await expect(switcherTitle).toHaveText("switcher tab title sync original title", { timeout: 10_000 })

    // Rename through the real, rendered inline editor (behaviors 1-3's choreography):
    // double-click the header title, type the new value, commit with Enter.
    await page.locator('h1[data-slot="session-title-child"]').dblclick()
    const editor = page.locator('input[data-slot="session-title-child"]')
    await expect(editor).toBeVisible({ timeout: 5_000 })
    await editor.fill("switcher tab title sync renamed")
    await editor.press("Enter")

    // The rename actually committed: a PATCH fired with the new title.
    await expect.poll(() => mutations.patches.length, { timeout: 10_000 }).toBeGreaterThan(0)
    const patch = mutations.patches.at(-1)!
    expect(patch.id).toBe(mock.session.id)
    expect((patch.body as { title?: string }).title).toBe("switcher tab title sync renamed")

    // The header itself updates (same local-first cache write behavior 3 proves).
    await expect(page.locator('h1[data-slot="session-title-child"]')).toHaveText("switcher tab title sync renamed", { timeout: 5_000 })

    // The switcher strip's OWN tab for this same session updates live too, without a
    // reload — no navigation happens between the rename and this assertion.
    await expect(switcherTitle).toHaveText("switcher tab title sync renamed", { timeout: 10_000 })
  })
})
