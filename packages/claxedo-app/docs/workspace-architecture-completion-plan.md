# Workspace Architecture — Completion Plan

**Status:** Draft. Complements `workspace-architecture-plan.md`. Last updated 2026-04-27.
**Goal:** Close the remaining gaps between the master plan and the implementation, ratify the two places where reality is better than the plan, and deprecate the agent tab-context wire.

This plan assumes the master plan as prerequisite. Read §3.2, §3.6, §3.8, §3.9, §3.10, Slice 1, and Slice 8 of `workspace-architecture-plan.md` before this doc.

---

## Items in scope

| # | Item | Priority | Scope |
|---|---|---|---|
| 1 | Slim `SurfaceItem` to the §3.2 minimal `Surface` shape | P1 | Big — touches every reader |
| 2 | Per-directory registry persistence | P2 | Medium — swap persistence wire, add reconciliation gate |
| 3 | Delete tab-context-sync entirely (browser + gateway + MCP) | P2 | Small — full deprecation, no replacement |
| 4 | xterm rebind perf test (verify the §3.8 invariant) | P2 | Small — test only; fix only if it fails |
| 5 | Plan amendments (ratify reality on 3 points) | P1 | Doc-only |

## Items out of scope

- Restoring tab-context-sync as an "agent context publisher." Deprecated; MCP `tab_context` tool goes away. If a future agent feature needs surface metadata, design it fresh against the slim `Surface` shape, not the legacy snapshot.
- Renaming legacy facade aliases (`topTabs`, `groupTabs`). Cosmetic; defer.
- `AttachAddon` literal. Item 4's perf test verifies the *invariant*; the implementation can use any transport-swap mechanism.

---

## Sequencing

```
Item 5 (plan amendments)  ─►  align design before code
Item 4 (perf test)        ─►  surface real bugs cheaply, gates Item 1
Item 3 (delete sync wire) ─►  independent, low blast radius
Item 2 (per-dir persist)  ─►  schema bump, requires reset
Item 1 (slim SurfaceItem) ─►  largest, do last when foundation is stable
```

Why this order:
- **Item 5 first** so the plan stops contradicting the code. Every subsequent slice cites the amended doc.
- **Item 4 before Item 1** because if xterm remount is regressed, slimming `SurfaceItem` could mask the cause — fix-or-forget the invariant first.
- **Item 3 before Item 2** because tab-context-sync reads `SurfaceItem` fields; deleting the consumer first means Item 1 has fewer readers to update.
- **Item 2 before Item 1** because Item 2 bumps the persistence schema; pairing two schema bumps in one slice is fine, but separating them gives the maintainer a clean rollback per change.
- **Item 1 last** because it touches the most code and benefits from the rest being settled.

Each item is independently shippable. Each ends green.

---

## Item 5 — Plan amendments

Amend `workspace-architecture-plan.md` in three places. No code changes.

### Amendments

1. **§3.2 — Keep `process` as a `SurfaceType`.**
   Replace the paragraph that excludes process with:
   > A process is a long-running shell command — structurally a specialized terminal. Treating it as a `SurfaceType` lets it ride the canvas plumbing (split, drag, focus, close) for free. The `processPane` slice is retained only if the bottom-panel toggle UI is still wanted; otherwise deletable.

2. **§3.6 / §4.2 — Keep per-pane `worktree.pinned`.**
   The plan conflated two concepts:
   - "User pins workspace X in their sidebar list" → global preference (not implemented, may add as `sidebar.pinnedWorkspaceDirs[]` later if a feature requires it)
   - "Pane #N defaults to workspace X" → per-pane scoping (implemented as `PaneState.worktree`)

   Reality: the canvas supports multiple panes pointing at different workspaces; per-pane `worktree.{default, pinned}` is load-bearing. Keep it.

