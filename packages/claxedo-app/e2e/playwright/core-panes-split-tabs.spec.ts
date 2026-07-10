/**
 * SPEC: Workbench panes — split, tab strip, focus, and shell chrome
 *
 * PURPOSE — the multi-surface workbench lets a user hold several sessions/terminals
 * open at once (as a compact tab strip), split two of them side-by-side, resize the
 * split, and move focus between panes with the keyboard — the IDE-style "multiple
 * things open at once" backbone every other core-loop/panel spec is rendered inside
 * of. This spec owns the workbench SHELL (panes, splits, tabs, focus, header
 * buttons, palette) — NOT what renders inside a pane (that is every `core-*` spec
 * for the content type in question) and NOT the sidebar tree (`core-sidebar-tree`).
 *
 * STATE MODEL — `WorkbenchState` (`src/claxedo-ui/layout/types.ts`):
 *   `{ panes: {id, contentId}[], split: {direction, sizes, root: SplitNode},
 *     contentIds: string[], contentRecency: string[], focusedPaneId,
 *     layoutSnapshots: Record<contentId, Snapshot> }`.
 *   - `contentIds` = every OPEN tab (visible or backgrounded); `panes` = only the
 *     currently VISIBLE slots. A tab can exist in `contentIds` with no pane (a
 *     background switcher tab) or occupy exactly one pane.
 *   - `split.root` is a binary tree of `{t:"leaf", id}` / `{t:"split", dir:"h"|"v",
 *     a, b, size}` (`size` = the `a`-side fraction, 0..1); `computePaneRects`
 *     (`layout/reducers/tree-helpers.ts`) turns it into fractional `{left,top,width,
 *     height}` per pane, consumed by `<Workbench>` (`layout/workbench.tsx`) to
 *     absolutely-position each pane/content slot.
 *   - `wb.navigation.show(contentId)` (`layout/reducers/navigation.ts`) is the ONE
 *     entry point for "make this tab visible": already-focused → no-op; visible in
 *     another pane → just focus that pane; single-pane layout → REPLACES that pane's
 *     content (the old content stays in `contentIds` as a background tab, no pane);
 *     2+-pane layout → saves a snapshot of the current layout (keyed per visible
 *     contentId, via `saveSnapshotsForCurrentLayout`) THEN, if `contentId` has a
 *     valid saved snapshot (every referenced contentId still alive), RESTORES that
 *     whole layout (panes+split+focus) verbatim; else collapses to one new pane.
 *   - `wb.split.split(paneId, edge, contentId)` (`layout/reducers/split.ts`) adds a
 *     new pane holding `contentId` on the given edge of `paneId`'s pane, unbinding
 *     `contentId` from wherever it was, and focusing the NEW pane. A self-drop
 *     (`contentId` already equals the target pane's own content) is a documented
 *     no-op (`layout/tests/I-keyboard.vitest.tsx` "mod+\\ on a single pane is a
 *     no-op"). The ONLY UI path that ever calls `split()` with a genuinely different
 *     `contentId` than the target pane's own is drag-and-drop (a tab dragged from
 *     the compact switcher onto a pane's edge) — see INVARIANTS #1.
 *   - `wb.split.close(paneId, {destroyContent})` removes a pane; `destroyContent:
 *     false` (used everywhere in this app) keeps the content in `contentIds` as a
 *     background tab. `layout.closeContent` (used by the switcher tab's own X
 *     button, via `closeSurface` in `rail-header-surfaces.ts`) instead removes the
 *     CONTENT itself (and its pane, if any) — closing a pane and closing a tab are
 *     different operations with different reach.
 *   - `wb.split.focus(paneId)` sets `focusedPaneId` and bumps that pane's content to
 *     the front of `contentRecency` (MRU order).
 *   - Persistence: the ENTIRE `ClaxedoState` (workbench + meta + terminal +
 *     workspacePanel + processPane) is written, debounced, to
 *     `localStorage["claxedo.state.v5"]` (`src/claxedo-ui/state/provider.tsx`,
 *     `STORAGE_KEY_V5`). On boot, `loadInitialState()` parses that key, then
 *     `initialStateForPath(state, pathname)` WIPES `workbench`/`meta`/`terminal`/
 *     `workspacePanel`/`processPane` back to empty whenever the boot URL "owns" a
 *     specific surface (`routeOwnsInitialSurface`: `/s/:id`, any
 *     `/w/:id/session[/:id]` — note: `/w/:id/session` with NO id still counts,
 *     because the route KIND itself is `workspace-session` regardless — `/w/:id/
 *     page/:id`, `/w/:id/terminal/:id`, or a legacy `/<b64dir>/session|page|
 *     terminal/:id` route that carries an explicit id). A legacy `/<b64dir>/session`
 *     route with NO trailing id is `legacy-directory` with no `sessionId` field, so
 *     it does NOT own the initial surface — a fresh load/reload at that exact URL
 *     hydrates the FULL persisted workbench (panes, split, snapshots) instead of
 *     wiping it. This spec's reload-survival test (behavior 14) deliberately stays
 *     on that non-owning URL form the whole time; `core-boot-deep-links-home` owns
 *     the discard-on-owning-URL side of this same mechanism.
 *   - Draft-session dedup: `layout.openSession(directory, "new", ...)` reuses an
 *     EXISTING open draft for that exact `(directory, "new")` pair instead of
 *     creating a second one (`sameWorkspaceSession` in
 *     `src/claxedo-ui/state/orchestration.ts`) — clicking "New Session" twice for the
 *     same directory just refocuses the one draft tab, it does not open two.
 *   - Empty-workbench auto-draft: `useRailEmptyDraftController`
 *     (`rail-empty-draft-controller.ts`) opens a fresh draft session one microtask
 *     after the workbench has zero visible renderable surfaces (and a fallback
 *     directory exists). `blockNextAutoOpen()` — invoked via
 *     `onLastFocusedSurfaceClosed` when the switcher's tab-close button removes the
 *     last FOCUSED tab with no next tab to fall back to — suppresses that auto-open
 *     for 2000ms, so the just-closed tab is not instantly replaced.
 *   - Shared connection ref-count: `acquireWorkspaceConnection`
 *     (`src/shell/workspace/workspace-connection.ts`) is a single-writer store keyed
 *     by `workspaceId`; every `WorkspaceGate`-wrapped pane (session or terminal) that
 *     resolves the SAME `workspaceId` acquires the SAME entry (`refs` increments),
 *     and release decrements it (full teardown debounced 5s after `refs` hits 0).
 *     This registry is ONLY exercised for relay-backed (cloud/user-hosted)
 *     workspaces — a plain local directory that does not match a signed workspace
 *     resolves no `workspaceId` at all, and `WorkspaceGate` renders its children
 *     directly without ever calling `acquireWorkspaceConnection` (see behavior 19).
 *     A dev-only debug hook, `window.__claxedoConnections.snapshot()`, exposes the
 *     live `refs` count per `workspaceId` (`workspace-connection.ts`, "E2E/debug
 *     escape hatch").
 *
 * ANATOMY —
 *   `[data-testid="workbench-root"]` — the pane-tree container.
 *   `[data-testid="pane-<paneId>"][data-pane-id="<paneId>"]` — one pane's background
 *     chrome layer (absolutely positioned per `computePaneRects`); its own
 *     `onMouseDown` focuses that pane.
 *   `[data-workbench-content="<contentId>"][data-pane-id="<paneId>"]` — the content
 *     slot for an OPEN, currently-attached-to-a-pane tab; carries
 *     `opacity-55 saturate-[0.7]` when its pane is not the focused one, else
 *     `opacity-100 saturate-100` (100ms CSS transition). A content id with NO pane
 *     (backgrounded, still open) renders a slot with no `data-pane-id`,
 *     `visibility:hidden`, cheaply retained off-screen.
 *   `[data-testid="workbench-divider"]` — the top-level resize divider, present only
 *     when `split.root` is a `{t:"split"}` node (i.e. 2+ panes); pointer-drag resizes
 *     via `wb.split.resize([], ratio)`.
 *   `[data-testid="pane-close-<paneId>"]` (button, `aria-label="Close Pane"`) —
 *     visible only when 2+ panes exist; calls `wb.split.close(paneId, {destroyContent:
 *     false})`.
 *   `[data-testid="pane-handle-<paneId>"]` — an invisible draggable overlay per pane
 *     (drag-out source, not used by this spec's drag-IN scenarios).
 *   `[data-testid="drop-target-<paneId>"]` — the 4-way (top/bottom/left/right) drop
 *     zone overlay shown while dragging a tab over a pane.
 *   `[data-testid="compact-switcher"]` (`nav[aria-label="Workbench panes"]`) — the
 *     tab strip, rendered in DOM/visual order = `aliveContents()` = `contentIds`
 *     insertion (creation) order — STABLE regardless of focus/recency changes.
 *     ONLY RENDERED while the RailSidebar is UNPINNED — `workbench-shell-
 *     header.tsx` wraps both the "Show Sidebar" button and `<CompactSwitcher>`
 *     in one `<Show when={!sidebarPinned()}>` (the pinned-open sidebar tree
 *     already doubles as the tab navigator, so the compact strip is
 *     redundant/hidden while it's docked). Every project in this spec boots
 *     with the sidebar PINNED by default (`src/claxedo-ui/state/
 *     persistence.ts`'s `defaultRail()`: `pinned: true`; `docked: rail.pinned
 *     === true` in `src/shell/layout/config.ts`) — confirmed live: every
 *     scenario here unpins it first via `unpinSidebarForSwitcher()` (mod+b)
 *     before touching switcher tabs.
 *   `[data-testid="compact-switcher-tab"]` — one tab; contains
 *     `[data-testid="switcher-prefix-trigger"]` (identity/status glyph — shows a
 *     `[data-switcher-status="idle"|"working"|"permission"|"done"]` dot instead of
 *     the project/workspace-letter label whenever status is not `"idle"`) and
 *     `[data-testid="switcher-title-button"][aria-current="page" when active]`
 *     (click to focus/select; `draggable` for session/terminal kinds only).
 *   `[data-testid="session-content"][data-session-id="<id or 'new'>"]` — a session
 *     pane's content root (`"new"` for an unsent draft).
 *   `[data-testid="terminal-pane"][data-terminal-id="<ptyId>"]` — a terminal pane's
 *     content root, mounted only once `shouldMountTerminalPane` gates pass (visible +
 *     pty resolved + a 120ms activation delay).
 *   `[data-testid="workbench-shell-header"]` — the L1 header strip; contains the
 *     compact switcher and, in `[data-testid="workbench-header-controls"]`, the
 *     `WorkspaceScopeButtons` (`aria-label="New Session"`, `"New Claude Terminal"`,
 *     `"New Codex Terminal"`, and a `[data-component="workspace-more-menu"]` dropdown
 *     with a "New Terminal" / custom-command items) — terminal buttons are omitted
 *     (via `<Show>`, not merely `disabled`) when `canUseTerminal()` is false
 *     (workspace tools blocked or a viewer role).
 *   Command palette: `mod+shift+p` (or `mod+p`, both route through the `"file.open"`
 *     command's `onSelect`) opens `<DialogSelectFile>` inside `[data-component=
 *     "dialog"]`, rendering `[data-testid="command-palette"]` (files+commands
 *     combined) containing a search `<input>` (`packages/ui/src/components/
 *     list.tsx` passes `data-slot="list-search-input"` to its `<TextField>`,
 *     but that prop never reaches the rendered `<input>` — the real DOM node
 *     is `[data-slot="list-search"] input`, plain `data-slot="input-input"`
 *     — verified live) and one `[data-slot="list-item"]` button per matching
 *     command/file/session; selecting a command item runs its
 *     `onSelect("palette")` and closes the dialog.
 *   Desktop "Quit Claxedo?" dialog — `rail-keyboard-controller.tsx`'s
 *     `closeFocusedPane`, gated on `input.platform.platform === "desktop"` AND zero
 *     alive contents remaining; NOT reachable from this spec's target (see HARNESS
 *     NOTES).
 *
 * BEHAVIORS —
 *   1. Dragging a background switcher tab onto an open pane's edge splits the
 *      workbench into two visible panes (divider appears, both content slots
 *      render).
 *   2. Dragging the top-level resize divider changes the split ratio (each pane's
 *      rendered width changes accordingly).
 *   3. Clicking to focus a pane dims the OTHER pane's content slot
 *      (`opacity-55 saturate-[0.7]`) and undims the newly-focused one
 *      (`opacity-100 saturate-100`). `visiblePaneContents` order is
 *      `aliveForRender()`/`contentIds` insertion order — draft (created
 *      first) is slot 0, terminal (created second) is slot 1 — NOT pane
 *      creation order; `wb.split.split` always focuses the newly-inserted
 *      pane, which in `buildDraftPlusTerminalSplit` is the draft's pane, so
 *      right after the split slot 0 (draft) is undimmed and slot 1
 *      (terminal) is dimmed — verified live.
 *   4. `mod+alt+ArrowLeft` / `mod+alt+ArrowRight` move focus between two
 *      horizontally split panes based on geometric adjacency.
 *   5. `mod+w` reduces a 2-pane split back to one pane (pane closes; the app has
 *      TWO independently-registered `mod+w` handlers reaching different granularity
 *      — see INVARIANTS #2 — this test pins the OBSERVABLE outcome).
 *   6. `mod+w` on the LAST remaining pane, on the desktop platform, opens the "Quit
 *      Claxedo?" confirmation dialog instead of closing anything. NOT reachable from
 *      this spec's web target (`test.fixme`, see HARNESS NOTES).
 *   7. `mod+\\` / `mod+shift+\\` (the Workbench's own built-in split shortcuts) are a
 *      PERMANENT no-op in this app because the only call site always passes the
 *      focused pane's OWN content id, which the reducer's self-drop guard rejects —
 *      a real, confirmed dead keyboard shortcut (`test.fixme`, see HARNESS NOTES /
 *      INVARIANTS #1).
 *   8. `mod+tab` / `mod+shift+tab` move focus to the next/previous entry in
 *      most-recently-used order (`contentRecency`), not tab-strip left-to-right
 *      order.
 *   9. `mod+<N>` focuses the Nth-most-recently-used open surface.
 *   10. The compact switcher's tab DOM order stays stable (creation order) across
 *      focus changes, independent of the MRU order behaviors 8/9 use internally.
 *   11. A background (unfocused) tab whose session is busy shows an amber
 *      `[data-switcher-status="working"]` dot; the dot disappears once that tab is
 *      focused. NOT independently verifiable past the FIRST post-open status
 *      transition — real app bug, `test.fixme`, see the fixme's comment for the
 *      confirmed repro (query cache correctly updates, switcher DOM does not).
 *   12. A background tab whose turn completes while unfocused shows a
 *      `[data-switcher-status="done"]` dot; the dot disappears once that tab is
 *      focused (`nextUnseenDone`'s `focused → false` branch). Same confirmed
 *      real app bug as behavior 11 (`test.fixme`).
 *   13. Navigating away from a 2-pane split to a third single-pane surface, then
 *      back to one of the split's original tabs, restores the exact split (both
 *      panes, same content) via the saved `layoutSnapshots` entry.
 *   14. A 2-pane split survives a full page reload when the boot URL does not own a
 *      specific session/page/terminal id (`claxedo.state.v5` rehydrates in full).
 *      NOT REACHABLE with this spec's draft+terminal harness — `test.fixme`, see
 *      the fixme's comment: terminal creation always syncs the URL to its own
 *      owning route (so the split never gets a chance to persist), and forcing
 *      a non-owning URL surfaces a separate terminal-metadata-survives-reload
 *      gap that's out of this spec's scope (`core-terminal` owns it).
 *   15. An empty workbench (zero open tabs, a fallback directory available)
 *      auto-opens a draft session composer; explicitly closing that tab's own X
 *      button suppresses the next auto-open for a beat (no instant replacement).
 *      NOT OBSERVABLE — `test.fixme`, real app bug confirmed via 10ms-granularity
 *      in-browser polling: the suppression never engages, a new draft replaces
 *      the closed one within ~100ms with no empty state ever appearing (see the
 *      fixme's comment).
 *   16. Header `New Session` / `New Claude Terminal` / `New Codex Terminal` buttons
 *      each open the corresponding surface as the active pane.
 *   17. `mod+shift+p` (and `mod+p`) open the command palette; typing a query and
 *      selecting a matching command entry (e.g. "Toggle Sidebar") dispatches it.
 *   18. `mod+b` toggles the sidebar's visibility. The `<nav>` element itself
 *      NEVER unmounts (`rail-sidebar.tsx` always renders it) — toggling
 *      flips `data-open`/`data-pinned` and, via `railToggleCommand`
 *      (`src/shell/layout/commands.ts`), the rail's inline `width` style to
 *      0px plus `opacity` to 0 (the `md:opacity-0` class). NEITHER
 *      `toHaveCount(0)` (still in the DOM) NOR Playwright's
 *      `not.toBeVisible()` is the right oracle: the `<nav>` also carries a
 *      permanent 1px right border (content-box sizing) that keeps its
 *      bounding box non-empty even when collapsed, and Playwright's
 *      visibility check ignores `opacity` entirely — verified live
 *      (`not.toBeVisible()` never resolves; computed width settles at
 *      "1px", not "0px"). Assert `data-open` + computed `opacity` instead.
 *   19. Two panes resolving the SAME relay-backed `workspaceId` share ONE ref-counted
 *      connection (`refs` reaches 2); closing one, with nothing left to
 *      backfill its pane (see INVARIANTS #4/#5), decrements `refs` without
 *      tearing the connection down for the surviving pane. A plain local
 *      directory never touches this registry at all (`refs` stays
 *      absent/undefined).
 *
 * INVARIANTS —
 *   1. `wb.split.split()`'s self-drop guard means the ONLY way this app's UI
 *      actually creates a NEW split from a single pane is drag-and-drop (a
 *      genuinely different content id dropped onto an existing pane's edge); the
 *      Workbench's own keyboard shortcuts for the same purpose are dead code (see
 *      behavior 7). Any future spec asserting "press mod+\\ to split" is testing a
 *      shortcut that cannot fire.
 *   2. `mod+w` is independently registered in THREE places — the Workbench's own
 *      `window` keydown listener (`layout/keyboard.ts`, always active, calls
 *      `wb.split.close`), the command-palette's `"claxedo.pane.close"` command
 *      (`rail-keyboard-commands.ts`, includes the Quit-dialog special case), and a
 *      session-scoped `"tab.close"` command (`src/pages/session/use-session-
 *      commands.tsx`). The command-palette system dedups by key SIGNATURE first-
 *      registered-wins (`command-upstream.tsx`'s `keymap` memo), so which of the
 *      latter two actually fires depends on component mount order; this spec pins
 *      the observable end state, not which registration path won.
 *   3. Completed assistant content is never hidden by stale busy state (INVARIANTS.md
 *      #2) — not directly exercised here (that is spec 5's territory), but the
 *      background-tab "working"/"done" dot transition (behaviors 11/12) is the
 *      switcher-level analogue of the same settle signal. Both are currently
 *      `test.fixme` — a confirmed real app bug independent of this invariant
 *      (`useRailHeaderSurfaces`'s `switcherItems` memo stops reacting to
 *      query-cache writes for a backgrounded tab after its first transition;
 *      see either fixme's comment).
 *   4. `WorkspaceGate`'s connection acquire/release (`workspace-gate.tsx`) is tied
 *      to COMPONENT MOUNT, not pane binding — `wb.split.close(paneId, {
 *      destroyContent: false})` (the pane-chrome X button) never unmounts the
 *      closed pane's content (`Workbench`'s "always" mountPolicy keeps it
 *      mounted off-screen as a background tab), so it does NOT release the
 *      workspace connection either; only `layout.closeContent` (the switcher
 *      tab's OWN X button) genuinely unmounts and releases — but see #5, this
 *      alone is not sufficient while the tab is still paned. Confirmed live
 *      (behavior 19): clicking the pane-close button left `refs` at 2 for a
 *      full 20s poll.
 *   5. `layout.closeContent` (`orchestration.ts`) only nullifies the closed
 *      content's pane (`contents.remove`) — it does NOT remove the pane from
 *      the split tree. A `contentId: null` pane immediately renders
 *      `<Workbench>`'s `renderEmpty` fallback (`rail-workbench-canvas.tsx`),
 *      which for a signed workspace directory is `<EmptyDraftSessionComposer>`
 *      — a full `SessionContent` render (same `[data-testid="session-
 *      content"][data-session-id="new"]` markers as a real draft) that
 *      resolves its OWN `WorkspaceGate` for the same directory. Net effect:
 *      closing a tab that's still bound to a pane in a 2+-pane split does NOT
 *      durably decrement `refs` — the vacated pane's fallback immediately
 *      re-acquires. Confirmed live (behavior 19): closing either tab (draft
 *      or terminal) while both remained part of the split left `refs` at 2
 *      for a full 20s poll every time; only closing an UNPANED background tab
 *      (reached by navigating to a THIRD surface first, behavior 13's
 *      collapse-to-one-pane mechanism, which also bumps `refs` to 3 since
 *      the third surface resolves the same workspace too) produced a clean,
 *      lasting decrement (3 → 2).
 *
 * HARNESS NOTES —
 *   - This Playwright target always serves the WEB/cloud entry point
 *     (`src/main.tsx`), which hardcodes `platform: "web"` with no `quit` handler —
 *     there is no override seam (no query param, no injectable global). The desktop
 *     Electron entry point that sets `platform: "desktop"` and wires a real `quit()`
 *     is a SEPARATE build (`claxedo-desktop`) never exercised by this suite, so
 *     behavior 6 (Quit dialog) is permanently unreachable here — `test.fixme`,
 *     verification belongs to a desktop-specific test surface, not this spec.
 *   - The real terminal PTY create route is `/api/wr/pty` (`terminal-connection.ts`'s
 *     `terminalPtyApiPath`), NOT `/api/claxedo/pty` (a stale path used by the
 *     retired `e2e-legacy/workspace-shell.spec.ts` fixture — do not copy that
 *     route path into new specs).
 *   - `installMockRuntime` models exactly ONE session id end-to-end; scenarios here
 *     that need a second/third independently-addressable pane use an unsent draft
 *     session (dead weight, no network) and/or a mocked terminal (own `/api/wr/pty`
 *     route added locally in this file, not shared) rather than a second chat
 *     session.
 *   - Playwright's bundled Chromium reports `navigator.platform === "Win32"` in
 *     this harness regardless of the host OS (same finding as `core-settings-
 *     auth.spec.ts`'s "behavior 11"; `src/context/command-upstream.tsx:11`'s
 *     `IS_MAC` check reads it) — so `mod` in every shortcut routed through the
 *     command registry (`rail-keyboard-commands.ts`: mod+tab, mod+shift+tab,
 *     mod+<N>, mod+b, the palette keybind) resolves to Ctrl in-app even when
 *     the TEST PROCESS is macOS. `process.platform === "darwin"` is therefore
 *     the WRONG check for any `page.keyboard.press` in this file; use the
 *     local `modKey(page)` helper (resolves `navigator.platform` at runtime)
 *     instead. mod+w / mod+alt+Arrow* are unaffected because they ALSO have a
 *     raw-listener path (`layout/keyboard.ts`'s `matchKey`) that accepts
 *     either modifier by design.
 *
 * OUT OF SCOPE — what renders inside a pane (composer, timeline, docks — every
 *   other `core-*` spec); the sidebar tree (`core-sidebar-tree`); terminal
 *   creation's full lifecycle/presets/reattach (`core-terminal`); cloud workspace
 *   provisioning's step pipeline (`core-cloud-provisioning`); harness ownership
 *   across the split (`core-harness-ownership-*`); permission-dock auto-respond
 *   CONFIGURATION itself (`core-docks` owns how a permission becomes auto-responded
 *   — this spec only asserts the switcher dot reacts to a still-pending one).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-panes-split-tabs"
const SESSION_ID = "ses_core_panes_split_tabs"

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

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

/** Mocks the REAL terminal PTY create route (`/api/wr/pty`, not the stale
 * `/api/claxedo/pty` legacy path — see HARNESS NOTES). Enough for a pane to mount
 * and activate; the websocket I/O is not modeled (not needed by this spec — only
 * `core-terminal` asserts terminal I/O). */
