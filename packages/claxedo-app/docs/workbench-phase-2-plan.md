# Phase 2 — Migrate to new Workbench (revised)

## Context

Phase 1 built `claxedo-ui/layout/` from scratch. Sealed, 82 tests passing.

Phase 2 goal: **every site that touches layout switches to the new Workbench.** No file outside `claxedo-ui/layout/` uses the old system when this phase completes. Phase 3 (deletion) is folded in.

After Phase 2:
- `grep -r "from.*context/claxedo-layout"` → zero matches.
- `grep -r "from.*components/multi-pane"` → zero matches.
- `grep -r "from.*claxedo-ui/workbench"` → zero matches.
- `grep -r "from.*claxedo-ui/surfaces"` → zero matches.
- `grep -r "useClaxedoLayout"` → zero matches.
- `bun run typecheck` clean.
- `bun run test` passing.
- `bun run dev` boots cleanly.

## The actual integration surface

Earlier draft of this plan listed 117 distinct `claxedo.foo.bar` patterns and a 10-wave migration. That number is misleading — **most of those callsites are inside files that get deleted, not migrated**.

The real integration surface is small and concentrated:

### Hot spots (the ~10 functions that genuinely flip API)

| # | What user does | File / function                                    | New API call                                         |
|---|----------------|----------------------------------------------------|------------------------------------------------------|
| 1 | Click session in sidebar | `rail-sidebar.tsx :: SessionRow.activate`     | `state.layout.openSession(dir, sid, title)` or `wb.navigation.show(id)` if already open |
| 2 | Click terminal in sidebar | `rail-sidebar.tsx :: TerminalRow.activate`   | `state.layout.openTerminal(dir, tid)` or `wb.navigation.show(id)`           |
| 3 | Drag-drop from sidebar/switcher onto pane edge | `rail-layout.tsx :: handleSurfaceDrop` | Set `application/x-workbench-content` on dragstart; Workbench's built-in drop handler does the rest |
| 4 | Click compact-switcher item | `rail-layout.tsx :: selectHeaderSurface`        | `wb.navigation.show(id)`                              |
| 5 | URL change → canvas | `route-intent.ts :: receive`                       | `wb.navigation.show(id)` (or `state.layout.openX` for first-time)    |
| 6 | Canvas focus change → URL | `ClaxedoLayout.tsx :: focused-pane effect`     | Wire to `<Workbench onFocusChange>`                   |
| 7 | Server `session.created` event | `batch-autotab.ts`                            | `state.layout.openSession(...)` (no auto-focus) |
| 8 | Server `pty.exited` / `agent.lifecycle` | `agent-status-listener.ts`            | Look up content via `state.meta.find`; update `state.terminal` slice |
| 9 | High-level "create new session" / "create new terminal" / etc. | `claxedo-layout-actions/*.ts` | Use `state.layout.openX` |
| 10 | Pane close + close-from-sidebar | `rail-layout-logic.tsx`, `rail-sidebar.tsx`     | `state.layout.closeContent(id)` or `wb.split.close(p, {destroyContent:true})` |

Drag/drop, pane resize, pane focus from clicking inside a pane, mount retention — **all handled inside `<Workbench>` itself** (Phase 1 already done).

That's ~5 files (rail-sidebar, rail-layout, route-intent, batch-autotab, agent-status-listener) plus the `claxedo-layout-actions/` directory. Everything else gets deleted, not migrated.

### What gets deleted (and why callsites in these files don't count)

| Path                                          | Reason                                                                  |
|-----------------------------------------------|-------------------------------------------------------------------------|
| `context/claxedo-layout/` (entire dir)        | Old store + facade. Replaced by `state/`.                              |
| `context/claxedo-layout.tsx`                  | Old provider. Replaced by `state/provider.tsx`.                        |
| `components/multi-pane/` (entire dir)         | Old pane render layer. Replaced by `<Workbench renderContent>`.       |
| `components/surface-content-renderer.tsx`     | Old per-pane content router. Replaced by `<Workbench>`.               |
| `components/retain-mounted-surfaces-policy.ts`| Old mount-retention workaround. Workbench handles it natively.        |
| `components/pane-chrome-provider.tsx`         | Old pane chrome context. Workbench provides `paneCtx`.                |
| `workbench/` (entire dir)                     | Old parallel "workbench" reflection store. Replaced by `state.meta`. |
| `surfaces/` (entire dir)                      | `surface-inventory.ts` etc. Replaced by `state` selectors.           |

