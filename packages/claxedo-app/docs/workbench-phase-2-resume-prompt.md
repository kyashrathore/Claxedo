# Resume Prompt — Workbench Phase 2 (PRs 2c-γ.3 finish → 2c-δ → 2c-ε → 2d)

Drop this entire file as the prompt for a fresh agent in a new session.

---

## You are continuing a major architectural refactor

The user is rebuilding the layout system in `packages/claxedo-app/`. A clean Workbench module was built from scratch in `claxedo-ui/layout/` (Phase 1). The migration to wire it everywhere and delete the old system is in progress (Phase 2). Significant work is already done; this prompt picks up mid-flight.

**You have full autonomous authority** to continue. The user is approaching usage limits and trusts the multi-PR sequencing. Don't over-clarify; do the work, report at the end.

## Read these files first (in order)

1. `/Users/yashvardhansingh/.claude/plans/fuzzy-stirring-aurora.md` — the Phase 2 master plan (mapping table, integration surface, what gets deleted).
2. `packages/claxedo-app/docs/workbench-phase-2-plan.md` — full execution doc.
3. `packages/claxedo-app/src/claxedo-ui/layout/index.ts` — the new Workbench public API surface (Phase 1, sealed).
4. `packages/claxedo-app/src/claxedo-ui/state/index.ts` and `state/provider.tsx` and `state/orchestration.ts` — the composition layer added in PR 2a/2b (the consumer-side state Workbench is wrapped in).
5. `packages/claxedo-app/src/claxedo-ui/content-renderers/index.tsx` and `content-renderers/bridge.tsx` — the bridge that's been the canvas safety net.

## Architecture decisions (already committed; do NOT relitigate)