function installPtyMock(page: Page) {
  let counter = 0
  return page.route("**/api/wr/pty**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "POST" && /\/api\/wr\/pty$/.test(url.pathname)) {
      counter += 1
      const body = request.postDataJSON?.() as { title?: string } | undefined
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: `pty_test_${counter}`, title: body?.title ?? `Terminal ${counter}`, cwd: DIR }),
      })
      return
    }
    // connect / update / delete sub-routes: harmless 200s, no websocket modeled.
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
}

function switcherTabs(page: Page) {
  return page.locator('[data-testid="compact-switcher-tab"]')
}

function activeTitleButton(page: Page) {
  return page.locator('[data-testid="switcher-title-button"][aria-current="page"]')
}

function backgroundTitleButtons(page: Page) {
  return page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])')
}

function visiblePaneContents(page: Page) {
  return page.locator("[data-workbench-content][data-pane-id]")
}

/** Playwright's bundled Chromium reports `navigator.platform === "Win32"` in
 * this harness regardless of the host OS (same finding as `core-settings-
 * auth.spec.ts`'s "behavior 11" comment; see `src/context/command-
 * upstream.tsx:11`'s `IS_MAC = /(Mac|iPod|iPhone|iPad)/.test(navigator.
 * platform)`) — so `mod` in every shortcut routed through the command
 * registry (`rail-keyboard-commands.ts`: mod+tab, mod+shift+tab, mod+<N>,
 * mod+b, the palette keybind itself) resolves to Ctrl in-app even when the
 * TEST PROCESS is macOS. The Workbench's own raw keydown listener
 * (`layout/keyboard.ts`'s `matchKey`) accepts either modifier by design, so
 * mod+w / mod+alt+Arrow* (which ALSO have a command-registry duplicate that
 * never fires here) still work with either key — but mod+tab/mod+shift+tab/
 * mod+<N>/mod+b/mod+shift+p have NO raw-listener fallback and silently do
 * nothing if the wrong modifier is pressed. Resolve at runtime instead of
 * trusting `process.platform`. */
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  return isMac ? "Meta" : "Control"
}