These files contain ~80% of the 117 textual patterns. Deletion handles them; migration is the wrong frame.

### Tests

| Test file                                                          | Action                       |
|--------------------------------------------------------------------|------------------------------|
| `context/claxedo-layout/*.test.ts` (5+ files)                      | Delete with parent directory |
| `components/multi-pane/*.test.ts` (if any)                          | Delete with parent           |
| `components/surface-content-renderer.vitest.tsx`                    | Delete (component gone)      |
| `components/retain-mounted-surfaces-policy.test.ts` (if any)        | Delete                       |
| `surfaces/surface-inventory.test.ts`                                | Delete (file gone)           |
| `claxedo-layout-actions/*.test.ts` (4 files)                       | Migrate to new API; rewrite assertions |
| `claxedo-ui/layouts/rail-sidebar.integration.vitest.tsx`            | Rewrite (or `.skip` per-test) |
| `claxedo-ui/layouts/session-select-surface.test.ts`                 | Rewrite or delete             |
| `overrides/components/prompt-input/submit.test.ts`                  | Migrate                      |
| Tests in `claxedo-ui/layout/` (Phase 1)                             | Keep as-is                   |

---

## Architecture After Phase 2

```
claxedo-ui/state/                         (NEW: composition + persistence)
├── types.ts                              # ContentMeta + composed ClaxedoState
├── persistence.ts                        # validate/migrate v4→v5 + save
├── metadata.ts                           # meta CRUD
├── workspace.ts                          # paneWorktree, recency, color map
├── rail.ts                               # rail collapsed/pinned/etc.
├── workspace-panel.ts                    # right-side panel state
├── terminal.ts                           # terminalAgentStatus/Owner/Lifecycle/Seen
├── process-pane.ts                       # process pane toggle state
├── orchestration.ts                      # state.layout.openSession/openTerminal/closeContent/etc.
├── route-intent.ts                       # moved here, calls wb.navigation.show
├── batch-autotab.ts                      # moved here
├── agent-status-listener.ts              # moved here
├── provider.tsx                          # <ClaxedoStateProvider> + useClaxedoState()
└── index.ts                              # public exports

claxedo-ui/layout/                        (Phase 1, sealed; minor extensions if needed)
└── ... Workbench primitives only ...

claxedo-ui/content-renderers/             (NEW: one renderer per content type)
├── index.tsx                             # renderContent(id, ctx) dispatch on meta.type
├── session-content.tsx                   # wraps existing Session page
├── terminal-content.tsx                  # extracted from old multi-pane/pane-terminal.tsx
├── page-content.tsx
├── draft-session-content.tsx
├── context-content.tsx
├── process-content.tsx
├── overview-content.tsx
├── pages-index-content.tsx
└── workgraph-content.tsx
```

`useClaxedoState()` returns:
```ts
{
  wb: ReturnType<typeof useWorkbench>          // from claxedo-ui/layout
  meta: { get, set, find, findAll, patch, remove, all }
  terminal: { agentStatus, setAgentStatus, ids, owner, own, disown, seen, ... }
  workspace: { paneWorktree, recency, getColor, cleanupDeletedWorktree, ... }
  rail: { collapsed, pinned, hovered, locked, lock, unlock, toggle, ... }
  workspacePanel: { state, open, close, toggle, select, retarget }
  processPane: { isActive, requestOpen, requestToggle, setTargetDirectory, ... }
  layout: {
    openSession(dir, sid, title?, opts?)
    openTerminal(dir, tid, title?, opts?)
    openPage(pageId, title?, dir?, filePath?)
    openPagesIndex(dir?)
    openWorkgraph(dir?)
    openContext(dir, sid, title?)
    openProcess(dir)
    openOverview(targetDir, kind)
    closeContent(id)
    closePane(paneId, opts?)
    moveContent(id, fromPane, toPane)
    splitContent(targetPane, edge, id)
    showContent(id)             // alias for wb.navigation.show
  }
  ready: () => boolean
}
```