3. **§3.2 / §3.3 — Document `panes: PaneState[]` as the chrome side-table.**
   Add:
   > Per-pane chrome (`worktree`, layout flags) lives in `panes: PaneState[]`, a flat reactive collection keyed by pane id, joined to the recursive `canvas: CanvasState` tree by id. Tree owns *structure* (where splits are); side-table owns *attributes* (which workspace this pane targets, layout state). This is more SolidJS-idiomatic than forcing chrome onto recursive canvas nodes and avoids tree-walks for per-pane reads.
   >
   > **Invariant:** every `panes[i].id` corresponds to a leaf surfaceId in the canvas tree. When the canvas reducer removes a leaf, the matching `panes[]` entry is GC'd in the same mutation. (Verify and add a test.)

4. **Slice 8 — Replace contents.**
   The original Slice 8 cleanup list is partially done. Replace with:
   > Slice 8 is now this completion plan. See `workspace-architecture-completion-plan.md`.

### GC verification (one extra task)

Before merging the §3.3 amendment, verify that `panes[]` GC actually happens when canvas leaves disappear. Add `panes-gc-on-leaf-removal.test.ts`:

- Create canvas with 2 leaves → `panes` has 2 entries.
- Remove one leaf → `panes` has 1 entry.
- The remaining `panes[i].id` matches the surviving canvas leaf id.

If this test fails, the §3.3 amendment is invalid until the GC is added to the canvas reducer.

### Risk

Doc-only except for the GC test. If the GC test fails, fix the canvas reducer to emit pane-removal alongside leaf-removal in the same mutation.

---

## Item 4 — xterm rebind perf test

Add the test the master plan called for in §3.8 / Slice 1. Verifies that PTY rebinds don't remount xterm.

### Test

`packages/claxedo-app/src/claxedo-ui/components/surface/pane-terminal-rebind-doesnt-remount.perf.test.ts`

Pseudocode:
```ts
test("rebinding ptyId 10x does not remount xterm", async () => {
  const openSpy = vi.spyOn(Terminal.prototype, "open")
  // mount <PaneTerminal surfaceId="s1" terminalId="pty_a" />
  for (let i = 0; i < 10; i++) {
    setTerminalRecord("s1", { ptyId: `pty_${i}` })
    await waitTick()
  }
  expect(openSpy).toHaveBeenCalledTimes(1)
})
```

### Outcomes

- **Pass** → invariant holds. Update `workspace-architecture-plan.md` §3.8 to say *"transport rebind, not xterm remount"* in implementation-agnostic terms (drop the `AttachAddon` literal).
- **Fail** → the rebind path is destroying xterm. Fix in `pane-terminal.tsx`:
  - Identify the WebSocket / transport object the existing socket abstraction owns.
  - On `record.ptyId` change: detach old transport from xterm (unsubscribe `term.onData`, close old WS), open new transport, attach to same xterm instance.
  - Replace any `<Show keyed>` wrapper around the xterm mount with a CSS-toggled overlay over a permanent mount (per master plan §3.8).

### Risk

Test-only if it passes. Medium if it fails — touches `pane-terminal.tsx` reconnect path.

---

## Item 3 — Delete tab-context-sync entirely

Full deprecation. No replacement. Decision: agent-side surface introspection (`tab_context` MCP tool) is dropped until a concrete use case requires it; designing one against the legacy snapshot shape is wasted work given Item 1 changes the surface shape.

### Files to delete