/** The compact switcher tab strip (`[data-testid="compact-switcher-tab"]`)
 * only renders while the RailSidebar is UNPINNED —
 * `workbench-shell-header.tsx` wraps both the "Show Sidebar" button and
 * `<CompactSwitcher>` in a single `<Show when={!sidebarPinned()}>` (the full
 * sidebar tree already doubles as the tab navigator while pinned open; see
 * `src/shell/layout/config.ts`'s `docked: rail.pinned === true` and the
 * default-pinned rail state in `src/claxedo-ui/state/persistence.ts`'s
 * `defaultRail()`, which is what every freshly-seeded project in this spec
 * boots with). Every scenario that reads switcher tabs must unpin the
 * sidebar first — confirmed by running this suite before this fix:
 * `compact-switcher-tab` resolved to 0 elements everywhere. */
async function unpinSidebarForSwitcher(page: Page) {
  const mod = await modKey(page)
  await page.keyboard.press(`${mod}+b`)
  await expect(page.locator('[data-testid="compact-switcher"]')).toBeVisible({ timeout: 10_000 })
}

/** Drags a background tab's title button onto `target`'s right edge, splitting the
 * workbench (behavior 1's mechanism, reused by every test that needs 2 panes). */
async function dragTabOntoRightEdge(page: Page, tab: Locator, target: Locator) {
  const box = await target.boundingBox()
  if (!box) throw new Error("drop target has no bounding box")
  await tab.dragTo(target, { targetPosition: { x: Math.max(1, box.width - 6), y: box.height / 2 } })
}