## Execution Order (single focused session)

### Step 1 — Build `state/` (additive, no callers yet)

Create the files in `claxedo-ui/state/`. Persistence migrator reads `claxedo.layout.v4` blob and produces the new shape: workbench state derived from old `groups[].surfaceId`, metadata derived from old `surfaces` registry, terminal slice from existing fields, etc.

Verify: `bun run typecheck` clean. Suite still passes (state/ not yet imported).

### Step 2 — Wire root provider

Replace `<ClaxedoLayoutProvider>` with `<ClaxedoStateProvider>` at the root. Inside, the new provider mounts `<WorkbenchProvider state={...} onChange={...}>`.

Verify: app boots in `bun run dev` (smoke test the dev server starts).

### Step 3 — Replace pane render layer

In `rail-layout.tsx`: replace the `<For each={visiblePanes}>...<SurfaceCanvasPane>...</SurfaceCanvasPane></For>` block with:

```tsx
<Workbench
  renderContent={(id, ctx) => <ContentRenderer id={id} ctx={ctx} />}
  renderEmpty={() => <EmptyWorkbenchPlaceholder />}
  onFocusChange={(paneId, contentId) => syncFocusToURL(paneId, contentId)}
  onPaneResize={(paneId, rect) => dispatchTerminalFit(paneId, rect)}
  onContentClose={(id, reason) => state.layout._cleanupOnClose(id, reason)}
/>
```

Build `claxedo-ui/content-renderers/` directory by extracting renderers from existing files:
- Move `components/multi-pane/pane-terminal.tsx` content → `content-renderers/terminal-content.tsx` (drop pane-tree concerns).
- Each other renderer wraps existing per-type components (Session page, PageEditor, DraftSessionPane, etc.).

Verify: typecheck (will now have many errors pointing at deleted imports). That's expected — Step 4 chases them.

### Step 4 — Migrate the integration hot spots

Each one is a small surgical change:

1. **`rail-sidebar.tsx`** — sidebar click + drag handlers. Replace `claxedo.workbench.show(id)` / `claxedo.split.selectSurface` etc. with the new API. Set `application/x-workbench-content` mime on dragstart.

2. **`rail-layout.tsx`** — already replaced render layer in Step 3. Migrate `selectHeaderSurface` (compact-switcher click) and `handleSurfaceDrop` (root-level drop handler — but most drops are now handled inside Workbench; only "drop new content from sidebar" needs adapter logic here).

3. **`rail-layout-logic.tsx`** — close-pane logic. `state.layout.closePane(...)` or `wb.split.close(...)`.

4. **`route-intent.ts`** — move to `state/route-intent.ts`. Use `wb.navigation.show(id)`.

5. **`batch-autotab.ts`** — move to `state/batch-autotab.ts`. Use `state.layout.openSession` / `openTerminal`.

6. **`agent-status-listener.ts`** — move to `state/agent-status-listener.ts`. Replace `claxedo.focusedSurfaces.orderedItems().find(...)` with `state.meta.find(...)`. Replace `claxedo.terminal.setAgentStatus` with `state.terminal.setAgentStatus`.

7. **`claxedo-layout-actions/*.tsx,*.ts`** — orchestration. Each high-level action (createSession, createWorkspace, etc.) uses `state.layout.openX` or `wb.navigation.show`. Tests get rewritten alongside.

8. **Override-side callers** (`overrides/components/dialog-select-file.tsx`, `prompt-input/submit.ts`, `pages/session.tsx`, etc.) — point-of-use changes; small.

9. **Demo + settings** (`demo/tour-controller.tsx`, `components/settings-terminals.tsx`) — small.

### Step 5 — Delete the old code