- **Controlled component.** State lives in the consumer; Workbench takes `state` + `onChange`. Workbench exports pure reducers + `validate()`.
- **Hook-only access.** `<WorkbenchProvider>` + `useWorkbench()`. Wrapped in `<ClaxedoStateProvider>` + `useClaxedoState()` for consumer-side composition.
- **Mount retention non-negotiable.** xterm buffers, scroll positions survive every navigation. Workbench keeps content mounted by default; CSS hides inactive.
- **Recency in state** for tab-strip rendering.
- **Snapshots in `state.layoutSnapshots`.** Invalidated only on content removal (not layout-shape changes).
- **Dropped:** focus-mode (`split.toggle`/hidden), floating overlays, `processPane` slice (process is now just another `ContentMeta.type`), per-pane tab strips (one surface per pane).
- **Renamed:** Surface → PaneContent → in new state, `ContentMeta` (no `type` field on Workbench's PaneContent itself; type is on the consumer-owned `ContentMeta`). `worktree` removed from Pane.
- **No focus-mode = mod+\ split-toggle keybind is gone.** This was pre-approved by the user in Phase 0 spec design.
- **No compatibility shim.** No `useClaxedoLayout()` façade backed by new state. The two providers co-exist; callers migrate one at a time.
- **Dual-write was used in PR 2c-β** (claxedo-layout-actions/) to keep legacy chrome alive while canvas was being swapped. **Removal of dual-write happens as chrome migrates** in this resume work.

## Status — what's done

| PR | What it shipped |
|---|---|
| Phase 1 | `claxedo-ui/layout/` — sealed Workbench (31 files, 82 tests). |
| PR 2a | `claxedo-ui/state/` slices + `<ClaxedoStateProvider>` (additive, 13 files + 18 tests). |
| PR 2b | Root provider wired with v4→v5 persistence migrator (v4 retained as fallback). `claxedo-ui/content-renderers/` bridge directory (12 files). |
| PR 2c-α | `closeSurfaceLogic` migrated. Listener trio (`route-intent.ts`, `batch-autotab.ts`, `agent-status-listener.ts`) moved to `state/`, callers rewired in `ClaxedoLayout.tsx`. |
| PR 2c-β | `claxedo-layout-actions/*` (8 files) migrated to use `state.layout.*` and `state.meta.*`, with **dual-write to legacy** so chrome that hadn't migrated yet kept working. Tests rewritten alongside. |
| PR 2c-γ.1 | `buildSwitcherItemsFromState(state)` adapter in `compact-switcher/switcher-items.ts` (additive). `state.layout.openDraftSession(providerDirectory, draftId, opts?)` added to orchestration. `session-actions.tsx` updated to use it. |
| PR 2c-γ.2 | **Canvas swapped.** `rail-layout.tsx` 1756 → 1330 lines. `<For>...<SurfaceCanvasPane>` block replaced with `<Workbench renderContent={ContentRenderer}>`. One-way focus sync (new→legacy) wired so the unmigrated chrome still tracks focus. Dead helpers removed from rail-layout.tsx (`SurfaceCanvasPane`, `renderSplitNode`, `SplitTreeResizeHandle`, `SharedSurfaceDragDrop`, `SurfaceDropOverlay`, etc.). |
| PR 2c-γ.3 (PARTIAL) | Compact-switcher header migrated to `buildSwitcherItemsFromState`. `selectHeaderSurface` → `state.wb.navigation.show`. Sidebar `SessionRow.activate`/`TerminalRow.activate`/drag-source MIME migrated. `mod+\` (split-toggle) keybind deleted. `mod+alt+ArrowLeft/Right` rewired to new state. Deferred: `WorkspacePanelBody`, top-bar workspace/project selector reads, `mod+1..9` keybinds, URL-sync via `onFocusChange`, dual-write removal, `buildSidebarInventory` rewrite. |

## Status — what's pending (your work)

### PR 2c-γ.3 finish (partial → done)
The previous agent deferred ~6 chrome migrations because they cascaded. Finish them.

**γ.3.a — `WorkspacePanelBody` (lines ~382-527 of `rail-layout.tsx`).** Reads `claxedo.workbench.state().contents[target]` (legacy `PaneContent` shape with `kind`, `terminalId`, `sessionId`, `workspaceDir`) and `claxedo.select.multiPaneLeafView(target)`. Migrate to read `state.meta.get(target)` (new `ContentMeta` shape). The closest replacement for `multiPaneLeafView` is just the focused content of the targeted pane — Slice B has one surface per pane, no leaves. Cross-reference `pane-bus` comment-target logic if it routes through here.

**γ.3.b — Top-bar workspace selector / project selector reads.** `workspacePanelTargetForPane`, `focusedPaneWorkspaceDir`, `sidebarDir`. Read worktree from new state via `state.workspace.paneWorktree(p)` (returns `{default, pinned}`) and per-pane content directory via `state.meta.get(state.wb.state.panes.find(x=>x.id===p)?.contentId)?.directory`.

**γ.3.c — `mod+1..9` surface keybinds (~lines 690-727).** Currently uses `paneSurfaces.visualOrderedItems()` + per-pane scope filtering by pinned worktree. Decide one of:
- Map to "Nth content in `state.wb.selectors.recentContents()` filtered to focused pane's worktree" (closest semantic).
- Simplify: "Nth content in `recentContents()` overall."
- Drop: focus mode is gone; if these keybinds depended on it, remove.

Document your choice.

**γ.3.d — URL-sync route.** The legacy URL-sync effect in `ClaxedoLayout.tsx` reads `claxedo.split.focusedId()` and `claxedo.paneSurfaces(focusedId).active()`. Wire it to `<Workbench onFocusChange>` callback instead. After γ.3.a-c migrate the chrome that consumes legacy focus, the γ.2 new→legacy focus-sync effect can be removed.

**γ.3.e — `buildSidebarInventory` (in `claxedo-ui/sidebar/sidebar-inventory.ts`).** Currently reads from legacy `WorkbenchState`. Add a parallel `buildSidebarInventoryFromState(state)` reading new state, swap the caller in `rail-sidebar.tsx`. (Or replace in-place if there's only one caller.)

**γ.3.f — Remove dual-write from `claxedo-layout-actions/*`.** PR 2c-β added writes to BOTH new state and legacy registry. Now that γ.3.a-e migrate the chrome, the legacy writes are dead. Per-call removal is safer than wholesale: for each `props.claxedo.X.Y(...)` line in actions, check if any chrome still reads `X.Y` via legacy. If not, delete. If still yes (e.g., `claxedo.workspaceRecency`, `claxedo.workspacePanel.open`), leave it — that chrome migrates in a later PR.

After γ.3 finishes:
- `bun run typecheck` clean.
- `bun run test` no regressions vs **2085** baseline.
- `bun run dev` boots cleanly.
- **Smoke-test in browser:** click sidebar session, switch panes, drag-split, close pane, reload (verify v4→v5 persistence), top-bar selectors work, workspace panel shows correct content per pane.

### PR 2c-δ — Extract content-renderers off the bridge

Currently `claxedo-ui/content-renderers/{session,terminal,page,draft-session,context,process,overview,pages-index,workgraph}-content.tsx` all delegate to `<BridgedSurface>` → `<SurfacePaneContent>` (legacy multi-pane).

Extract each renderer to render directly without the bridge:

**δ.1 — `terminal-content.tsx` (do this FIRST, highest risk):** lift the xterm + PTY plumbing from `claxedo-ui/components/multi-pane/pane-terminal.tsx`. Drop pane-tree concerns. Keep xterm rebind perf invariant: terminal instance survives every prop/parent change short of explicit close. The new `terminal-content.tsx` reads `state.meta.get(id)` for terminalId/directory/title and integrates with `state.terminal.*` slice (agentStatus, replaceId, queueCreateForContent, etc.).

**δ.2 — `session-content.tsx`:** wrap `@/pages/session` (the upstream Session page). Pass directory/sessionId from `state.meta.get(id)` via SessionParamsProvider.

**δ.3 — `page-content.tsx`:** wrap `claxedo-ui/components/page-editor.tsx`.

**δ.4 — `draft-session-content.tsx`:** wrap `claxedo-ui/components/draft-session-pane.tsx`.

**δ.5 — `context-content.tsx`, `process-content.tsx`, `overview-content.tsx`, `pages-index-content.tsx`, `workgraph-content.tsx`:** wrap their existing content components.

After all 9 are direct: delete `content-renderers/bridge.tsx` and `content-renderers/bridged-surface.tsx`.

Verify each step incrementally:
- typecheck clean
- existing tests pass
- xterm scrollback preserved across pane switches (smoke-test)

### PR 2c-ε — Sweep remaining `useClaxedoLayout` callers

Remaining files that call `useClaxedoLayout()` or `useClaxedoLayoutOptional()` and weren't migrated yet (verify by `grep -rn "useClaxedoLayout\b" packages/claxedo-app/src --include="*.ts" --include="*.tsx"`):

**ε.1 — `claxedo-ui/components/`:**
- `file-tree-sidebar.tsx`
- `dialog-process-diagnostics.tsx`
- `page-editor.tsx`
- `draft-session-pane.tsx`
- `tab-overview.tsx`
- `tab-workgraph.tsx`
- `review-workspace.tsx`
- `pane-chrome-provider.tsx` (will be deleted in PR 2d but might still be imported by something during migration — flip and drop)

**ε.2 — `claxedo-ui/workspace-panel/`:**
- `comment-target.ts`
- `WorkspaceProcessesNavigator.tsx`

**ε.3 — `claxedo-ui/stores/`:**
- `process-ownership.ts`

**ε.4 — `claxedo-ui/context/`:**
- `process-pane.tsx` — old store; logic was lifted to `state/process-pane.ts` in PR 2a. Update remaining callers to use `state.processPane.*`. Delete the old file.
- `pane-id.tsx` — likely just an import-path change.

**ε.5 — `overrides/`:**
- `components/dialog-select-file.tsx`
- `components/prompt-input/submit.ts`
- `components/session-context-usage.tsx`
- `pages/session.tsx`
- `pages/session/session-layout.ts`
- `pages/session/use-session-commands.tsx`
- `pages/session/terminal-panel.tsx`

**ε.6 — Demo / settings:**
- `demo/tour-controller.tsx`
- `components/settings-terminals.tsx`

For each, replace `useClaxedoLayout()` with `useClaxedoState()` and update callsites per the mapping table in `packages/claxedo-app/docs/workbench-phase-2-plan.md`. Each file is small (handful of callsites typically).

After ε is done: `grep -rn "useClaxedoLayout\b" packages/claxedo-app/src` should return zero matches outside `state/` (where the old hook re-export may be left until PR 2d).

### PR 2c-ε tests

Migrate / rewrite / `.skip` tests in:
- `claxedo-ui/layouts/rail-layout.vitest.tsx` — 8 deliberately-stale tests that assert old canvas DOM (since γ.2). Rewrite to assert new Workbench DOM.
- `claxedo-ui/layouts/rail-sidebar.integration.vitest.tsx` — 84 pre-existing failures + post-migration regressions. Rewrite or `.skip` with TODO.
- `claxedo-ui/layouts/session-select-surface.test.ts` — rewrite or delete.
- `overrides/components/prompt-input/submit.test.ts` — migrate.
- Any test inside `context/claxedo-layout/` — delete (those files leave with PR 2d).
- Any test for files being deleted — delete.

### PR 2d — DELETE OLD CODE

Once everything above is done and `useClaxedoLayout` has zero callers:

```
cd packages/claxedo-app/src/claxedo-ui

rm -rf context/claxedo-layout/
rm context/claxedo-layout.tsx
rm context/route-intent.ts                  # superseded by state/route-intent.ts (PR 2c-α)
rm context/batch-autotab.ts                 # superseded by state/batch-autotab.ts (PR 2c-α)
rm context/agent-status-listener.ts         # superseded by state/agent-status-listener.ts (PR 2c-α)
rm context/process-pane.tsx                 # superseded by state/process-pane.ts (PR 2a)
rm -rf components/multi-pane/
rm components/surface-content-renderer.tsx
rm components/surface-content-renderer.vitest.tsx
rm components/retain-mounted-surfaces-policy.ts
rm components/pane-chrome-provider.tsx
rm -rf workbench/
rm -rf surfaces/
```

Plus any test files that imported deleted modules — delete them too.

Also remove `<ClaxedoLayoutProvider>` mount from the app shell (probably `claxedo-ui/index.tsx` and `ClaxedoLayout.tsx`). Only `<ClaxedoStateProvider>` should remain.

Drop the `props.claxedo` argument from `ActionProps` in `claxedo-layout-actions/shared.ts` and update the callers.

Drop the new→legacy focus-sync effect added in PR 2c-γ.2.

After deletion, every `grep` listed in the verification section below must return zero matches.

### Verification (final)

End-to-end after PR 2d:

```
cd packages/claxedo-app
bun run typecheck                                   # clean
bun run test                                        # passing (≥ baseline; deleted-test count vs migrated-test count balance documented)

grep -rn "from.*context/claxedo-layout" src/         # zero matches
grep -rn "from.*components/multi-pane" src/          # zero matches
grep -rn "from.*claxedo-ui/workbench" src/           # zero matches
grep -rn "from.*claxedo-ui/surfaces" src/            # zero matches
grep -rn "from.*surface-content-renderer" src/       # zero matches
grep -rn "useClaxedoLayout\b" src/                   # zero matches
grep -rn "<ClaxedoLayoutProvider" src/               # zero matches

bun run dev                                          # boots cleanly with no console errors
```

**Browser smoke test journeys** (J1–J16 from `/Users/yashvardhansingh/.claude/plans/fuzzy-stirring-aurora.md`):
1. Empty start → click session A → see it in pane.
2. Refresh → session A still in pane (persistence).
3. Drop session B side-by-side with A → split.
4. Navigate to session C → side-by-side becomes single pane C; A and B still mounted (hidden).
5. Click A in switcher → restores side-by-side; xterm scrollback intact.
6. Create terminal A → opens.
7. Create terminal B → opens.
8. Drag terminal A from switcher next to terminal B → splits.
9. Reload → terminals side-by-side persists.
10. Navigate to session D → side-by-side terminals saved as snapshot; single pane D.
11. Navigate to terminal A → restores side-by-side terminals.
12. Click pane rendering term-b → focus follows.
13. Close pane rendering term-b → term-b destroyed; focus moves to term-a.
14. Create terminal C next to terminal A → splits.
15. Close terminal C from sidebar → pane removed.
16. Click in compact switcher → switches.

## Mapping table cheat-sheet

| Old | New |
|---|---|
| `useClaxedoLayout()` | `useClaxedoState()` |
| `claxedo.split.focusedId()` | `state.wb.state.focusedPaneId` |
| `claxedo.split.groups()` | `state.wb.state.panes` |
| `claxedo.split.orderedGroups()` | `state.wb.selectors.visiblePanes()` |
| `claxedo.split.setFocus(p)` | `state.wb.split.focus(p)` |
| `claxedo.split.toggle()` | DROPPED |
| `claxedo.paneSurfaces(p).activeId()` | `state.wb.state.panes.find(x=>x.id===p)?.contentId ?? null` |
| `claxedo.paneSurfaces(p).active()` | `state.meta.get(state.wb.state.panes.find(x=>x.id===p)?.contentId)` |
| `claxedo.paneSurfaces(p).items()` | `[state.meta.get(state.wb.state.panes.find(x=>x.id===p)?.contentId)].filter(Boolean)` |
| `claxedo.paneSurfaces(p).visualOrderedItems()` | `state.wb.selectors.recentContents().map(state.meta.get).filter(Boolean)` |
| `claxedo.paneSurfaces(p).addSession(...)` | `state.layout.openSession(...)` (with `paneId` opt) |
| `claxedo.paneSurfaces(p).addTerminal(...)` | `state.layout.openTerminal(...)` |
| `claxedo.paneSurfaces(p).close(id)` | `state.layout.closeContent(id)` |
| `claxedo.focusedSurfaces.X` | Same as `paneSurfaces(focusedPaneId).X`; many reads consolidate to `state.wb.selectors.recentContents()` aggregator |
| `claxedo.workbench.show(id)` | `state.wb.navigation.show(id)` (state-only; URL writing rides `<Workbench onFocusChange>`) |
| `claxedo.workbench.state().contents[id]` | `state.meta.get(id)` (kind derived from `meta.type`) |
| `claxedo.findSurfacePane(id)` | `state.wb.selectors.contentPane(id)` |
| `claxedo.hasSurface(id)` | `state.wb.state.contentIds.includes(id)` |
| `claxedo.findSurfaceWhere(pred)` | `state.meta.find(pred)` |
| `claxedo.navigateToSurface(id)` | `state.wb.navigation.show(id)` |
| `claxedo.patchSurface(id, patch)` | `state.meta.patch(id, patch)` |
| `claxedo.patchSurfaceTitle(id, title)` | `state.meta.patch(id, { title })` |
| `claxedo.terminal.X` | `state.terminal.X` |
| `claxedo.processPane.X` | `state.processPane.X` |
| `claxedo.multiPane.getContent(id)` | `state.meta.get(id)?.content` |
| `claxedo.multiPane.setContent(id, content)` | `state.meta.patch(id, { content })` |
| `claxedo.multiPane.has(id)` | `state.wb.state.contentIds.includes(id)` |
| `claxedo.multiPane.initTabWithContent(id, content)` | `state.meta.patch(id, { content }); state.wb.contents.add(id)` |
| `claxedo.dispatch({...})` | direct reducer / `state.layout.*` call |
| `claxedo.select.paneActiveSurface(p)` | `state.meta.get(state.wb.state.panes.find(x=>x.id===p)?.contentId)` |
| `claxedo.select.visiblePanes()` | `state.wb.selectors.visiblePanes()` |
| `claxedo.select.multiPaneLeafView(id)` | DROPPED (single-leaf model) |
| `claxedo.paneWorktree(p).default/.pinned` | `state.workspace.paneWorktree(p)` returns `{default, pinned}` |
| `claxedo.paneWorktree(p).setDefault(d)` | `state.workspace.setPaneWorktreeDefault(p, d)` |
| `claxedo.workspaceRecency.X` | `state.workspace.recency.X` (verify exact method names in `state/workspace.ts`) |
| `claxedo.rail.X` | `state.rail.X` |
| `claxedo.workspacePanel.X` | `state.workspacePanel.X` |
| `claxedo.surfaceTypes.register(t, hooks)` | DROPPED (lifecycle hard-coded in `state/orchestration.ts`'s `closeContent` per-type cleanup) |
| `claxedo.cleanupDeletedWorktree(dir)` | `state.workspace.cleanupDeletedWorktree(dir)` |

## Working principles

- **Verify after every step.** `bun run typecheck` + `bun run test` after each PR/sub-PR.
- **Smoke test in browser** when migrating chrome (γ.3) and content-renderers (δ). Don't rely solely on tests.
- **The bridge is your safety net during δ.** Each renderer can land independently behind the bridge.
- **xterm preservation is the trickiest invariant.** The Workbench keeps content mounted by default. The component itself must not remount on prop changes. Don't restructure xterm internals — lift cleanly from `pane-terminal.tsx`.
- **Persistence migration (v4→v5) is wired in PR 2b.** Don't change it; just verify it still works after each major step. v4 localStorage blob is preserved as fallback for rollback.
- **Don't commit.** The user reviews before committing.

## Reporting protocol

After each sub-PR:
- Files created / modified / deleted
- Lines of code (rough)
- Test count delta from baseline (currently 2085 pass / 0 fail / 10 skip)
- Spec ambiguities resolved
- Smoke-test outcomes (which user actions verified, which deferred)
- Anything deferred to next sub-PR with rationale

If a sub-PR's verification fails and you can't see how to fix without violating scope, **stop and report.** Don't paper over.

## Sub-PR sequence

1. **PR 2c-γ.3 finish** (γ.3.a–γ.3.f from above)
2. **PR 2c-δ** (extract 9 content-renderers off bridge, delete bridge)
3. **PR 2c-ε** (sweep remaining `useClaxedoLayout` callers + tests)
4. **PR 2d** (delete old code; final verification)

You decide whether to do them in one session or report between each. Default: report between each so the user can review.

Begin with PR 2c-γ.3 finish.