/** Builds a 2-pane split: an unsent draft session (pane A) + a mocked terminal
 * (pane B), entirely inert (no network turn, URL never navigates away from the
 * bare non-owning `/${slug}/session` route). Used by every structural test
 * (divider, focus, snapshot-restore, reload-persistence) that does not itself
 * care about a real conversational turn. */
async function buildDraftPlusTerminalSplit(page: Page) {
  await installPtyMock(page)
  await seedOneProject(page, DIR)
  await openWorkbench(page, DIR)
  await unpinSidebarForSwitcher(page)
  await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })

  await page.getByRole("button", { name: "New Claude Terminal", exact: true }).first().click()
  await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
  await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })

  const draftTab = backgroundTitleButtons(page).first()
  const terminalContent = page.locator('[data-workbench-content][data-pane-id]').filter({ has: page.locator('[data-testid="terminal-pane"]') })
  await dragTabOntoRightEdge(page, draftTab, terminalContent)

  await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
  await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })
  return {
    sessionContent: page.locator('[data-testid="session-content"][data-session-id="new"]'),
    terminalContent: page.locator('[data-testid="terminal-pane"]'),
  }
}

test.describe("core panes: split, tabs, focus, shell chrome @tier-m", () => {
  test("dragging a background tab onto a pane's edge splits the workbench — behavior 1", async ({ page }) => {
    const { sessionContent, terminalContent } = await buildDraftPlusTerminalSplit(page)
    await expect(sessionContent).toBeVisible()
    await expect(terminalContent).toBeVisible()
    await expect(switcherTabs(page)).toHaveCount(2)
  })

  test("dragging the resize divider changes the split ratio — behavior 2", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    const divider = page.locator('[data-testid="workbench-divider"]')
    const panes = visiblePaneContents(page)
    const before = await panes.nth(0).boundingBox()
    expect(before).not.toBeNull()

    const dBox = await divider.boundingBox()
    expect(dBox).not.toBeNull()
    if (!dBox || !before) return
    const cx = dBox.x + dBox.width / 2
    const cy = dBox.y + dBox.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 160, cy, { steps: 8 })
    await page.mouse.up()

    await expect
      .poll(async () => {
        const after = await panes.nth(0).boundingBox()
        return after ? Math.round(after.width) : null
      }, { timeout: 10_000 })
      .not.toBe(Math.round(before.width))
  })

  test("focusing a pane dims the other pane's content slot — behavior 3", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    const panes = visiblePaneContents(page)
    const first = panes.nth(0)
    const second = panes.nth(1)

    // `visiblePaneContents` is ordered by `aliveForRender()`, i.e. `contentIds`
    // insertion (creation) order (see SPEC ANATOMY) — the draft session was
    // opened FIRST (`openWorkbench`'s auto-draft), the terminal SECOND (the
    // "New Claude Terminal" header click), so `first` = draft slot, `second` =
    // terminal slot, regardless of which pane either currently occupies.
    // `wb.split.split` (`layout/reducers/split.ts`) always focuses the NEWLY
    // inserted pane — here that's the draft's pane, since the draft (a
    // background tab) was dragged onto the terminal's pane edge. So right
    // after the split: draft (first) is focused/undimmed, terminal (second)
    // is unfocused/dimmed — confirmed by running this test.
    await expect(async () => {
      const firstClass = (await first.getAttribute("class")) ?? ""
      const secondClass = (await second.getAttribute("class")) ?? ""
      expect(firstClass.includes("opacity-100")).toBe(true)
      expect(secondClass.includes("opacity-55")).toBe(true)
    }).toPass({ timeout: 10_000 })

    // Click-focus the still-dimmed pane (second/terminal); dimming should flip.
    await second.click({ position: { x: 4, y: 4 } })
    await expect(async () => {
      const firstClass = (await first.getAttribute("class")) ?? ""
      const secondClass = (await second.getAttribute("class")) ?? ""
      expect(firstClass.includes("opacity-55")).toBe(true)
      expect(secondClass.includes("opacity-100")).toBe(true)
    }).toPass({ timeout: 10_000 })
  })

  test("mod+alt+ArrowLeft/Right move focus between split panes — behavior 4", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    const panes = visiblePaneContents(page)
    const first = panes.nth(0)
    const second = panes.nth(1)

    const isDim = async (locator: Locator) => ((await locator.getAttribute("class")) ?? "").includes("opacity-55")
    const mod = await modKey(page)

    // Whichever pane is focused right after the split, mod+alt+ArrowLeft moves
    // focus toward the geometrically LEFT pane.
    await page.keyboard.press(`${mod}+Alt+ArrowLeft`)
    await expect.poll(() => isDim(second), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => isDim(first), { timeout: 10_000 }).toBe(true)

    await page.keyboard.press(`${mod}+Alt+ArrowRight`)
    await expect.poll(() => isDim(first), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => isDim(second), { timeout: 10_000 }).toBe(true)
  })

  test("mod+w collapses a 2-pane split back to one pane — behavior 5", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await expect(visiblePaneContents(page)).toHaveCount(2)

    await page.keyboard.press(`${await modKey(page)}+w`)

    await expect
      .poll(async () => visiblePaneContents(page).count(), { timeout: 10_000 })
      .toBe(1)
    // The workbench never goes fully empty from a 2-pane state via a single
    // mod+w (content is preserved per `destroyContent:false`, or the closed
    // surface remains reachable as a background switcher tab either way).
    await expect(page.locator("[data-claxedo]")).toBeVisible()
  })

  test.fixme(
    "mod+w on the last remaining pane opens the desktop Quit dialog — behavior 6 (unreachable: web target hardcodes platform:'web', src/main.tsx:41-46; gate at src/claxedo-ui/layouts/rail-keyboard-controller.tsx:27)",
    async () => {
      // Intentionally not implemented — see SPEC HARNESS NOTES. This Playwright
      // target always renders src/main.tsx's web/cloud Platform object, which has
      // no `quit` handler and platform:"web" !== "desktop", so
      // rail-keyboard-controller.tsx's `input.platform.platform === "desktop"`
      // branch can never be entered from here.
    },
  )

  test.fixme(
    "mod+\\ / mod+shift+\\ split the focused pane via keyboard — behavior 7 (dead shortcut: src/claxedo-ui/layout/workbench.tsx:162-179 always passes the focused pane's OWN contentId into wb.split.split, which src/claxedo-ui/layout/reducers/split.ts:33's self-drop guard unconditionally rejects — confirmed intentional by layout/tests/I-keyboard.vitest.tsx 'mod+\\\\ on a single pane is a no-op')",
    async () => {
      // Intentionally not implemented as a passing assertion — see SPEC BEHAVIORS
      // #7 / INVARIANTS #1. Asserting "no-op" here would test a documented dead
      // code path, not user-visible product behavior; flagged as a finding.
    },
  )

  test("mod+tab / mod+shift+tab cycle focus by most-recently-used order — behavior 8", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    // Collapse to a single pane holding a 3rd surface (New Codex Terminal) so
    // mod+tab has an unambiguous MRU pair to toggle between the two BACKGROUND
    // tabs left over from the split.
    await page.getByRole("button", { name: "New Codex Terminal", exact: true }).first().click()
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(1)

    const activeTitle = async () => activeTitleButton(page).getAttribute("aria-label")
    const firstActive = await activeTitle()
    const mod = await modKey(page)

    await page.keyboard.press(`${mod}+Tab`)
    await expect.poll(activeTitle, { timeout: 10_000 }).not.toBe(firstActive)
    const secondActive = await activeTitle()

    await page.keyboard.press(`${mod}+Shift+Tab`)
    await expect.poll(activeTitle, { timeout: 10_000 }).not.toBe(secondActive)
  })

  test("mod+<N> focuses the Nth-most-recently-used surface — behavior 9", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await page.getByRole("button", { name: "New Codex Terminal", exact: true }).first().click()
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    // Explicitly visit each background tab once to pin a known recency order:
    // recency = [A, C, B] after focusing A last (C = the just-created terminal
    // that's currently active before this loop starts).
    const tabs = switcherTabs(page)
    const count = await tabs.count()
    const labels: string[] = []
    for (let i = 0; i < count; i++) {
      labels.push((await tabs.nth(i).locator('[data-testid="switcher-title-button"]').getAttribute("aria-label")) ?? "")
    }
    // Focus the FIRST tab explicitly (bumps it to MRU-front). CompactSwitcher's
    // `select()` paints `aria-current` SYNCHRONOUSLY on click (a scrub-preview)
    // but only actually commits `wb.navigation.show()` — and therefore
    // `contentRecency` — after a 48ms debounce (`SWITCH_COMMIT_DELAY_MS` in
    // CompactSwitcher.tsx). Polling `aria-current` alone can observe the paint
    // before the commit; firing mod+2 in that window races the stale debounced
    // commit, which then clobbers the mod+2 navigation right after it lands.
    // Wait out the debounce window before treating the click as settled.
    await tabs.nth(0).locator('[data-testid="switcher-title-button"]').click()
    await expect.poll(() => activeTitleButton(page).getAttribute("aria-label"), { timeout: 10_000 }).toBe(labels[0])
    await page.waitForTimeout(200)

    // mod+2 should focus the SECOND-most-recently-used surface — whichever tab
    // was active immediately before we clicked tab 0.
    await page.keyboard.press(`${await modKey(page)}+2`)
    await expect
      .poll(() => activeTitleButton(page).getAttribute("aria-label"), { timeout: 10_000 })
      .not.toBe(labels[0])
  })

  test("the switcher tab strip preserves stable creation order across focus changes — behavior 10", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await page.getByRole("button", { name: "New Codex Terminal", exact: true }).first().click()
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    const orderOf = async () => {
      const buttons = page.locator('[data-testid="switcher-title-button"]')
      const n = await buttons.count()
      const out: string[] = []
      for (let i = 0; i < n; i++) out.push((await buttons.nth(i).getAttribute("aria-label")) ?? "")
      return out
    }
    const before = await orderOf()

    // Focus each tab in turn (recency churn) — DOM order must not change.
    const buttons = page.locator('[data-testid="switcher-title-button"]')
    await buttons.nth(0).click()
    await buttons.nth(1).click()
    await buttons.nth(2).click()

    const after = await orderOf()
    expect(after).toEqual(before)
  })

  test.fixme(
    "a busy background tab shows an amber working dot that clears on focus — behaviors 11 (real app bug: switcher status dot never reacts past its FIRST post-open transition)",
    async () => {
      // REAL APP BUG, not a test gap — confirmed by direct query-cache
      // inspection (`window.__claxedoQueryClient`, exposed by
      // `src/shared/query/query-client.ts:19`). Sequence that reproduces it:
      // (1) send a real turn to completion for SESSION_ID (query cache ends
      // at `{type:"idle"}`), (2) background that tab by opening a second
      // draft, (3) `mock.emit(session.status busy)` — the switcher dot
      // correctly flips to `data-switcher-status="working"` (first
      // transition after open — works), (4) `mock.emit(session.status
      // idle)` — `queryClient.getQueryData(["shell","session",SESSION_ID,
      // "status"])` correctly reads back `{"type":"idle"}` within 5s
      // (`src/session/store/session-status-dispatcher.ts`'s
      // `dispatchSessionStatusEvent` → `setSessionStatusQueryData` writes it
      // unconditionally since busy≠idle), but the switcher tab's
      // `data-switcher-status` DOM attribute stays stuck at `"working"`
      // indefinitely (still `"working"` after 30s of polling) — i.e. the
      // underlying data is provably correct while
      // `useRailHeaderSurfaces`'s `switcherItems` memo
      // (`src/claxedo-ui/layouts/rail-header-surfaces.ts:110-136`, built on
      // `useQueries(..., { enabled: false })` at line 37-45) never
      // re-renders off the SECOND cache write for an already-open,
      // never-focused background tab — a `@tanstack/solid-query`
      // `enabled:false` + external `setQueryData` reactivity gap. This is
      // the SAME symptom independently observed for behavior 12 (busy→done
      // dot) — see that fixme for the matching repro. NOT the same issue as
      // `core-sidebar-tree.spec.ts`'s stale "shared-helper gap" fixme
      // (`mock.emit()` not reaching `/api/wr/events`) — that plumbing gap
      // is already fixed (`e2e/helpers/mock-runtime.ts:573-586` mounts
      // `/api/wr/events` unconditionally); this is a distinct, still-live
      // UI-reactivity bug one layer up. Asserting "not working" here would
      // pass by accident only if the dot never even reacted once, which is
      // not what's actually broken — flagged as a finding, not weakened.
    },
  )

  test.fixme(
    "a background tab shows a done dot after settling unfocused, cleared on focus — behavior 12 (real app bug: switcher status dot never reacts past its FIRST post-open transition)",
    async () => {
      // REAL APP BUG — see behavior 11's fixme for the full repro and root
      // cause (`useRailHeaderSurfaces`'s `switcherItems` memo,
      // `src/claxedo-ui/layouts/rail-header-surfaces.ts`, stops reacting to
      // `dispatchSessionStatusEvent`-pushed query-cache writes for a
      // backgrounded tab after the first one). Confirmed identically here:
      // `mock.emit(busy)` correctly flips the dot to "working" (first
      // transition), but the immediately-following `mock.emit(idle)` —
      // which per `nextUnseenDone` (`surface-status.ts:89-98`) should flip
      // it to "done" (`previousActive && !active`, unfocused) — never
      // lands in the DOM; the dot stays "working" (same symptom as
      // behavior 11, same underlying query key). Flagged as a finding, not
      // weakened into a passing-by-accident assertion.
    },
  )

  test("switching away from a split and back restores it via the saved snapshot — behavior 13", async ({ page }) => {
    await buildDraftPlusTerminalSplit(page)
    await expect(visiblePaneContents(page)).toHaveCount(2)

    // Navigate away to a THIRD surface — collapses to a single pane, saving a
    // snapshot for both A and B (`saveSnapshotsForCurrentLayout`).
    await page.getByRole("button", { name: "New Codex Terminal", exact: true }).first().click()
    await expect(visiblePaneContents(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    // Click back to one of the split's original tabs (the draft session).
    const draftTitle = page.locator('[data-testid="switcher-title-button"]', { hasText: "New Session" }).first()
    await draftTitle.click()

    await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })
    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible()
    await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible()
  })

  test.fixme(
    "a 2-pane split survives a full reload on a non-owning URL — behavior 14 (unreachable: terminal creation always syncs the URL to an owning route, and splits built on an owning route never persist)",
    async () => {
      // NOT REACHABLE via this app's real UI flows within this spec's harness
      // constraints (single mocked session + one terminal type) — two
      // independently-confirmed blockers, either one sufficient on its own:
      //
      // (1) `buildDraftPlusTerminalSplit`'s "New Claude Terminal" click makes
      // the terminal the SOLE active pane (single-pane REPLACE) BEFORE the
      // drag-split, and the app syncs the URL to whichever surface is
      // focused — so by the time the drag-split exists, the browser is
      // already parked on the terminal's OWNING route
      // (`/w/<dir>/terminal/<ptyId>`), not the bare non-owning
      // `/<slug>/session` this test's name requires. Confirmed live via
      // `window.localStorage`: `claxedo.state.v5`'s persisted
      // `workbench.panes` never gains the second (draft) pane while parked
      // on that owning URL — it stays pinned to the single pre-split
      // terminal pane, even though the live in-memory DOM correctly shows
      // both panes + the divider throughout (`wbOnChange` in
      // `src/claxedo-ui/state/provider.tsx` isn't committing the
      // drag-split's state while an owning route is active). The ONLY
      // documented way to create a split at all is drag-and-drop
      // (INVARIANTS #1), and dragging is only possible once BOTH surfaces
      // already exist — which requires the terminal to have been created
      // first, which is what puts the URL on its owning route in the first
      // place. There is no UI path that reaches a 2-pane draft+terminal
      // split while parked on a non-owning URL.
      //
      // (2) Forcing the issue by explicitly `page.goto`-ing to the bare
      // non-owning URL confirms `claxedo.state.v5` DOES correctly rehydrate
      // `workbench.panes`/`contentIds` (both the draft's and the terminal's
      // content ids present, one pane pointing at the terminal) — but the
      // live app then shows a FRESH auto-opened draft in that pane instead
      // of the terminal (`[data-testid="empty"]` count 0, i.e. `panes.
      // length > 0`, yet the rendered pane is a draft composer, not the
      // terminal). This matches `rail-empty-draft-controller.ts`'s
      // `visibleRenderableSurfaceIds` filtering out any pane whose
      // `meta.get(contentId)` is missing: the terminal's `ContentMeta`
      // doesn't survive this rehydration path, so the controller treats the
      // workbench as "empty" and its auto-open REPLACES the terminal pane
      // with a new draft (single-pane REPLACE semantics, same mechanism as
      // behavior 15). A terminal-metadata-survives-reload gap — squarely
      // "terminal creation's full lifecycle/presets/reattach", which this
      // spec's own OUT OF SCOPE section assigns to `core-terminal`, not
      // here. Flagged as a finding, not routed around with a fake pass.
    },
  )

  test.fixme(
    "empty workbench auto-opens a draft, and closing it suppresses the immediate re-open — behavior 15 (real app bug: the 2s suppression never engages)",
    async () => {
      // REAL APP BUG, confirmed via 10ms-granularity in-browser polling
      // (a `setInterval` sampler installed with `page.evaluate`, avoiding
      // Playwright-side round-trip latency entirely): closing the sole
      // auto-opened draft's own switcher-tab X button — the "user explicitly
      // closed the last focused tab" path that's supposed to call
      // `blockNextAutoOpen()` (`rail-empty-draft-controller.ts`, blocks
      // `shouldOpenEmptyDraftSession` for `Date.now() < blockedUntil`,
      // `blockedUntil = Date.now() + 2_000`) — is followed by a BRAND NEW
      // draft contentId within ~80-100ms, not after a 2-second suppression
      // window. The sampler never once observed `[data-testid="empty"]`
      // (count stayed 0 for the full 2.5s capture) — the workbench visibly
      // never goes empty at all; the old draft's `data-workbench-content` id
      // is replaced by a new one almost instantly. Either
      // `onLastFocusedSurfaceClosed` (wired `app-shell-layout.tsx` →
      // `rail-workbench-controller.ts` → `rail-header-surfaces.ts`'s
      // `closeSurface`) isn't actually reaching `blockNextAutoOpen`, or the
      // suppression check isn't being honored by the reactive effect that
      // re-opens the draft — the wiring reads correctly in the source but
      // the observed runtime behavior contradicts it. Flagged as a finding,
      // not routed around by asserting the (non-suppressed) replacement as
      // if it were the intended immediate-reopen behavior — this spec's own
      // BEHAVIORS #15 explicitly claims a suppression window exists.
    },
  )

  test("header buttons create the corresponding surface — behavior 16", async ({ page }) => {
    await installPtyMock(page)
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)
    await unpinSidebarForSwitcher(page)
    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: "New Claude Terminal", exact: true }).first().click()
    await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })

    await page.getByRole("button", { name: "New Codex Terminal", exact: true }).first().click()
    await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
    await expect(switcherTabs(page)).toHaveCount(3, { timeout: 10_000 })

    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 10_000 })
  })

  test("mod+shift+p opens the command palette and dispatches a selected command — behavior 17", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await openWorkbench(page, DIR)
    await expect(page.getByRole("navigation", { name: "Projects and sessions" })).toBeVisible({ timeout: 20_000 })

    await page.keyboard.press(`${await modKey(page)}+Shift+P`)
    const palette = page.locator('[data-testid="command-palette"]')
    await expect(palette).toBeVisible({ timeout: 10_000 })
    // `list.tsx` passes `data-slot="list-search-input"` to the `<TextField>`
    // component, but `TextField` doesn't forward that prop onto the actual
    // rendered `<input>` — the real DOM node carries `data-slot="input-input"`
    // instead (verified live: `[data-slot="list-search-input"]` matches 0
    // elements anywhere on the page). Target the input by its stable
    // ancestor slot instead of the never-applied attribute.
    await palette.locator('[data-slot="list-search"] input').fill("Toggle Sidebar", { timeout: 8000 })
    const item = palette.locator('[data-slot="list-item"]', { hasText: "Toggle Sidebar" }).first()
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.click()

    await expect(palette).toHaveCount(0, { timeout: 10_000 })
    // Selecting "Toggle Sidebar" unpins/collapses the rail — but the `<nav>`
    // itself NEVER unmounts (`rail-sidebar.tsx` always renders it; pinned vs.
    // collapsed only flips `data-open`/`data-pinned` and, via `railToggleCommand`
    // in `src/shell/layout/commands.ts`, its inline `width` style to 0px). NOT a
    // `not.toBeVisible()` case, though: the `<nav>` also carries a permanent
    // `border-right: 1px solid` (content-box sizing), so its rendered bounding
    // box is width:1px even when collapsed — never truly empty — and
    // Playwright's visibility check ignores `opacity` entirely, so the
    // opacity-0-but-1px-wide collapsed rail still reads as "visible" (verified
    // live: computed width stays "1px", opacity "0", stable, not transitioning
    // further). `data-open` is the actual, unambiguous collapse signal.
    const nav = page.getByRole("navigation", { name: "Projects and sessions" })
    await expect(nav).toHaveAttribute("data-open", "false", { timeout: 10_000 })
    await expect(nav).toHaveCSS("opacity", "0", { timeout: 10_000 })
  })

  test("mod+b toggles the sidebar — behavior 18", async ({ page }) => {
    await seedOneProject(page, DIR)
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await openWorkbench(page, DIR)
    const nav = page.getByRole("navigation", { name: "Projects and sessions" })
    await expect(nav).toBeVisible({ timeout: 20_000 })
    const mod = await modKey(page)

    // The sidebar `<nav>` never unmounts on toggle (see behavior 17's note) —
    // `railToggleCommand` (src/shell/layout/commands.ts) flips `docked` and
    // sets the rail's inline `width` style to 0px, plus `opacity` to 0 via the
    // `md:opacity-0` class. NOT a `not.toBeVisible()` case: the `<nav>` also
    // carries a permanent 1px right border (content-box sizing), so its
    // bounding box never actually reaches zero area even when collapsed, and
    // Playwright's visibility check ignores `opacity` — verified live
    // (collapsed computed width stays "1px", so `not.toBeVisible()` never
    // resolves). `data-open` + computed `opacity` are the real, unambiguous
    // collapse signals.
    await page.keyboard.press(`${mod}+b`)
    await expect(nav).toHaveAttribute("data-open", "false", { timeout: 10_000 })
    await expect(nav).toHaveCSS("opacity", "0", { timeout: 10_000 })
    await expect(nav).toHaveCount(1)

    await page.keyboard.press(`${mod}+b`)
    await expect(nav).toBeVisible({ timeout: 10_000 })
  })

  test("two panes on the same relay-backed workspace share one ref-counted connection — behavior 19", async ({ page }) => {
    const WORKSPACE_ID = "ws_core_panes_split_tabs"
    const RELAY_ORIGIN = "https://relay.core-panes-split-tabs.test"
    const CLOUD_DIR = "/tmp/e2e-core-panes-split-tabs-cloud"

    const mock = await installMockRuntime(page, {
      dir: CLOUD_DIR,
      sessionId: `${SESSION_ID}_cloud`,
      cloud: { workspaceId: WORKSPACE_ID, relayOrigin: RELAY_ORIGIN },
    })
    void mock

    // Enrich bootstrap/project with the `workspaces` map so
    // `signedWorkspaceFromProjects` resolves this directory to a relay-backed
    // (cloud) workspaceId instead of "local" (see SPEC STATE MODEL). Registered
    // AFTER installMockRuntime so it wins (Playwright matches last-registered
    // handler first).
    const projectPayload = [
      {
        id: "proj_core_panes_split_tabs_cloud",
        worktree: CLOUD_DIR,
        name: "core-panes-split-tabs-cloud",
        time: { created: Date.now(), updated: Date.now() },
        workspaces: {
          [WORKSPACE_ID]: { id: WORKSPACE_ID, workspaceId: WORKSPACE_ID, kind: "cloud", directory: CLOUD_DIR },
        },
      },
    ]
    await page.route("**/api/claxedo/bootstrap**", async (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          healthy: true,
          version: "1.0.0-test",
          path: { state: "", config: "", worktree: CLOUD_DIR, directory: CLOUD_DIR, home: "/tmp" },
          project: projectPayload,
          provider: { all: [{ id: "opencode", name: "opencode", env: [], models: {} }], default: {}, connected: ["opencode"] },
          provider_auth: {},
          config: { provider: { id: "opencode", model: "big-pickle" }, agent: { id: "build" } },
        }),
      })
    })
    await page.route("**/project**", async (route) => {
      const type = route.request().resourceType()
      if (type !== "fetch" && type !== "xhr") return route.continue()
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projectPayload) })
    })
    await page.route(`**/api/workspace/${WORKSPACE_ID}/connection**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          access: "cloud",
          backing: "cloud-vm",
          runtimeKind: "cloud",
          workspaceId: WORKSPACE_ID,
          relayUrl: RELAY_ORIGIN,
          runtimeAccessToken: "test-runtime-access-token",
          tokenExpiresAt: Date.now() + 5 * 60_000,
          role: "owner",
        }),
      })
    })
    await installPtyMock(page)

    await seedOneProject(page, CLOUD_DIR)
    await openWorkbench(page, CLOUD_DIR)
    await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({ timeout: 20_000 })
    await unpinSidebarForSwitcher(page)

    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            return hook?.snapshot?.()?.[wsId]?.refs ?? null
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "workspace connection never reached refs=1 for the first pane" },
      )
      .toBe(1)

    // Add a second pane (terminal) in the SAME directory/workspace via split.
    await page.getByRole("button", { name: "New Claude Terminal", exact: true }).first().click()
    await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
    await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })
    const draftTab = backgroundTitleButtons(page).first()
    const terminalContent = page
      .locator('[data-workbench-content][data-pane-id]')
      .filter({ has: page.locator('[data-testid="terminal-pane"]') })
    await dragTabOntoRightEdge(page, draftTab, terminalContent)
    await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
    await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })

    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            return hook?.snapshot?.()?.[wsId]?.refs ?? null
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "workspace connection refs never reached 2 for the second pane" },
      )
      .toBe(2)

    // Closing a TAB while its pane stays part of the split does NOT cleanly
    // decrement refs in this app, for a reason distinct from (but adjacent
    // to) INVARIANTS #4: `layout.closeContent` only nullifies that pane's
    // `contentId` (`contents.remove` in `layout/reducers/contents.ts`) — it
    // does not remove the pane from the split tree. The now-`contentId:
    // null` pane immediately renders `<Workbench>`'s `renderEmpty` fallback
    // (`rail-workbench-canvas.tsx`), which is `<EmptyDraftSessionComposer>`
    // — a full `SessionContent` render for a synthetic `sessionId: "new"`
    // meta, carrying the SAME `[data-testid="session-content"][data-
    // session-id="new"]` markers as a real draft tab. That fallback itself
    // resolves and holds the same workspace connection, so the pane never
    // actually goes empty from the connection's point of view — verified
    // live: closing either tab (draft or terminal) while both remained
    // part of the split left `refs` at 2 for a full 20s poll every time.
    // Sidestep the entanglement: navigate to a THIRD surface first (behavior
    // 13's mechanism — a 2+-pane layout collapses to ONE new pane, and BOTH
    // previous panes' content survives as UNPANED background tabs, per
    // `destroyContent:false` semantics), then close one of those background
    // tabs' switcher entries. An unpaned tab has no pane to leave behind, so
    // there is nothing for `renderEmpty` to backfill, and closing it is a
    // clean, real content-destroy with no compensating re-acquire. The new
    // (Codex) terminal ALSO resolves this same workspaceId and mounts its
    // own `WorkspaceGate` while the other two stay mounted in the
    // background — `refs` climbs to 3 here, verified live, before the
    // close brings it back down to 2 (not 1 — two live surfaces, draft +
    // one terminal, remain after closing just one background tab).
    await page.getByRole("button", { name: "New Codex Terminal", exact: true }).first().click()
    await expect(visiblePaneContents(page)).toHaveCount(1, { timeout: 10_000 })
    await expect(backgroundTitleButtons(page)).toHaveCount(2, { timeout: 10_000 })
    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            return hook?.snapshot?.()?.[wsId]?.refs ?? null
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "workspace connection refs never reached 3 for the third (Codex) surface" },
      )
      .toBe(3)

    const backgroundTabRow = switcherTabs(page)
      .filter({ has: page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])') })
      .first()
    await backgroundTabRow.locator('button[aria-label^="Close "]').click()
    await expect(switcherTabs(page)).toHaveCount(2, { timeout: 10_000 })
    await expect
      .poll(
        async () =>
          page.evaluate((wsId) => {
            const hook = (window as unknown as { __claxedoConnections?: { snapshot?: () => Record<string, { refs?: number }> } })
              .__claxedoConnections
            return hook?.snapshot?.()?.[wsId]?.refs ?? null
          }, WORKSPACE_ID),
        { timeout: 20_000, message: "workspace connection refs never dropped back to 2 after closing the background tab" },
      )
      .toBe(2)
  })
})