Once Step 4 is done and typecheck shows zero errors except inside the soon-to-be-deleted directories:

```
rm -rf packages/claxedo-app/src/claxedo-ui/context/claxedo-layout/
rm packages/claxedo-app/src/claxedo-ui/context/claxedo-layout.tsx
rm -rf packages/claxedo-app/src/claxedo-ui/components/multi-pane/
rm packages/claxedo-app/src/claxedo-ui/components/surface-content-renderer.tsx
rm packages/claxedo-app/src/claxedo-ui/components/surface-content-renderer.vitest.tsx
rm packages/claxedo-app/src/claxedo-ui/components/retain-mounted-surfaces-policy.ts
rm packages/claxedo-app/src/claxedo-ui/components/pane-chrome-provider.tsx
rm -rf packages/claxedo-app/src/claxedo-ui/workbench/
rm -rf packages/claxedo-app/src/claxedo-ui/surfaces/
```

Verify: `bun run typecheck` clean. Run typecheck after each `rm -rf` to confirm no orphaned references.

### Step 6 — Tests

Delete tests inside the removed directories. Migrate the surviving ones:
- `claxedo-layout-actions/*.test.ts` (4 files) — rewrite assertions for new state shape; many will become smaller because the actions are smaller.
- `layouts/rail-sidebar.integration.vitest.tsx` — rewrite or `.skip` per test (84 currently failing; many were broken pre-Phase-2 due to earlier work).
- `overrides/components/prompt-input/submit.test.ts` — migrate.
- `claxedo-ui/layouts/session-select-surface.test.ts` — rewrite or delete.

### Step 7 — Verify

- `cd packages/claxedo-app && bun run typecheck` — clean.
- `cd packages/claxedo-app && bun run test` — passes (existing 2063 + Phase 1's 82 + migrated; net no decrease).
- `grep -r "from.*context/claxedo-layout" packages/claxedo-app/src` — zero matches.
- `grep -r "from.*components/multi-pane" packages/claxedo-app/src` — zero matches.
- `grep -r "from.*claxedo-ui/workbench" packages/claxedo-app/src` — zero matches.
- `grep -r "from.*claxedo-ui/surfaces" packages/claxedo-app/src` — zero matches.
- `grep -r "useClaxedoLayout" packages/claxedo-app/src` — zero matches.
- `bun run dev` — boots cleanly; manual smoke test on journeys J1–J16.

## Risk Register

- **Persistence migration loses user state.** Mitigation: don't delete `claxedo.layout.v4` localStorage key on first run of v5; leave the v4 blob as a fallback (read-only). Document the rollback path. Test the migration with a sample real persisted blob.

- **Dev-server runtime error not caught by typecheck.** A reactive subscription in the new state slices reading a stale field. Mitigation: smoke-test in the browser at Steps 2, 3, 4. Browser console errors are the canary.

- **Old workbench's `contents` reflection had subtle behavior** (e.g., compact-switcher fed off it). Mitigation: the new `meta` map is the equivalent. The compact-switcher content list comes from `wb.selectors.recentContents()` joined with `state.meta`. Verify by clicking through the sidebar.

- **xterm buffer loss across migration.** The new `<Workbench>` keeps content mounted by default; terminal-content.tsx must be a stable component so xterm doesn't remount. Mitigation: extract terminal renderer cleanly from old `pane-terminal.tsx` without restructuring its internals.

- **Tests get noisy.** The 84 pre-existing failures in `rail-sidebar.integration.vitest.tsx` aren't a Phase 2 problem; don't conflate with new failures. Diff against the pre-Phase-2 baseline.

## Estimated Size

- Files created: ~22 (state/ + content-renderers/)
- Files migrated (touched but kept): ~12 (rail-*, claxedo-layout-actions/*, override callers)
- Files deleted: ~30 (claxedo-layout/, multi-pane/, workbench/, surfaces/, surface-content-renderer*, retain-mounted-*, pane-chrome-provider)
- Net file count change: negative (consolidation)
- Test files affected: ~15 (delete most; migrate a few)

Single focused session. The user reviews + commits at the end.
