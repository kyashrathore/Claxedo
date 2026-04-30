# Claxedo Workspace Architecture — Refactor Plan

**Status:** Implementation in progress. Reviewed against ground-truth code in `packages/claxedo-app/src/`. Last updated 2026-04-27.
**Deepened:** 2026-04-25 (document-review + deepen-plan: architecture-strategist, repo-research-analyst, framework-docs-researcher, data-integrity-guardian, performance-oracle).
**Goal:** Replace today's hybrid (workbench + groups + multiPane) with one canonical model: **sidebar inventory + canvas panes + workspace panel**, backed by a durable `TerminalRecord` registry.

> Whenever this doc says "old", read it as: "delete it, no compatibility shim". The user has stated no external users and no backward-compatibility requirement.

**Current implementation status (2026-04-27):** production code no longer references `focusedSurfaces`, `findSurfacePane`, `paneSurfaces(...)`, persisted `terminalOwner`, the `workbench` store/API/module, `pane-accessors.ts`, `context/claxedo-layout/open-surface-actions.ts`, `pane-terminal-recovery.ts`, `context/claxedo-layout/split.ts`, `context/claxedo-layout/multi-pane.ts`, `claxedo.multiPane`, runtime `"multi-pane"` surface types, `components/multi-pane/`, direct `claxedo.split.*` reads, legacy `Split*Requested` dispatch commands, `canvasFromLegacyLayout`, `canvasFromLegacyPane`, `SplitPaneState`, `SplitState`, persisted `groups`, persisted `split`, surface-close registry deletion, PTY-id registry delete APIs, `surfaceStoreFromGroups`, `OpenSurfacesState`, or the S1.5 legacy-equivalence diagnostic. External UI writers now create, activate, patch, close, and locate surfaces through `dispatch`, `surfaceBridge`, `claxedo.surfaces`, and `claxedo.panes`; rendered surface layout reads use `claxedo.canvas` / `surfacePane` instead of the legacy split tree. Surface add, activate, close, within-pane move, move-across-pane, drag/drop split, and pane-close commands mutate `SurfaceStore` and `CanvasState` directly; dispatch no longer carries a legacy surface-bridge write fallback. Terminal registry records carry per-record `rev` and delete revisions, with `BroadcastChannel("claxedo.store.v1")` plus storage-event merge to prevent multi-tab stale writes from resurrecting closed records. The global persistence key is now `claxedo.store.v1` with no legacy `migrate()` compatibility path.

---

## 1. Today's State (Code-Grounded)

### 1.1 The two coexisting models

The `ClaxedoLayoutStore` carries **both** a legacy and a new model at the same time (`context/claxedo-layout/types.ts:208-226`):

```ts
type ClaxedoLayoutStore = {
  rail: RailState
  workbench: WorkbenchState              // ← OLD: parallel content tree (PaneNode + contents)
  workspacePanel: WorkspacePanelState
  groups: SplitPaneState[]               // ← OLD: tab groups w/ surfaces + worktree pin
  surfaces: SurfaceStore                 // NEW shadow read model derived from groups while groups are being deleted
  split: SplitState                      // ← OLD: top-level split tree across groups
  canvas: CanvasState                    // NEW rendered surface tree; unflagged and used by WorkspaceShell
  enabled: boolean
  terminalAgentStatus: Record<string, ...>
  terminalAgentSeen: Record<string, ...>
  terminalLifecycle: Record<string, TerminalLifecycleState | undefined>
  workspaceRecency: Record<string, string[]>
  worktreeColorMap: Record<string, string>
  processPane: ProcessPaneState
  multiPane: Record<string, MultiPaneSurfaceState | undefined>  // ← NEW: per-surface pane tree
}
```

`workbench-state.ts:12-19` declares an entirely independent content union:

```ts
type WorkbenchContent =
  | { kind: "session"; workspaceDir; sessionId; title? }
  | { kind: "terminal"; workspaceDir; terminalId; title?; command? }
  | { kind: "browser"|"review"|"file"|"processes"|"page"|"workgraph"; ... }
```

…running in parallel to `PaneContent` (`types.ts:183`):

```ts
type PaneContent =
  | PagePaneContent | PagesIndexPaneContent | WorkgraphPaneContent
  | DraftSessionPaneContent | OverviewPaneContent | ScopedPaneContent
```

Two content unions, two trees, two title fields, two ownership maps. `terminalOwner` exists solely to bridge them.

### 1.2 State source inventory (concept → owners)

| Concept | Old owners | New owners | Bridge |
|---|---|---|---|
| Tab list | `groups[i].surfaces.items` (`SurfaceItem`) | `surfaces: SurfaceStore` now carries items, global order, pane order, pane ownership, and active-by-pane; `multiPane[surfaceId].layouts[].contents` still carries leaf content | `SurfaceStore` is currently derived from `groups` for adds/closes/split, but metadata and pane-local active/order writes now go SurfaceStore-first and mirror to `groups` |
| Pane tree | `split.root` + `groups[i].surfaces` | `multiPane[surfaceId].layouts[].pane` (`Pane` recursive) | `terminalOwner` for terminal-pane mapping |
| Terminal title | `SurfaceItem.title` + `WorkbenchContent.title` + `PaneContent.title` + `LocalPTY.title`/`titleNumber` (overrides/context/terminal.tsx) + PTY OSC live | — | None: 4-5 places, no single source |
| Terminal kind/command | `WorkbenchContent.command` + `PaneContent.command` | — | `dynamic-title-sync` regex-tests `command` only on `PaneContent`; `SurfaceItem` never carries `command`/`kind` |
| Terminal id | `SurfaceItem.terminalId` + `PaneContent.terminalId` + `WorkbenchContent.terminalId` + `LocalPTY.id` + `terminalOwner[ptyId]` + `terminalLifecycle[ptyId]` + URL `/terminal/:id` | — | All point to the same `ptyId` |
| Focus | `split.focusedId` (group) + `multiPane[s].layouts[].focus` (leaf) + `workbench.focusedPaneId` | — | Three separate focus pointers |
| Sidebar terminals | Reads `workbench.contents` (`sidebar-inventory.ts:48,57`) | — | Sidebar is OLD-system-only today |
| Closed-tab graveyard | Deleted from `OpenSurfacesState`; close now means gone. | — | No retained tab graveyard |

### 1.3 Identity audit

There is **no durable UI identity** for a terminal. `ptyId` is doing five jobs:

1. PTY runtime handle (server)
2. Persisted `LocalPTY.id` per directory
3. `SurfaceItem.terminalId` (route param)
4. `PaneContent.terminalId` (pane key)
5. `terminalOwner[ptyId]`, `terminalLifecycle[ptyId]`, `terminalAgentStatus[ptyId]` (registry keys)

`pane-terminal-recovery.ts` papers over this with a 60-second alias map, which only patches reconnect — not reload, not close-then-reopen.

### 1.4 Persistence