**Browser:**
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-context-sync.ts`
- `packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/tab-context-sync.test.ts`

**Browser — wire removal:**
- `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx:40` — delete import
- `packages/claxedo-app/src/claxedo-ui/ClaxedoLayout.tsx:573-594` — delete `tabContextSync`, `tabContext` memo, the effect that calls `tabContextSync.push(...)`

**Demo:**
- `packages/claxedo-app/src/demo/handlers.ts:24` — drop `tabContext` field from demo state type
- `packages/claxedo-app/src/demo/handlers.ts:190` — drop `tabContext: {}` initializer
- `packages/claxedo-app/src/demo/handlers.ts:599-612` — delete the two `/api/claxedo/hook/tab-context` handlers

**Gateway (`packages/workspace-runtime/src/routes/agent-hook.ts`):**
- `tabContexts: Map<...>` (line 132) and the helpers around it (lines 162-208)
- The `.post("/tab-context", ...)` route (line 516)
- The `.get("/tab-context", ...)` route (line 526)
- Any `TabContextPayload` type definitions only used by the above
- Tests in this file's test suite that exercise tab-context

**MCP server (`packages/claxedo-server/src/claxedo-mcp/server.ts`):**
- The `tab_context` tool registration (lines 1127-1226)
- `tabContextPrompt` helper (line 167) — only used by `tab_context` tool
- Any `TabContextResponse`/`TabContext`/`TabPaneContext` types only used by the above
- Tests for the `tab_context` tool, if any

### Files to NOT delete

- **`CLAXEDO_TAB_ID` / `CLAXEDO_TERMINAL_ID` env var injection** in `overrides/context/terminal.tsx:450` and elsewhere. These are consumed by other MCP tools (`terminal_session`, `session_messages`, etc. in `claxedo-mcp/server.ts:573, 691, 794`) that don't depend on the tab-context endpoint. They identify "which terminal am I running in" and call non-deprecated endpoints.
- **The `tab-context` named pane in `generic-leaf-node.tsx:21`** — this is `TabContext` (a UI component for tab labels), unrelated to tab-context-sync. Different concept, same prefix.

### Verification

- `grep -rn "tab-context\|tabContext\|TabContextSnapshot\|tab_context" packages/` returns only the `TabContext` UI component import and tests for unrelated features.
- App still builds.
- Demo still runs.
- Other MCP tools (`terminal_session`, `session_messages`) still work — they should, since they never used the snapshot.

### Risk

Low. Intentional removal; no fallback; no users of this MCP tool that we know of.

---

## Item 2 — Per-directory registry persistence

Move `terminals: TerminalRegistryState` out of the global `claxedo.store.v1` blob and into per-directory `Persist.workspace(dir, "claxedo.terminals.v1")`, matching the master plan §3.6 / §4.1.0 / Slice 1 invariants.

### Why

- One write per terminal change rewrites only that directory's blob, not the global store.
- Cross-tab `BroadcastChannel` events become per-directory; reduces noise.
- Per-`(deploy, dir)` reconciliation gate becomes durable instead of in-memory.
- Matches the existing per-dir composition pattern in `overrides/context/global-sync/child-store.ts` (vcs, project, icon, session-cache).

### What changes

**Type:**
- `ClaxedoLayoutStore.terminals` stays as `Record<workspaceDir, TerminalRegistryWorkspaceState>`. Don't redesign the merge code in `terminal-registry.ts:154-225`; it already implements clean per-dir CRDT-style merge.

**Persistence:**
- Remove `terminals` from the `claxedo.store.v1` shape.
- For each directory hydrated by `workspaceRecency`, attach `Persist.workspace(dir, "claxedo.terminals.v1")` to `store.terminals[dir]` via `persisted(...)`. Eager: kick off all dirs in parallel at app start.
- Add a durable reconciliation flag in global storage: `claxedo.terminals.reconciled.<sha1(dir)>` (or similar). Once set, skip the §3.9 backend probe for that `(deploy, dir)`.

**UI gating:**
- `+ terminal` action and sidebar terminal list are disabled until `store.terminals[focusedDir].ready === true` AND the reconciliation gate is set.
- Existing `ready: boolean` field on `TerminalRegistryWorkspaceState` is sufficient; just wire it.

**Schema bump:**
- Bump global store key: `claxedo.store.v1` → `claxedo.store.v2`. Use `Persist.global("claxedo.store.v2", ["claxedo.store.v1"])` legacy-drain so the maintainer's per-dir terminals migrate cleanly (they're a hydration concern, not a global-blob concern; old global blob is dropped, per-dir keys are net-new).
- Maintainer's open terminals will be wiped *unless* the migration also reads `claxedo.store.v1.terminals[dir]` and seeds `Persist.workspace(dir, "claxedo.terminals.v1")` from it. **Add this seed step**: it's a one-shot during the v1→v2 drain. After this slice ships, the maintainer's terminals survive.

### Tests

- `terminal-registry-per-dir-hydration.test.ts` — hydrating dir A doesn't load dir B's terminals.
- `terminal-registry-reconciliation-once.test.ts` — reconciliation flag is set once per `(deploy, dir)`; subsequent reloads skip the probe.
- `terminal-registry-v1-to-v2-migration.test.ts` — old `claxedo.store.v1.terminals` seeds per-dir keys.
- `sidebar-disabled-until-ready.test.ts` — `+ terminal` action and sidebar list block until ready+reconciled.
- Existing tests in `terminal-registry.test.ts` keep passing.

### Risk

Medium. Schema bump means a wipe risk during the drain. Mitigated by the seed step, but still — verify the drain runs once and writes the per-dir keys before clearing the global blob's `terminals` field.

The "Dump Claxedo State" / "Reset Claxedo State" diagnostics from Slice 1 cover the worst case (recover from clipboard JSON).

---

## Item 1 — Slim `SurfaceItem` to minimal `Surface`

The biggest cleanup. Aligns `SurfaceItem` with the §3.2 minimal `Surface` shape. This is the single highest-leverage change in this plan.

### Target shape

`Surface` (renaming from `SurfaceItem` is optional; cosmetic):

```ts
type Surface =
  | { id: string; type: "terminal"; terminalRecordId: string; directory: string }
  | { id: string; type: "session"; sessionId: string; directory: string }
  | { id: string; type: "draft-session"; draftId: string; directory: string; draftPanel?: DraftSessionPanel; draftProjectId?: string; providerDirectory?: string }
  | { id: string; type: "page"; pageId: string; directory?: string; scope: "global" }
  | { id: string; type: "pages-index"; directory: string; scope: "global" }
  | { id: string; type: "workgraph"; directory: string; scope: "global" }
  | { id: string; type: "overview"; directory: string; targetDirectory?: string; overviewKind: OverviewKind; scope: "global" }
  | { id: string; type: "process"; processId: string; directory: string }  // §3.2 amendment: process is a SurfaceType