- `Persist.global("claxedo.layout.v3")` — entire `ClaxedoLayoutStore` including `groups`, `workbench`, `multiPane`, `terminalOwner`, etc.
- `Persist.workspace(dir, "terminal.v2")` — per-directory PTY list (`overrides/context/terminal.tsx:194-207`).
- `multiPane[surfaceId]` — actually persisted (it's part of the global store), contradicting the audit's note that it's "ephemeral".
- `closedSurfaces[]` — deleted; the old persisted closed-tab graveyard no longer exists.

---

## 2. Why The Bugs Happen

| Bug | Mechanism | Architectural pattern |
|---|---|---|
| 1. Closed terminal reappears via `/terminal/:ptyId` | `route-intent.ts:152-157` redirects on miss, so route alone won't resurrect. The reappear vector is **persisted layout state**: a close path that doesn't fully evict (most likely `closedSurfaces` graveyard or the tab living in `groups` AND `multiPane` with one path skipped). On reload, hydrated state still has the surface; URL just refocuses it. | Multiple sources of truth + tab graveyard + ptyId-as-identity |
| 2. Sidebar stale/missing terminals | `sidebar-inventory.ts:48,57` reads from `workbench.contents` exclusively. Layout writes go through `groups`/`multiPane`. Workbench is updated by a sync wire but it can drift. | Sidebar reading wrong source / dual content trees |
| 3. `Claude 7` → `Terminal` after reload | Terminal title lives in 4–5 places; `dynamic-title-sync` returns `undefined` for terminal type (`dynamic-title-sync.ts:97-100`), so it never reasserts. The OSC-derived "Claude 7" is written by terminal.tsx into `LocalPTY.title`/`titleNumber` but the wire that mirrors it onto `SurfaceItem.title` is fragile. After reload, a fresh PTY (or pre-OSC state) shows `Terminal`. `command` exists on `PaneContent` but not on `SurfaceItem`, so the surface tab can't even self-recover the kind. | Duplicate metadata / no `kind` on the persistent identity |
| 4. Cmd+D vs drag/drop produce different state | Cmd+D goes through `multiPane.splitLeaf()` (per-surface pane tree). Drag/drop goes through `split.splitSurface()` / `moveTab()` (top-level group split). Two different trees, two different shapes. | Two split implementations |
| 5. Closing one pane blanks unrelated panes | `closeSplitPane()` calls `mergePaneSurfaces()`. Because `multiPane[surfaceId]` is a single Solid store and many leaves subscribe to it, a close mutates the shape such that sibling leaves' identity-creating effects re-run. Combined with the alias map TTL and the ptyId-identity coupling, this cascades into blanking. | Render component's reconciliation tied to whole-surface store; no leaf-stable identity |
| 6. Blank terminal panes after reload | `pane-terminal.tsx` create-effect awaits `recoveryInflight.get(terminalId)`. If the component unmounts (or the surface re-mounts) before the promise resolves, the resolution is dropped (`disposed=true` guard). | Race between recovery promise and reactive remounts; ptyId-as-identity makes it impossible to retry with the same UI key |
| 7. ptyId is everything | See §1.3. | Conflated identities |

**One root cause covers most of this:** there is no durable, runtime-independent UI identity for a terminal, and there are two parallel state trees — so every refresh, close, or split has to reconcile across systems and one always wins inconsistently.

---

## 3. Target Model

### 3.1 Mental model (one sentence)

> The **sidebar** is an inventory of *what exists* (sessions, terminals, processes). The **canvas** is an arrangement of *what's visible right now* (panes referencing inventory items). The **workspace panel** is a contextual side panel for the focused pane. The **URL** locates an item; it never creates one.

### 3.2 Core entities

```ts
// Durable, persistent UI identity for a terminal. Lives in a per-directory
// registry, not in layout. Survives close-then-reopen, PTY reconnect, layout
// reorganization, and route navigation.
type TerminalRecord = {
  id: string                   // For records created post-refactor: "term_<ulid>".
                               // For records hydrated from existing terminal.v2:
                               // id := the existing LocalPTY.id verbatim (preserves
                               // bookmarked /terminal/<id> URLs). Both formats coexist.
  workspaceDir: string
  title: string                // Registry-stamped label. See §3.7 Numbering.
  runtimeTitle?: string        // OSC-emitted title from the PTY. Advisory; renderer
                               // may show as subtitle. Never overwrites `title`.
  kind: "shell" | "claude" | "codex"
  command?: string             // initial command (claude/codex args, etc.)
  ptyId?: string               // runtime backing PTY; may change across reconnects.
                               // Stripped on serialize; lazy-bound on hydrate.
  status: "creating" | "running"   // Frontend-projected; eventually consistent
                               // with backend. There is no "exited" — backend
                               // exit ⇒ record is deleted. See §3.9.
  createdAt: number
  rev: number                  // Monotonic version per record. Used for multi-tab
                               // last-rev-wins reconciliation. See §3.10.
}

// `SessionRecord` was considered and cut: sessions have a server-issued durable
// identity (sessionId) and an upstream source of truth (globalSync.child(dir).session[]).
// A local mirror would create the cache-invalidation problems this refactor exists
// to delete. Sessions are read directly from globalSync; the sidebar selector
// merges registry terminals with upstream sessions (§3.4).

// What a canvas leaf shows. Refers to inventory by stable record id (terminal)
// or upstream id (session/page). Does not duplicate title, command, status.
type Surface =
  | { id: string; kind: "terminal"; terminalRecordId: string; workspaceDir: string }
  | { id: string; kind: "session"; sessionId: string; workspaceDir: string }
  | { id: string; kind: "draft-session"; draftId: string; workspaceDir: string }
  | { id: string; kind: "page"; pageId: string; workspaceDir?: string }
  | { id: string; kind: "pages-index"; workspaceDir: string }
  | { id: string; kind: "workgraph"; workspaceDir: string }
  | { id: string; kind: "overview"; workspaceDir: string; overviewKind: OverviewKind }
  | { id: string; kind: "process"; processId: string; workspaceDir: string }
  // `process` ratified as a Surface kind on 2026-04-27 (see workspace-architecture-completion-plan.md
  // Item 5 amendment): a process is structurally a specialized terminal — split/drag/focus/close
  // semantics are identical to a terminal. The earlier "no good answer" objection (split-a-process)
  // was wrong; a process split is a terminal split.

// `Surface` carries no `title`, no `closable`, no `attention`,
// no `done`, no `loading`, no `badge`, no `scrollable`, no `minPaneWidth`.
// Disposition of dropped SurfaceItem fields:
//   title          → terminals[id].title (terminal); upstream session.title (session); page.title (page)
//   badge          → upstream session.badge derived from VCS sync; not on Surface
//   closable       → derived per kind by renderer (`isClosable(surface)`); not stored
//   pinned         → derived per kind (overview/pages-index are always pinned, others never);
//                    NOT stored on Surface and NOT moved to a sidebar slice. Per-pane workspace
//                    targeting (`panes[i].worktree.pinned`) is a separate, unrelated concept (§3.6).
//   attention/done → derived from registry status + agent events; not stored on Surface
//   loading        → derived from terminals[id].status === "creating"
//   scrollable, minPaneWidth → render hints. Move to a per-kind config map in canvas
//                              renderer; not part of Surface identity.

// Canvas is a single recursive pane tree of surfaces. No "groups",
// no "topTabs", no "multiPane". One shape.
type CanvasNode =
  | { kind: "leaf"; surfaceId: string }
  | { kind: "split"; dir: "h" | "v"; size: number; a: CanvasNode; b: CanvasNode }

type Canvas = {
  root: CanvasNode | null      // null = empty canvas, sidebar-only state
  focusedSurfaceId: string | null
  zoomedSurfaceId: string | null
}

// Workspace panel (the right-side contextual panel)
type WorkspacePanel = {
  open: boolean
  mode: "review" | "files" | "processes"
  workspaceDir: string | null
  focus: { kind: "session"|"terminal"|"file"|"process"; id?: string } | null
}

// Process pane (the legacy bottom-panel toggle) stays as ProcessPaneState if the
// toggle UI is still wanted. In-canvas process surfaces are a separate, ratified
// concept (Surface.kind="process" above): structurally a specialized terminal,
// rides the canvas plumbing for free. Both can coexist or one can be deleted —
// see workspace-architecture-completion-plan.md Item 5.
type ProcessPanel = ProcessPaneState  // imported as-is from today's slice
```

### 3.3 Store shape

```ts
type ClaxedoStore = {
  rail: RailState
  // Per-directory composition matches the existing per-dir pattern in
  // overrides/context/global-sync/child-store.ts (vcs/project/icon/session-cache).
  // Each inner record persists under Persist.workspace(dir, "claxedo.terminals.v1").
  // Sidebar inventory selector flattens hydrated directories.
  terminals: Record<string /* workspaceDir */, Record<string /* recordId */, TerminalRecord>>
  surfaces: Record<string, Surface>              // every surface still alive
  canvas: Canvas                                 // structure: where the splits/leaves are
  panes: PaneState[]                             // chrome side-table: per-pane attributes (see below)
  workspacePanel: WorkspacePanel
  processPane: ProcessPaneState                  // separate slice, kept verbatim (legacy bottom panel)
  // Sessions are NOT a slice — read upstream from globalSync.child(dir).session[].
  // No workbench. No groups. No split. No multiPane. No closedSurfaces. No terminalOwner.
}

// Per-pane chrome lives in a flat reactive collection joined to the surface store
// (and indirectly to the canvas tree) by pane id. The canvas tree owns *structure*
// (where splits are, which surface is active in each pane); this side-table owns
// *attributes* (which workspace each pane targets, layout flags). More SolidJS-
// idiomatic than forcing chrome onto recursive canvas nodes — addressing per-pane
// state by id avoids tree-walks and keeps the canvas reducer purely structural.
// Ratified on 2026-04-27; see workspace-architecture-completion-plan.md Item 5.
type PaneState = {
  id: string                                     // pane (tab group) id; referenced by
                                                 // surfaces.paneBySurfaceId values and
                                                 // surfaces.orderByPane keys
  worktree: { default: string | null; pinned: string | null }  // per-pane workspace targeting
  layout: PaneChromeState                        // per-pane UI flags
}

// Invariant: every panes[i].id appears as a key in surfaces.orderByPane (i.e. has
// at least one tab) OR is the focused empty pane. When the close-pane command
// removes a pane, the matching panes[] entry is filtered out in the same mutation
// (see facade.ts:1047). Existing coverage: claxedo-layout.contract-ops.test.ts:428-431
// asserts panes.length decreases after CanvasPaneCloseRequested.
```

### 3.4 Ownership rules

| Field | Owner |
|---|---|
| `TerminalRecord.title` | Registry. Stamped once at record creation per §3.7. **OSC titles never overwrite this**; they land on `runtimeTitle` only. User rename is a registry action. |
| `TerminalRecord.runtimeTitle` | Terminal context, observing PTY OSC. Advisory. Coalesced at rAF cadence per §3.8 to prevent OSC frame storms. |
| `TerminalRecord.ptyId` | Terminal context. Stripped on serialize; lazy-bound on hydrate. Rebind on PTY reconnect swaps the AttachAddon transport, not the xterm instance (§3.8). |
| `TerminalRecord.status` | Terminal context. Frontend-projected; eventually consistent with backend. Reconciled on hydrate against backend probe (§3.9). Backend exit ⇒ record deleted (no graveyard). |
| `TerminalRecord.rev` | Registry. Incremented on every mutation. Multi-tab reconciliation prefers higher rev (§3.10). |
| `Surface.id` | Generated on creation; opaque. Move-across-canvas reuses same id (§5 Slice 7 invariant). |
| `Canvas.{root, focusedSurfaceId, zoomedSurfaceId}` | Canvas reducer. Updates use `produce` in place, never wholesale `root` replacement (§5 Slice 3 invariant). |
| Sidebar inventory | **Pure selector** over `terminals` (per-dir, flattened across hydrated dirs) + `globalSync.child(dir).session[]` + `surfaces`. Memoized in two layers (§3.4.1). |
| `panes[i].worktree` | Per-pane scoping — which workspace this pane targets by default and which is pinned. **Stays per-pane** (ratified 2026-04-27); the canvas supports multiple panes pointing at different workspaces. Distinct from any future global "user pinned X in their sidebar list" preference. |
| `processPane` | Legacy bottom-panel slice. Independent of in-canvas process surfaces (Surface.kind="process"). |
| `WorkspacePanel.*` | Workspace panel slice. Independent of canvas state. |
| URL | Pure selector of canvas focus. Locate-only on receive (§5 Slice 4). |
| Sessions inventory | **Upstream only**: `globalSync.child(workspaceDir).session[]`. No local mirror. |
| xterm DOM | The `<CanvasLeaf kind="terminal">` component instance. Lifetime is tied to `Surface.id`, not `record.ptyId`. See §3.8. |

### 3.4.1 Selector memoization

Two-layer memoization for the sidebar selector to prevent focus-change re-diffs on long terminal lists:

- `inventoryByWorkspace` — memoizes over `terminals + sessions + surfaces`. Never depends on `canvas.focusedSurfaceId`. Output keyed by `workspaceDir`.
- `activeSurfaceMarker` — memoizes over `canvas.focusedSurfaceId` alone.

`<For>` in `WorkspaceSidebar` keys off (a)'s result; active marker is looked up via (b). A focus change must not invalidate (a). Slice 2 invariant covers this with `sidebar-doesnt-rediff-on-focus.test.ts`.

### 3.5 Identity rules

1. `TerminalRecord.id` is the durable UI id. It is what the URL carries (`/terminal/<recordId>`), what the canvas leaf points to, what the sidebar key is.
2. `ptyId` never appears in URLs, layout, or sidebar keys. It is a private field on `TerminalRecord`.
3. `Surface.id` is the canvas-leaf identity. Two surfaces can point to the same `terminalRecordId` only if intentionally cloned (a different surface for the same terminal — out of scope for v1; reject duplicates).

### 3.6 Subsystem responsibilities

- **Registry (`registry/terminal-registry.ts`)** — owns durable terminal records. Source of truth for `title`, `kind`, `ptyId` binding, `status`. Persisted **per directory** under `Persist.workspace(dir, "claxedo.terminals.v1")`. Hydration is eager for every directory in `workspaceRecency` at app start (parallel reads). No `SessionRecord`; sessions read upstream.
- **Canvas (`canvas/canvas-reducer.ts`)** — pane tree + focus. Pure reducer. Knows nothing about title/kind. All mutations use `produce` in place; sibling leaves do not invalidate on unrelated changes (§5 Slice 3 test).
- **Sidebar (`sidebar/`)** — pure two-layer memoized selector (§3.4.1). Owns `pinnedWorkspaceDirs` and UI chrome only.
- **Workspace panel (`workspace-panel/`)** — independent panel state. Mode toggle buttons live in the global top-right header (app-level chrome, not per-pane). `workspaceDir` is derived from the focused session's directory; the panel auto-updates when canvas focus moves to a different session. This pattern is already implemented today and is preserved verbatim; it is not changed by this refactor.
- **Process pane (`process-pane/`)** — kept as separate slice; not a canvas surface. Toggle remains keyboard-driven; panel position is fixed.
- **URL (`route/`)** — `surfaceRoute(surface)` produces URL; `routeIntent(url)` returns a *locate-only* action for terminal/session. For global types (`page`, `pages-index`, `workgraph`, `overview`), see §7 Q3 — the action union is type-split: `Locate | Redirect | LazyOpenGlobal`, with the last available only to enumerated kinds.
- **Terminal runtime (`overrides/context/terminal.tsx`)** — owns PTY connections. Publishes status/title-runtime changes by writing through to the registry (coalesced via rAF, §3.8). Holds **no** persistent UI state. The existing `sharedTerminalCache` ref-counted store is preserved as the per-directory hydrator for the registry.

### 3.7 Title numbering

Registry-derived monotonic numbering, gaps allowed:

- On record creation: `record.title := \`${kindLabel(kind)} ${nextCounter(workspaceDir, kind)}\`` (e.g. `Claude 7`).
- Counter is persisted on the per-directory registry slice as `nextNumberByKind: Record<TerminalKind, number>`. **Not** derived from sibling records (so closing all `Claude N` records doesn't reset to 1).
- Closing a record does not renumber surviving records. This matches VS Code's "Terminal 5" behavior — no dense reindex.
- User rename is a registry action that overwrites `record.title` and locks it (sets a `userRenamed: true` flag).
- OSC-emitted titles from the PTY land on `record.runtimeTitle`. The leaf renderer may show it as a subtitle. **OSC writes never touch `record.title`.** This is the single change that fixes Bug 3 (`Claude 7 → Terminal` regression).

### 3.8 Render-stability rule (xterm DOM)

This is a **non-negotiable invariant** because of how the codebase loads ghostty/xterm and a documented Solid `<Show>` pitfall.

- `<CanvasLeaf kind="terminal">` mounts the xterm instance once per `Surface.id` and stays mounted until that surface is closed.
- Today's `pane-terminal.tsx:572-573` uses `<Show when={pty()} keyed>` around the `<Terminal>` mount — this **unmounts and recreates the entire xterm subtree on every reference change**, costing 50–120 ms warm and up to 800+ ms cold per [MEMORY.md "Performance: SolidJS Panel Toggling"]. Replace it with one of:
  - Unkeyed `<Show when={ptyId()}>` (only tears down on truthy↔falsy transitions, not on value swaps), **or**
  - A persistent `<Terminal>` mount with a CSS-toggled "loading" overlay that shows while `record.ptyId` is undefined or `record.status === "creating"`.
- Re-binding to a new `ptyId` (clone, recovery, reconnect) **swaps the WebSocket transport**, not the xterm instance. xterm.js maintainer guidance: *"There should be only one instance for Terminal, WebSocket and Attach Addon"* per session (xterm.js issues #677, #1972). The detach path: dispose `AttachAddon` (or unsubscribe `term.onData`), close old WebSocket, open new one, attach. xterm `Terminal`, `loadAddon(FitAddon)`, `loadAddon(SerializeAddon)` are not reinvoked.
- Closing a `Surface` disposes that surface's xterm instance but does **not** delete the `TerminalRecord` or kill the PTY. Deleting the terminal from the sidebar is the durable destructive action: it deletes the `TerminalRecord`, kills the PTY, and removes every surface/leaf that references the record.
- The canvas reducer **never reuses a `Surface.id` for a different terminal**. Move-across-canvas reuses the same id; close-then-reopen mints a new id and a new xterm.
- OSC-emitted runtime title writes are coalesced at rAF cadence (single shared scheduler in the registry, not per terminal). A burst of 30 OSC frames in 16 ms produces one batched write. Test: `osc-burst-produces-one-batch.test.ts` in Slice 5.

### 3.9 Hydration & reconciliation

The sidebar must not render terminal items, and "+ terminal" actions must be disabled, until **both** the registry slice for the focused workspace is `ready()` **and** the one-shot reconciliation pass for that workspace has run.

**Reconciliation (per `(deploy, dir)`, run exactly once, gated by `claxedo.terminals.reconciled.<dirChecksum>` in global storage):**

1. Read `terminal.v2[dir]` (existing per-dir LocalPTY store).
2. For each `LocalPTY` with no matching `record.ptyId === pty.id` in the registry: mint a `TerminalRecord` with `id := pty.id` (preserves bookmarked URLs), carry over `title`, `cwd`, `kind` (regex-detected from `command` if the existing data carries it), `status: "running"` (provisional).
3. Issue a backend probe within 500 ms for every record with `status === "running"`: if PTY missing, **delete the record** (and any `Surface` referencing it); if alive, confirm.
4. After reconciliation, write per-dir registry under new key; existing `terminal.v2` stays as a write-through cache for scrollback only (registry holds identity).

**Close paths (user-initiated):**

- **Canvas/pane close** removes only the temporary layout surface/leaf. The `TerminalRecord` and PTY continue to exist and remain visible in the sidebar inventory.
- **Sidebar terminal delete** is the durable destructive action. It deletes the `TerminalRecord`, kills the PTY, and removes every surface/leaf referencing that record in one action. Bookmarked `/terminal/<id>` URLs to a deleted record resolve to `Redirect` per §5 Slice 4 — no resurrection.

**Backend-initiated exit:** a `pty.exited` event from the server deletes the matching record and any `Surface` referencing it. The canvas leaf unmounts; xterm is disposed.

This handles the cold-start race (data-integrity Severity 2) and the close-then-reload race (Severity 5). Eliminating the "exited" intermediate state removes the 24h GC logic and the "stale exited records" failure mode.

### 3.10 Multi-tab safety

Today's per-dir `terminal.v2` accidentally provides multi-tab scope isolation: Tab A on `dir-X` and Tab B on `dir-Y` do not collide. The registry collapses identity into a single namespace per dir, **and** tabs share `localStorage` for the global slices (`canvas`, `surfaces`, `sidebar`).

Mitigation **lands in Slice 1** (per resolved question F in §7):

- `BroadcastChannel("claxedo.store.v1")` and `storage`-event listener: when one tab commits, others reload the affected slice from `localStorage` rather than trusting in-memory state.
- Per-record `rev: number` in `TerminalRecord`. Reconciliation rule on multi-tab merge: **higher rev wins**; ties broken by `createdAt`.
- Mutations are serialized through a per-record write path that increments `rev` before `setStore`.

A diagnostic command "Dump persisted state" (Cmd+Shift+P) copies all `claxedo.*` localStorage keys to clipboard as JSON. Paired with "Reset claxedo state" that confirms, dumps, then clears `claxedo.*` keys (preserving auth/settings). Both available without DevTools. The persist layer's silent corruption-drop in `overrides/utils/persist.ts:469-474` should additionally `console.warn` with the key name and first 200 chars of the corrupted payload for forensics.

---

## 4. Migration / Deletion Stance

**No backward compatibility for users; reasonable rollout discipline for the maintainer who runs the app daily.**

### 4.0 Maintainer rollout pattern

The maintainer uses Claxedo for daily work *during* the refactor. Each schema-touching slice would otherwise wipe their open tabs, splits, terminals, and pinned worktrees. Three options were considered:

- **(A) Single bump.** Bump key once at Slice 1 to `claxedo.store.v1`. Subsequent slices migrate in-place. Risk: a bad merge in Slice 3 corrupts state with no easy rollback.
- **(B) Per-slice keys.** Each schema-touching slice bumps to a new key (`v1`, `v2`, …); maintainer wipes per slice; "Reset claxedo state" affordance from Slice 1 makes each wipe a one-action recovery. Predictable, simple.
- **(C) Dual-read, single-write.** Read both old and new key; write only new. Adds complexity per slice; eliminates wipes entirely.

**Plan picks (B).** Rationale: the codebase does not have shadow-write infrastructure (confirmed by repo-research); inventing it for the maintainer's sake is more risk than the wipe. The diagnostic "Dump claxedo state" command (§3.10) makes each wipe trivially recoverable via clipboard JSON.

### 4.1.0 Persistence key sequence

- Pre-refactor: `claxedo.layout.v3`. Untouched until Slice 1.
- Slice 1: introduces per-directory `claxedo.terminals.v1` (per `Persist.workspace(dir, ...)`). Existing `claxedo.layout.v3` continues to coexist.
- Slice 3c: replaces `claxedo.layout.v3` with `claxedo.store.v1` for the global slice (canvas + surfaces + sidebar + workspacePanel + processPane). Uses the existing `Persist.global(newKey, [oldKey])` legacy-drain at `overrides/utils/persist.ts:486-509` to delete `v3` cleanly. (This is also the moment to delete `terminal.v2` per directory if reconciliation is complete.)
- Slice 5: no key bump (cleanup-only).
- Slice 8: no key bump.

### 4.1 Files to delete (see §4.1 below)

### 4.1 Files to delete outright (slice-attributed)

- `claxedo-ui/workbench/` — entire directory (Slice 3c, done).
- `claxedo-ui/context/claxedo-layout/split.ts` — top-level split tree (Slice 3c, done).
- `claxedo-ui/context/claxedo-layout/groups-silent-failure.test.ts` — old fixtures (Slice 3c, done).
- `claxedo-ui/context/claxedo-layout/open-surface-actions.ts` (Slice 3c, done — add/close/navigation writes moved to `SurfaceStore` helpers in `facade.ts`).
- `claxedo-ui/context/claxedo-layout/pane-accessors.ts` (Slice 3c, done — inlined into `facade.ts`).
- `claxedo-ui/context/claxedo-layout/multi-pane.ts` (Slice 3c, done; replacement module is `surface-pane.ts`).
- `claxedo-ui/context/claxedo-layout/rail.ts` — if rail state is moved to a sidebar slice (Slice 2).
- `claxedo-ui/components/multi-pane/` (Slice 8, done — renamed to `components/surface-pane/`; clone-on-1008 alias fallback removed; preview/log lookup now uses the provided terminal id directly).
- `closedSurfaces[]` field on `OpenSurfacesState` (Slice 3c, done).
- `terminalOwner` map (Slice 8 — last writers gone after 3c; replaced functionally by `Surface.terminalRecordId`).
- `TerminalActionOrigin.hostId` field (Slice 3c, done — repo-research confirmed it was referenced only in tests, not production; portal pattern documented in stale README does not exist in production).
- The `migrate()` function in `context/claxedo-layout.tsx` (Slice 3c, done).

### 4.2 Behaviors to remove (not reintroduce until justified)

- **Cmd+D inside terminal as a separate split path.** Deleted; use canvas split keybind exclusively.
- **`closedSurfaces` graveyard / retained tabs.** Closing means gone. This field and the reopen command path are deleted.
- **Workbench's parallel `kind`/content union.** One `Surface` discriminator.
- **Title number suffix in surface tabs.** `Surface` has no `title` field at all — tabs render `terminals[surface.terminalRecordId].title`. Numbering, if kept, lives inside `TerminalRecord.title` as one canonical string (e.g., `Claude 7`). See §3.7 for the numbering design.
- **Cross-instance "terminalsWithTabs Map" guards** (per MEMORY.md). Single owner removes the need.

> ~~**Per-group `worktree.pinned` / `worktree.default`.**~~ **Reversed 2026-04-27.** Per-pane `worktree` stays — it expresses per-pane workspace targeting, which is load-bearing once the canvas supports multiple panes. The earlier collapse-to-`sidebar.pinnedWorkspaceDirs` proposal conflated two concepts. See workspace-architecture-completion-plan.md Item 5 for the amendment.

### 4.3 Behaviors to keep

- Per-directory PTY persistence (sane).
- Workspace recency.
- Worktree color map.
- Process pane.
- `dynamic-title-sync` for sessions / pages — but rewritten as a pure projection from registry.

---

## 5. Implementation Plan — Test-First Slices

Each slice is a PR. Each PR ends green and shippable. Slices preserve user-visible behavior except where deletion is explicit.

**Slice 0 has been removed.** Authoring contract tests as a standalone failing-but-tracked PR is busywork; bun:test does not support `test.fails` and adding one wouldn't materially gate any slice. Each slice below brings its own tests in the same PR. Sliceing is now eight steps (1, 1.5, 2, 3a, 3b, 3c, 4, 5, 7, 8) — Slice 6 (workspace panel decoupling) is dropped because §1/§2 lists no documented coupling problem.

**Cross-slice safeguards:**
- The original `claxedo:canvas` soak flag has been deleted. `<CanvasView>` is now the unconditional rendered surface; the remaining Slice 3c work is deleting the older store adapters and action modules once downstream reads are gone.
- DEV-only equivalence-assertion effect (Slice 1.5) has been deleted as part of S3c cleanup.
- `test.todo(...)` is used for invariants we want tracked but not yet asserting; pair every `.todo` with a current-behavior test in the same file. Flip `.todo` → real test in the slice that makes the invariant hold.
- Rollout schema: each schema-touching slice bumps a unique persistence key (e.g. `claxedo.store.v1` → `claxedo.store.v2`) and uses the existing `Persist.global(newKey, [oldKey])` legacy-drain at `overrides/utils/persist.ts:486-509`. The maintainer accepts a wipe per schema-touching slice; **a "dump and reset" diagnostic affordance** (§3.10) is added in Slice 1 so each wipe is recoverable.

### Slice 1 — Introduce per-directory `TerminalRecord` registry

- **Files touched:** new `claxedo-ui/registry/terminal-registry.ts`, `terminal-registry.test.ts`, `registry-hydrator.ts`. Light wiring in `overrides/context/terminal.tsx` to write `runtimeTitle`, `status`, ptyId-rebind through to the registry. New "Dump claxedo state" / "Reset claxedo state" diagnostic actions surfaced via Cmd+Shift+P.
- **Persistence:** per-directory `Persist.workspace(dir, "claxedo.terminals.v1")`. Hydrator reads existing `terminal.v2[dir]` and runs the §3.9 reconciliation once per `(deploy, dir)`, gated by `claxedo.terminals.reconciled.<dirChecksum>` in global storage. PTY ids from existing LocalPTY records become `TerminalRecord.id` verbatim — preserves bookmarked URLs.
- **Title model:** registry stamps `record.title` once at creation per §3.7. OSC writes go to `record.runtimeTitle` and are rAF-coalesced. **Surface tabs render `terminals[dir][surface.terminalRecordId].title`**, not OSC titles.
- **PTY rebind:** `record.ptyId` change swaps the WebSocket transport; xterm instance is preserved (§3.8). Replaces today's `pane-terminal.tsx:572-573` `<Show when={pty()} keyed>` with a CSS-toggled overlay over a permanent xterm mount.
- **Invariants tested:**
  - registry record persists across reload; ptyId is rebound on reattach without xterm remount
  - title stamped at creation, never overwritten by OSC
  - status transitions creating → running → exited; on hydrate, `running` records are probed and reconciled with backend (§3.9)
  - reconciliation runs exactly once per `(deploy, dir)` even with multiple DirectoryScope mounts
  - eager hydrate: every directory in `workspaceRecency` hydrates in parallel at app start
  - OSC burst at 30 frames in 16 ms produces 1 batched write to `record.runtimeTitle`
  - close-then-reload: registry says exited, backend says running → kill PTY
- **Cleanup:** none yet. `terminalOwner` and per-pane title fields still write; registry shadows.
- **Risk:** dual-write drift between registry and legacy state. This was temporarily mitigated by Slice 1.5's equivalence effect; that diagnostic is now deleted with the legacy-read cleanup.

### Slice 1.5 — DEV-only equivalence-assertion effect

- **Files touched:** new `claxedo-ui/registry/registry-equivalence.ts`. Wired in development bundle only. Deleted during Slice 3c cleanup.
- **Behavior:** `import.meta.env.DEV`-gated `createEffect` runs after every store mutation, computes a normalized projection of `{recordId, ptyId, title, kind}` tuple sets from both registry and legacy `groups`/`workbench` state, diffs them, and `console.error`s on divergence.
- **Lifetime:** stayed in tree from Slice 1.5 through Slice 3c. Deleted.
- **Invariants tested:** `terminal-registry.contract-ops.test.ts` — synthetic mutations exercise both paths; equivalence holds for every mutation.
- **Risk:** ~1–3 ms per mutation in dev. Off in production. Off by default; opt-in via `localStorage.setItem("claxedo:verify-registry", "1")` to cap noise during routine refactor work.

### Slice 2 — Sidebar reads from registry + upstream sessions

- **Files touched:** `claxedo-ui/sidebar/sidebar-inventory.ts`, `WorkspaceSidebar.tsx`, related tests. New `sidebar-pinned.ts` for `pinnedWorkspaceDirs` slice.
- **New tests:** `sidebar-inventory.test.ts` rewritten — input is `{ terminalsByDir: Record<dir, Record<id, TerminalRecord>>; sessionsByDir: (dir) => Session[]; surfaces: Record<id, Surface>; canvas: Canvas }`, not workbench. Sessions read directly from `globalSync.child(dir).session[]`; no `SessionRecord`.
- **Memoization tests:**
  - `sidebar-doesnt-rediff-on-focus.test.ts` — focus change does not invalidate `inventoryByWorkspace` memo (§3.4.1)
  - `sidebar-handles-50-terminals.perf.test.ts` — selector cost stays under 5 ms for 50 terminals × 5 dirs
- **Invariants:**
  - sidebar list = registry list ∪ upstream sessions
  - **ordering for v1: created-at descending** (newest first), per kind. A future settings-driven sort (similar to today's session sort options) is out of scope; design the selector so a `sortMode` parameter can be added without rewriting the selector shape.
  - closing a canvas `Surface` only removes layout; sidebar terminal delete removes the registry row, closes the PTY, and removes every visible surface/leaf for that record.
- **Cleanup:** `sidebar-inventory.ts` no longer imports `workbench-state`. `worktree.pinned` reads in sidebar replaced by `sidebar.pinnedWorkspaceDirs`.
- **Risk:** medium — sidebar visual regressions. This now relies on direct selector tests and UI coverage; the temporary S1.5 equivalence effect is deleted.

### Slice 3a — Canvas reducer + selectors (dark)

- **Files touched:** new `claxedo-ui/canvas/canvas-reducer.ts`, `canvas-selectors.ts`, `canvas.test.ts`. Wire as a *consumer* of existing actions: every legacy mutation (open tab, split, close, focus, move) also dispatches into the canvas reducer. Canvas state is computed but **not rendered**.
- **Reducer rules:**
  - Mutations use `produce` from `solid-js/store` for in-place updates. Never replace `root` wholesale (would invalidate every subscriber).
  - `openSurface(surfaceId, target)`, `closeSurface(surfaceId)`, `splitLeaf(at, dir, newLeafId)`, `move(fromSurfaceId, toTarget)`, `focus(surfaceId)`, `zoom(surfaceId|null)` — single action set covering both Cmd+D and drag/drop.
  - **`move` reuses the same `Surface.id`**; never disposes-and-recreates. Drag/drop and keyboard move share this path.
- **Tests:**
  - `canvas-reducer.test.ts` — every action; pure reducer.
  - `canvas-roundtrip.test.ts` — persist+rehydrate idempotent.
  - `canvas-leaf-doesnt-rerender-on-sibling-change.test.ts` — split a tree, mutate sibling A, assert sibling B's leaf component create-effect did not re-run. **Gate for merge.** This test fails on a naïve immutable-style reducer; passes when `produce` is used in place.
  - `move-preserves-surface-id.test.ts` — move-across-canvas reuses the same id (Slice 7 hardens this).
- **Equivalence extension:** deleted with the S1.5 diagnostic cleanup.
- **Cleanup:** none yet.
- **Risk:** low. Dark code; renderer untouched.

### Slice 3b — Renderer cutover to CanvasView

- **Files touched:** new `claxedo-ui/canvas/CanvasView.tsx`. The layout renderer now renders `<CanvasView>` directly; the legacy renderer path and localStorage cutover flag are deleted.
- **Flag mechanism:** none. There are no users and no backward-compatibility requirement for this workspace cutover.
- **`<CanvasLeaf kind="terminal">` constraints (§3.8):**
  - mounted once per `Surface.id`; never unmounts on `record.ptyId` reference change
  - no `<Show keyed>` inside the leaf
  - rebind path swaps `AttachAddon` (or socket `onData` subscription); xterm instance survives
- **`<CanvasLeaf>` for non-terminal kinds:** thin component reading from `surfaces[id]` and dispatching to the appropriate page/session renderer. Already cheap to remount.
- **Empty canvas (`Canvas.root === null`):** renders a **session composer** — the existing new-session creation UI with explicit directory selection. No CTA placeholder; the composer *is* the empty state and produces a session on submit. Empty canvas is intended to be transient.
- **Tests:**
  - `pane-terminal-rebind-doesnt-remount.perf.test.ts` — rebind ptyId 10 times; assert `Terminal.open()` count == 1
  - `canvas-view.vitest.tsx` — split, focus, zoom render correctly
  - `rail-layout.vitest.tsx` — `root === null` mounts the session composer; submit creates a draft session in the selected workspace
- **Cleanup:** legacy renderer branch deleted from `rail-layout.tsx`; legacy store adapters remain until Slice 3c is complete.
- **Risk:** medium. The cutover is guarded by focused CanvasView, rail-layout, and route/surface tests rather than a runtime flag.

### Slice 3c — Delete legacy

- **Files touched:** `groups: SplitPaneState[]`, `split: SplitState`, `multiPane: Record<string, MultiPaneSurfaceState>`, `context/claxedo-layout/split.ts`, and `multi-pane.ts` are deleted from the production store/API. The `claxedo:canvas` flag, layout-level legacy renderer, `WorkbenchRenderer` fallback, `OpenSurfacesState.closedSurfaces`, exported `focusedSurfaces` facade, exported `findSurfacePane` facade, direct production `paneSurfaces(...)` calls, persisted `terminalOwner` map, `TerminalActionOrigin.hostId`, `claxedo-ui/workbench/` directory, `context/claxedo-layout/pane-accessors.ts`, `context/claxedo-layout/open-surface-actions.ts`, `canvasFromLegacyLayout`, `canvasFromLegacyPane`, and the `migrate()` function in `context/claxedo-layout.tsx` are deleted. Canvas resize updates canvas state directly; surface add/activate/close, pane-local active/order, move-across-pane, drag/drop split, and pane-close commands now write `SurfaceStore`/`CanvasState` directly instead of dispatching through a legacy surface-bridge fallback. Solid store record replacements use `reconcile` when removing surfaces/pane ownership so deleted ids cannot survive merge semantics. A top-level `SurfaceStore` is exposed through `claxedo.surfaces`, and the pane-control surface is `claxedo.panes` rather than `claxedo.split`. The rail sidebar, dynamic title sync, overview lookup, process diagnostics, process pane diagnostics, agent status listener, selector active/visible-surface reads, app snapshot/workgraph scans, CanvasView rendered-surface lookup/drop ownership, file-tree/sidebar targeting, SurfaceContentRenderer retention, tab workgraph, prompt submit, session overrides, dialog file targeting, batch autotab, demo tour controls, and rail-layout active/shortcut/workspace-panel reads now read surface metadata from `claxedo.surfaces` instead of traversing `groups`, `focusedSurfaces`, `paneSurfaces`, `split.focusedId()`, or `workbench.contents`. The route intent adapter and all `claxedo-layout-actions` entry points (session, workspace, project, terminal, page, overview) now execute surface creation, activation, close, and patch behavior through `dispatch` plus `claxedo.surfaces` reads; they no longer call `focusedSurfaces`, `paneSurfaces`, `workbench.show`, or `workbench.state().contents` directly. `process-ownership.ts` is also on the command boundary for terminal tab add/activate/close.
- **Tests:**
  - `closed-terminal-stays-closed.test.ts` — close + reload + URL revisit → no resurrection
  - `cmd-d-equals-drag-split.test.ts` — both paths produce identical canvas shape
  - `sidebar-mirrors-registry.test.ts` — sidebar list = registry list across all flows
  - All `.todo` tests from earlier slices flip to real assertions.
- **Cleanup:** S1.5 equivalence effect deleted (no second source to assert against).
- **Risk:** low after 3a + 3b are green.

### Slice 4 — Route is locate-only (with type-split exception for global kinds)

- **Files touched:** `route-intent.ts`, `surface-route.ts`, `ClaxedoLayout.tsx` route bridge.
- **Action union (type-enforced, replacing today's mixed function):**
  - `Locate { surfaceId }` — focus an existing surface
  - `Redirect { url }` — replace URL when target missing
  - `LazyOpenGlobal { kind, payload }` — open a global surface (page/pages-index/workgraph/overview) on first visit; **not available** for terminal/session at the type level
- **New tests:**
  - `/terminal/<recordId>` to a closed/missing record → `Redirect`, **no** registry mutation, **no** surface added
  - `/terminal/<recordId>` to an open record but not in canvas → `Locate` to the surface pointing at the record; never create a duplicate
  - `/page/<id>` first visit → `LazyOpenGlobal { kind: "page", payload: { pageId } }`; subsequent visits → `Locate`
  - `/session/<id>` to an unknown session → `Redirect` to workspace root (sessions are server-issued; they're not lazy-created from URL)
  - URL reflects canvas focus; no terminal surface is ever created from URL
- **Invariant:** `routeIntent` is a pure function `URL → Locate | Redirect | LazyOpenGlobal`. The type union is exhaustive; the compiler forbids `LazyOpenGlobal` for terminal/session kinds.
- **Cleanup:** remove `addTerminal` from `route-intent.ts` outright. `addPage` / `addPagesIndex` / `addWorkgraph` survive only in the `LazyOpenGlobal` branch; their direct callers in route handling are deleted.
- **Risk:** low — type-split makes the locate-only invariant compile-checked, not policy-checked.

### Slice 5 — One title source per terminal (mostly cleanup)

After Slice 1 ships, `record.title` is already the single writer (registry-stamped at creation per §3.7). This slice deletes the remaining duplication.

- **Files touched:** `dynamic-title-sync.ts` (delete the terminal branch — it's already a no-op for terminals; this clarifies the model). `overrides/context/terminal.tsx` to remove direct writes to `LocalPTY.title` for the purpose of tab labels (`LocalPTY.title` becomes scrollback metadata only). Tab renderers updated to read `terminals[dir][surface.terminalRecordId].title`.
- **New tests:**
  - reload preserves persisted `record.title` exactly; no fallback to "Terminal"
  - Claude/Codex `kind` derived from `command` at creation; persisted in registry
  - title numbering monotonic per `(workspaceDir, kind)`; close does not renumber survivors
  - user rename overwrites `record.title` and locks `userRenamed: true`; subsequent OSC writes don't touch it
  - OSC burst at 30 frames in 16 ms → 1 batched write to `runtimeTitle` (rAF coalescing test from Slice 1, kept)
- **Cleanup:** the `dynamic-title-sync.ts` terminal branch (already a no-op) is deleted; the file becomes session-and-page-only.
- **Risk:** low.

### Slice 6 — *(Dropped.)*

The original "Workspace panel decoupling" slice is removed. §1/§2 lists no documented panel-coupling bug; §9.7 risk row was "low". The workspace-panel slice is already independent of `groups`/`workbench` after Slice 3c; nothing further is needed.

If a real coupling appears during 3a–3c, reintroduce as a targeted patch — not a slice.

### Slice 7 — Drag/drop unification + accessibility

- **Files touched:** `canvas/CanvasView.tsx`, `surface-drag-preview.tsx`. Drop handlers consolidated under the canvas reducer's `move` and `splitLeaf` actions (introduced in Slice 3a).
- **Cmd+D removed entirely.** No remap. Splits happen via drag/drop and the canvas split keybinding from the global keymap (existing `mod+\` and `mod+alt+Arrow` per MEMORY.md). Delete the in-terminal Cmd+D handler. No new keybinding is introduced.
- **Drop targets enumerated:**
  - empty canvas (`Canvas.root === null`) → first drag-drop into the canvas opens it; the session composer (Slice 3b) is replaced by the dropped surface
  - existing leaf, north/south/east/west edges → `splitLeaf(at: leafId, dir, newLeafId, surfaceId)`
  - existing leaf, center → `move(surfaceId, { intoLeaf: leafId })` (replaces content; closes outgoing surface only if it was a duplicate move-not-add)
  - tab bar (future) — out of scope for v1
  - reject feedback for in-flight drags into invalid targets (visible cursor change)
- **Accessibility (in scope for v1):**
  - keyboard navigation: focus rotation across canvas leaves via existing `mod+alt+Arrow`; tab strip uses `role="tablist"` / `role="tab"` semantics; close affordance is keyboard-reachable
  - screen-reader landmarks: canvas root is `role="main"`; sidebar is `role="navigation"`; workspace panel is `role="complementary"`; recursive splits expose `role="group"` with `aria-label` describing pane index/path
  - focus indicator on the focused leaf (not just on the focused tab): visible 2px outline on focused leaf
  - color-contrast pass on tab strip and sidebar selected/hover states
- **Responsive deferred:** breakpoint behavior (canvas → single pane, sidebar → drawer, panel → sheet) is **out of scope for v1**. Document as a v2 follow-up.
- **New tests:**
  - `move-preserves-surface-id.test.ts` — drag a terminal across groups; assert `Surface.id` unchanged; assert xterm `Terminal.open()` count == 1 (regression test for §3.8)
  - `drop-on-edge-splits.test.ts` × 4 (one per direction)
  - `drop-on-empty-canvas.test.ts`
  - `keyboard-focus-rotation.test.ts` — `mod+alt+Arrow` rotates focus across leaves
  - `tablist-aria.test.ts` — tab strip has correct ARIA roles
- **Cleanup:**
  - delete two-system drop handlers from the legacy renderer (already gone after Slice 3c, but verify)
  - delete the Cmd+D keybinding handler in the terminal context (done)
- **Risk:** medium — drag UX is finicky; perf-oracle flagged that drag-to-split must reuse `Surface.id` to avoid xterm remount.

### Slice 8 — *(Superseded.)*

The original "final sweep" is replaced by **`workspace-architecture-completion-plan.md`** (2026-04-27). That doc enumerates five concrete items: slim `SurfaceItem`, per-directory registry persistence, delete tab-context-sync, xterm rebind perf test, plan amendments. Read it for the current punch list.

Items already done from the original Slice 8 (kept here for the audit trail):
- `pane-terminal-recovery.ts` and `pane-terminal-reconnect.test.ts` deleted (alias-based clone fallback removed).
- S1.5 equivalence effect deleted.
- Multi-tab safety (`BroadcastChannel` + storage merge + per-record `rev`) shipped in Slice 1 (§3.10).
- Persisted `terminalOwner` map deleted; process ownership is runtime-only.

Items dropped from the original Slice 8:
- "`worktree.pinned` cleanup" — reversed; per-pane `worktree` is load-bearing (see §4.2 strikethrough above).
- `tab-context-sync` removal moved to its own Item 3 in the completion plan (full deprecation: browser publisher + gateway routes + MCP tool).

---

## 6. Worldview Shift (Prose, Not Decisions)

The decisions are in §4 (file/field disposition) and §5 (slices); this section captures the worldview behind them.

The architecture today is built around **trees of UI containers** (groups, splits, multi-panes, workbench panes) with **identifiers that wear too many hats** (PTY id is also URL id, pane key, sidebar key, registry key). Bugs come from "two systems agreeing about the same fact" failing — sidebar says one thing, layout says another, route resurrects a third.

The architecture this plan moves to is **inventories of durable records** (terminals registry; surfaces) with **one canvas tree** that arranges them and **a sidebar that lists them**. Identity is split correctly: `TerminalRecord.id` is durable across reload, reconnect, and reorganization; `ptyId` is a runtime field that may change; URLs reference durable ids; xterm DOM is keyed by `Surface.id` and never re-mounts on `ptyId` swaps. Routes locate; they never create. Title has exactly one writer per kind: registry-stamped for terminals, upstream for sessions, page-meta for pages.

When reviewing a PR for this refactor, the litmus test is: **"What field would two slices be tempted to write to?"** If the answer is "none", you're aligned. If the answer is "this one", that's the bug to fix before merge. The deepened §9.4 ownership table is the canonical reference; if you find yourself wanting to add a slice that writes a field someone else owns, redirect through the owner.

Specifics that were enumerated as anti-patterns in earlier drafts have moved into §4 as concrete deletion items and into the slice invariants in §5. This section no longer duplicates them.

---

## 7. Open Questions

Resolved (recorded for the audit trail):

1. *Duplicate `Surface` → terminal record forbidden in v1 (§3.5 rule 3).*
2. *Process pane stays as a separate slice; not a `Surface.kind`. Future `Surface.kind="process-log"` is out of scope for v1.*
3. *Type-split routing. `LazyOpenGlobal` only for global kinds; terminal/session are locate-or-redirect (§5 Slice 4).*
4. *`overview` is a `Surface.kind` reachable from the sidebar. Commit `574d15e75` preserved.*
5. *`SessionRecord` cut. Sessions read directly from `globalSync`.*
6. *(was identical to §3.5 rule — already resolved.)*
7. *Per-directory composed registry: `Record<workspaceDir, Record<recordId, TerminalRecord>>` under `Persist.workspace(dir, "claxedo.terminals.v1")`.*
8. *Drag-from-sidebar focuses existing surface; never duplicates.*
9. *`sidebar.pinnedWorkspaceDirs: string[]` replaces `worktree.pinned`.*

Resolved during deepen-plan review:

A. *Cmd+D **killed entirely**. No remap. Slice 7 deletes the handler. Users split via drag/drop and the existing global canvas-split keybinding (`mod+\`, `mod+alt+Arrow`).*

B. *Sidebar ordering: **created-at descending** for v1. Future enhancement: settings-driven sort modes mirroring the existing session sort. Slice 2's selector accepts a `sortMode` parameter so v2 can add modes without rewriting.*

C. *Exited-terminal sidebar treatment: **none**. Sidebar terminal delete deletes the record and kills the PTY; the sidebar simply removes the row. Canvas/pane close is temporary layout removal only. No "exited" status, no graveyard, no 24h GC. `TerminalRecord.status` enum is `"creating" | "running"` only. (See §3.2, §3.9 close path.)*

D. *Empty canvas (`root === null`) renders the **session composer** with directory selection — the same UI used today to create a new session, surfaced as the canvas-empty state. Submit creates a `draft-session` `Surface` and focuses it. Empty canvas is intended to be transient. (See Slice 3b.)*

E. *Workspace panel mode switching is **already implemented correctly** today: mode toggle buttons live in the global top-right header (app-level chrome, not per-pane); `workspaceDir` is derived from the focused session's directory; the panel auto-updates on canvas focus change. The refactor preserves this verbatim. (§3.6 documents the existing behavior.)*

G. *Recently-closed-tab affordance: **dropped**. Same rationale as C — no graveyard, no resurrection. `Cmd+Shift+T`-style reopen is removed.*

H. *Accessibility is **in scope for v1**: keyboard focus rotation, tablist ARIA, screen-reader landmarks, visible focus indicator on the focused leaf. Responsive (small-screen breakpoints) is **deferred to v2**. (See Slice 7.)*

Active question: none.

F. **Multi-tab safety timing: resolved.** §3.10 ships with Slice 1. `BroadcastChannel("claxedo.store.v1")`, storage-event merge, per-record `rev`, and delete revisions are implemented so stale tabs cannot resurrect closed terminal records.

---

## 8. Team Review Checklist

For each slice PR, reviewers verify:

- [ ] No new code reads from `workbench`, `groups`, `split`, `multiPane`, `closedSurfaces`, or `terminalOwner`.
- [ ] No production code generates a `ptyId`-shaped string for use as a UI key.
- [ ] No render component dispatches mutations during effect/render that change layout shape (only intent dispatches).
- [ ] Every new "what surfaces exist?" query goes through the registry/sidebar selector, not a direct store read.
- [ ] URL changes are consequences of canvas state, not causes of it (except for the locate-only `routeIntent`).
- [ ] Title for any visible terminal comes from `TerminalRecord.title` and only that.
- [ ] Tests added in the slice would have caught at least one of the bugs in §2.
- [ ] Deletion list for the slice is satisfied — no unused old code remains.

---

## 9. Self-Review (7 Lenses)

### 9.1 Correctness — does this remove the observed bugs?

- **Bug 1 (resurrection):** the `closedSurfaces` graveyard candidate is deleted, and the divergent `groups`/`split` persistence model is gone from production state. Slice 4 makes routes locate-only.
- **Bug 2 (sidebar staleness):** sidebar is a pure selector over the registry (slice 2). Single source.
- **Bug 3 (title regression):** single writer to `record.title` (slice 5); `kind` is persisted on the record. Reload trivially restores.
- **Bug 4 (split divergence):** one canvas reducer (slice 3). Cmd+D and drag call the same action.
- **Bug 5 (close blanks neighbors):** canvas reducer is pure; leaves keyed by stable `Surface.id`. Sibling effects don't re-run on unrelated leaf removal.
- **Bug 6 (blank reload):** `Surface.id` is stable; the leaf component remounts with a stable key and re-binds to `record.ptyId` when it's available, with a deterministic loading state. No promise/recovery race.
- **Bug 7 (ptyId as everything):** `TerminalRecord.id` is the durable UI id; `ptyId` is private.

All seven trace to architectural changes, not patches. ✅

### 9.2 Simplicity — is the model smaller?

Roughly:
- **Today:** `workbench` (PaneNode + contents) + `groups[].surfaces` + `split.root` + `multiPane[surfaceId].layouts[].pane` + `terminalOwner` + `terminalLifecycle` + `LocalPTY` per directory + `closedSurfaces` + alias map. Two content unions. Two split trees. Three focus pointers.
- **Target:** `terminals: Record<string, TerminalRecord>` + `surfaces: Record<string, Surface>` + `canvas: Canvas` + `workspacePanel`. One content discriminator. One pane tree. One focus pointer.

Net deletion estimate: **~3000–4000 lines** (full `workbench/`, `split.ts`, `pane-accessors.ts`, `open-surface-actions.ts`, `multi-pane.ts`, `pane-terminal-recovery.ts`, plus large reductions in `facade.ts`, `terminal.ts`, `commands.ts`). New code is small (canvas reducer + registry are each plausibly <300 lines).

✅ Smaller.

### 9.3 UX mental model — sidebar + canvas + workspace panel?

- Sidebar = "what exists" (registry-backed list). Click to open in canvas.
- Canvas = "what's visible" (one tree). Split, move, close, focus.
- Workspace panel = "what's adjacent to the focused thing" (review/files/processes for the current dir).

The model maps 1:1. ✅

### 9.4 State ownership — every field owned exactly once?

Expanded after deepening (architecture-strategist's "every field" prompt):

| Field | Owner |
|---|---|
| `TerminalRecord.{title, kind, command, createdAt}` | Registry (per-dir slice). Stamped at creation; `title` immutable except via user rename. |
| `TerminalRecord.runtimeTitle` | Terminal context. rAF-coalesced. Advisory. |
| `TerminalRecord.ptyId` | Terminal context. Stripped on serialize; lazy-bound on hydrate. AttachAddon swap on rebind, no xterm remount. |
| `TerminalRecord.status` | Terminal context. Frontend-projected; reconciled with backend probe on hydrate (§3.9). |
| `TerminalRecord.rev` | Registry write path (incremented on every mutation). Multi-tab merge prefers higher rev. |
| Session inventory | Upstream `globalSync.child(workspaceDir).session[]`. No local mirror. |
| `Surface.*` | Surfaces slice. `Surface.id` reused on move; never reused on close-then-reopen. |
| `Canvas.{root, focusedSurfaceId, zoomedSurfaceId}` | Canvas reducer. `produce` in place; never wholesale `root` replace. |
| `WorkspacePanel.*` | Workspace panel slice. Independent of canvas. |
| `processPane.*` | Process pane slice (kept verbatim). Independent of canvas. |
| `sidebar.{pinnedWorkspaceDirs, collapsed, hovered, locked}` | Sidebar slice. |
| Sidebar inventory derivation | Two-layer memoized selector (§3.4.1). |
| URL | Pure selector of canvas focus. |
| xterm DOM | `<CanvasLeaf kind="terminal">` instance. Lifetime tied to `Surface.id`. |
| Per-directory `terminal.v2` (post-Slice-1) | Cache for scrollback only. Registry is canonical. |
| `Persist.global("claxedo.store.vN")` | One key per schema-touching slice; legacy drain removes prior. |
| `BroadcastChannel("claxedo.store.v1")` events | Multi-tab reconciliation only. Not state. |
| `claxedo:canvas` localStorage flag | Deleted; CanvasView is unconditional. |
| `claxedo.terminals.reconciled.<dirChecksum>` flag | One-shot reconciliation gate; never re-flipped. |

No field is owned by two slices. xterm DOM is the field most prone to ambiguity; §3.8 nails it. ✅

### 9.5 Testability — verifiable without browser tests?

- Registry: pure data + transitions → unit tests.
- Canvas reducer: pure → unit tests (the gold standard).
- Sidebar selector: pure function → unit tests.
- Route intent: pure `URL → action` → unit tests.
- Title sync: pure projection → unit tests.

The only browser-required surface is the actual rendering layer (`<CanvasView>`, terminal xterm mount). Compared to today, where most of the bugs are reproducible only in a real browser, this is a substantial improvement. ✅

### 9.6 Migration / deletion — what comes out?

The persisted `groups`/`split` compatibility model is deleted. The `closedSurfaces` field, `WorkbenchRenderer` fallback, full `claxedo-ui/workbench/` directory, migration block, persisted `terminalOwner` map, `WorkbenchContent` union, S1.5 equivalence diagnostic, `pane-accessors.ts`, `open-surface-actions.ts`, `pane-terminal-recovery.ts`, `groups-silent-failure.test.ts`, external focused-pane surface reads, standalone `split.ts`, standalone `multi-pane.ts`, `components/multi-pane/`, runtime `"multi-pane"` surface type, `claxedo.multiPane`, production `claxedo.split.*` reads, legacy `Split*Requested` commands, and the legacy split move/close mutators are deleted or migrated; `claxedo.surfaces`, `claxedo.panes`, and `claxedo.canvas` are now the replacement read/write surfaces for much of the app shell and renderer layer, including surface add/activate/close/move, split create, and pane close. ✅

### 9.7 Risk — what's likely to break during rollout?

| Risk | Severity | Mitigation |
|---|---|---|
| Slice 3 (canvas replacement) regresses many UI flows at once | High → Medium | Now split into 3a/3b/3c; the S1.5 diagnostic covered drift during the shadow phase and is now deleted. |
| Multi-tab data races on the global registry | High → Low | `BroadcastChannel` + storage-event merge + per-record `rev` + delete revisions (§3.10). |
| `<Show when={pty()} keyed>` anti-pattern survives the refactor | High | §3.8 invariant is non-negotiable. Slice 1 replaces the toggle with CSS overlay + AttachAddon swap. Test: `pane-terminal-rebind-doesnt-remount.perf.test.ts` gates Slice 3b merge. |
| Cold-start hydration race orphans existing PTYs | High → Low | One-shot reconciliation pass (§3.9), gated by `claxedo.terminals.reconciled.<dirChecksum>`. Tested in Slice 1. |
| Status drift from backend after slice deploys | Medium | Frontend `status` ∈ `"creating" \| "running"` is provisional on hydrate; backend probe within 500 ms reconciles. Backend exit ⇒ record deleted (no graveyard). |
| Persisted state wiped per schema-touching slice | Medium for maintainer | "Dump claxedo state" / "Reset claxedo state" diagnostic affordance ships in Slice 1. Each wipe is recoverable via clipboard JSON. Three rollout strategies documented in §4 (single bump / per-slice keys / dual-read); plan picks per-slice keys for clarity. |
| Move-across-canvas remounts xterm | Medium | Slice 7 invariant: `move-preserves-surface-id.test.ts` asserts `Terminal.open()` count == 1 across cross-group move. Drag/drop reducer reuses `Surface.id`. |
| OSC frame storms during typing | Medium | rAF-coalesced title writer (§3.8). Single shared scheduler in registry. Test in Slice 1. |
| Sidebar selector cost at 50+ terminals | Medium → Low | Two-layer memoization (§3.4.1). Focus changes do not invalidate inventory memo. Perf test in Slice 2. |
| Drag/drop UX regressions | Low | Drop-target enumeration in Slice 7; reject feedback for invalid targets. |
| Canvas reducer broad subscription regressions | Medium | `canvas-leaf-doesnt-rerender-on-sibling-change.test.ts` gates Slice 3a merge. `produce`-in-place reducer pattern. |
| `LocalPTY.id` ↔ `term_<ulid>` id formats coexist | Low | Documented invariant: registry mints opaque strings; existing PTYs keep their old ids; bookmarked URLs resolve via Slice 4 locate-only routing. |
| `pane-terminal-recovery.ts` reconnect tests not yet ported | Retired | The alias fallback and duplicate reconnect test file are deleted; terminal preview/log lookups no longer follow replacement ids. |

The largest residual risk is now ordinary regression risk in the terminal provider boundary: pending PTY creation moved out of `PaneTerminal` into `TerminalPtyController`, a non-visual controller mounted under `DirectoryScope` where `TerminalProvider` is available. `PaneTerminal` renders an existing PTY and reports observations through layout commands; registry/canvas mutations remain behind the dispatcher/facade boundary.

---

## 10. Recommended First Action

All product/design questions are resolved. Multi-tab safety timing (F) is resolved and shipped in Slice 1.

Slice 1 is now the largest single conceptually-novel piece: it introduces the per-directory registry, the §3.8 xterm render-stability rule, the §3.9 hydration reconciliation, the rAF-coalesced title writer, and the §3.10 multi-tab `BroadcastChannel` + `rev` machinery. Approximate sequencing inside the slice:

1. Type definitions (`TerminalRecord` with `rev`, persistence keys).
2. Registry slice in store + `Persist.workspace(dir, "claxedo.terminals.v1")`.
3. Hydrator + one-shot reconciliation against existing `terminal.v2`.
4. AttachAddon-swap rebind path; replace `<Show when={pty()} keyed>` with overlay in `pane-terminal.tsx`.
5. rAF-coalesced `runtimeTitle` writer.
6. Diagnostic dump/reset commands.
7. `BroadcastChannel("claxedo.store.v1")` + storage-event listener + `rev`-aware write path (done).
8. Tests (all listed in Slice 1 invariants).

Slice 1.5 shipped as a temporary equivalence diagnostic and has now been deleted during S3c cleanup.

Slice 2 (sidebar reads from registry) is small and well-contained once 1+1.5 are green.

Slice 3a is the largest dark-cutover step; reserve a sprint for 3a/3b/3c in sequence, with 3c focused on deleting the remaining legacy state adapters.

There are no remaining design decisions or open sequencing questions in this plan.