```

### Fields to remove from `SurfaceItem` (`types.ts:23-60`)

- `title` — resolve via selector. Terminal: `store.terminals[surface.directory].records[surface.terminalRecordId]?.title`. Session: upstream `globalSync.child(dir).session[surface.sessionId]?.title`. Page: page meta. Draft: composed.
- `closable` — derive from `type` and `pinned` rules in renderer (`isClosable(surface)`).
- `pinned` — derive from `type === "overview" || type === "pages-index" || ...` whatever the actual rule is.
- `loading` — move to per-kind status. Terminal: `store.terminals[dir].records[id].status === "creating"`. Session: upstream loading state.
- `attention` — derive from `terminalAgentStatus[ptyId] === "permission"` or session unread state.
- `done` — derive from session status / agent status.
- `badge` — derive from VCS sync state per session (`globalSync.child(dir).session[id].badge`).
- `scrollable` / `minPaneWidth` — move to a per-kind config map in the canvas renderer (`SURFACE_RENDER_CONFIG[type]`). Not surface identity.
- `terminalId` — collapse into `terminalRecordId`. The `pending-` prefix flow (creating a terminal before its PTY id is known) stays inside the registry: `record.id` is the surface's `terminalRecordId`, `record.ptyId` is the runtime field that may transition from undefined → bound.

### Fields to keep on `Surface`

- `id` — opaque surface identity, generated at creation.
- `type` — discriminator.
- `directory` — owner workspace (or `targetDirectory` for global-with-target like overview).
- Identity pointers: `terminalRecordId`, `sessionId`, `draftId`, `pageId`, `processId` — references to durable inventory items.
- `scope: "directory" | "global"` — already used; keep.
- Draft-specific fields (`draftPanel`, `draftProjectId`, `providerDirectory`) — these *are* the identity of a draft session; keep.
- `overviewKind` — part of overview surface identity.

### Where the work happens

This change ripples to every reader of `SurfaceItem.title`, `.closable`, `.pinned`, etc. Pre-survey the readers before slicing further:

```bash
grep -rn "\.title\|\.closable\|\.pinned\|\.loading\|\.attention\|\.done\|\.badge\|\.scrollable\|\.minPaneWidth" \
  packages/claxedo-app/src --include="*.ts" --include="*.tsx" | \
  grep -i "surface\|tab\|item"
```

Build a per-reader checklist. Common readers:
- Tab strip renderer (uses `title`, `closable`, `pinned`, `attention`, `done`, `loading`, `badge`)
- Sidebar inventory (already reads from registry for terminals; verify)
- Drag preview (`title`)
- Surface route (uses `type`, identity pointers — already minimal)
- `dynamic-title-sync` — already a no-op for terminals; delete the terminal branch entirely; drop the file if sessions/pages can also resolve via selector

### Selector module

New module: `packages/claxedo-app/src/claxedo-ui/canvas/surface-display.ts`

```ts
export function surfaceTitle(surface: Surface, ctx: { terminals: TerminalRegistryState; sessions: ... }): string { ... }
export function surfaceLoading(surface: Surface, ctx: ...): boolean { ... }
export function surfaceAttention(surface: Surface, ctx: ...): boolean { ... }
export function surfaceClosable(surface: Surface): boolean { ... }
export function surfacePinned(surface: Surface): boolean { ... }
export function surfaceBadge(surface: Surface, ctx: ...): Badge | undefined { ... }
```

Memoize at the call site (Solid `createMemo`) per visible surface. Cheap because surfaces are O(open tabs).

### Tests

- `surface-display.test.ts` — every selector, every surface type.
- `surface-roundtrip.test.ts` — persist + rehydrate a `Surface`; assert no removed fields snuck back in.
- `tab-strip-renders-from-selectors.test.ts` — render the tab strip with a fixture store; assert title/loading/attention/badge come from selectors, not `surface.title` etc.
- Existing tests get updated; many will simplify.

### Schema bump

- Bump `claxedo.store.v2` → `claxedo.store.v3`. Legacy drain reads old `SurfaceItem`s, strips the removed fields, writes minimal `Surface`s.
- Migration test: `surface-v2-to-v3-migration.test.ts` with fixtures of fat `SurfaceItem`s.

### Risk

High — touches many readers. Mitigated by:
- Item 4 verifying the xterm invariant first (so we can attribute regressions correctly).
- Item 3 having already removed one large reader (tab-context-sync built snapshots from `SurfaceItem` fields).
- Item 5 having already documented the target shape.
- Per-reader checklist before slicing.
- "Dump/Reset Claxedo State" diagnostics catch any stuck state.

---

## Cross-cutting concerns

### Persistence keys, in order

| Slice | Key state |
|---|---|
| Today | `claxedo.store.v1` |
| After Item 2 | `claxedo.store.v2` (without `terminals` field) + `claxedo.terminals.v1` per dir + `claxedo.terminals.reconciled.<dirChecksum>` flags |
| After Item 1 | `claxedo.store.v3` (slim `Surface`) + `claxedo.terminals.v1` (unchanged) |

Items 3, 4, 5 don't bump keys.

### Multi-tab safety (still §3.10)

Already shipped. `BroadcastChannel("claxedo.store.v1")` will need to update to `claxedo.store.v3` (or split per-key) as schemas bump. Verify per-record `rev` reconciliation still holds across the per-dir split in Item 2.

### Diagnostics

"Dump Claxedo State" / "Reset Claxedo State" already exist (`ClaxedoLayout.tsx:139-145`). Update them to enumerate the new key set after Items 1 and 2.

---

## Open questions

None. All five items are concrete. The only conditional is Item 4: if the perf test fails, the fix path is in `pane-terminal.tsx` and adds maybe a day of work.

---

## Acceptance criteria for "complete"

- [ ] Master plan amended (Item 5 done)
- [ ] xterm rebind perf test exists and passes (Item 4 done)
- [ ] No `tab-context-sync` references in any package; `tab_context` MCP tool removed (Item 3 done)
- [ ] `terminals` lives under `Persist.workspace(dir, ...)`; reconciliation gate is durable (Item 2 done)
- [ ] `SurfaceItem` carries only identity + type + pointers; all derived fields resolved via selectors (Item 1 done)
- [ ] All Slice 8 items in the master plan are either done or absorbed into the amendments here
