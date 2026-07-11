# WP-C3 — Touch-Capable Drag-and-Drop (Decision Note)

Date: 2026-07-11
Status: proposed (design gate for the WP-C3 DnD sub-worker; code blocked on this note)
Wave: 3 (Product-goal features)
Parent WP: WP-C3 · Responsive/mobile, LLD `2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md`
  lines 470–471 ("pointer-events-based (or library) touch-capable reorder/split
  replacing/augmenting native HTML5 DnD").
HLD basis: `2026-07-10-001-refactor-claxedo-app-oss-quality-hld.md` §P7 (lines 135–142) —
  "All pane/tab/session reordering uses native HTML5 drag-and-drop, which does not fire on
  touch devices at all."
Audit basis: `2026-07-10-003-claxedo-app-audit-findings-appendix.md` `responsive` section
  (the two `[critical]` findings, lines 1048–1053) and the `[medium]` a11y finding
  (lines 120–121, 155).
Acceptance bar: `packages/claxedo-app/e2e/playwright/mobile-smoke.spec.ts` behavior #4
  (`test.fixme` at line 251–267) — "multipane split and pane/tab/session drag-reorder have
  a touch equivalent". This note must make that fixme writable and greenable.
Companion note: `2026-07-11-004-wp-c3-workbench-collapse-design.md` (the narrow-viewport
  collapse mode). The two are independent but both land under WP-C3; collapse decides
  *what is visible* on narrow screens, this note decides *how reorder works* on touch.

All file:line citations below are against the **live working tree** (post-WP-ORG-2:
`claxedo-ui/layout/` → `claxedo-ui/workbench/`, PascalCase → kebab-case). Where the LLD or
audit prose says `layout/workbench.tsx` / `CompactSwitcher.tsx`, the live path is
`workbench/workbench.tsx` / `compact-switcher/compact-switcher.tsx`.

---

## 0. TL;DR of the decisions

1. **Approach: hand-rolled pointer-events controller, NOT a library.** No `solid-dnd` /
   `@thisbeyond/solid-dnd`. Evidence in §2.
2. **Replace native HTML5 DnD entirely, do not augment.** One pointer-driven input layer
   feeds mouse + touch + pen; a dual native-DnD-plus-pointer path is two systems to test
   and is exactly the duplication the audit flags. Evidence in §3.
3. **Preserve the existing payload + geometry contracts unchanged.** The
   `WORKBENCH_DRAG_MIME` contentId string, the typed `NavigationDragPayload`, `computeDropEdge`,
   the `DropTargetOverlay`, and `wb.split.split(...)` all survive. Only the *input* layer
   (what fires the drag and how the drop target is hit-tested) is rewritten. §4.
4. **Four source clusters, one controller.** Workbench pane handle, tab strip, sidebar
   `NavigationRow`, file-tree→prompt. The `NavigationRow` primitive is the single edit point
   for every sidebar row — the highest-leverage cluster. §1, §5.
5. **Effort: L total** (matches the LLD "L, may split into 3 workers by surface"), with the
   workbench cluster the only M–L; the rest are S. §5.

---

## 1. Inventory — every DnD call site (all reorder/split flows share ONE drop target)

The crucial structural finding: **the app has exactly one drop target that performs
reorder/split — the workbench pane.** The tab strip and the sidebar rows are *drag sources
only*; there is no reorder-within-list drop zone anywhere. "Tab reorder" and "session
reorder" both actually mean "drag this surface onto a pane to open/relocate/split it". This
collapses the design surface dramatically: one drop engine, four source adapters.

### Cluster 1 — Workbench pane split/relocate (the split engine; riskiest)

Payload/mime contract:
- `WORKBENCH_DRAG_MIME = "application/x-workbench-content"` — `workbench/types.ts:40`. Value
  carried = the workbench `contentId` (a string).

Drag source:
- Per-pane drag handle overlay `pane-handle-${pane.id}`: `draggable` at
  `workbench/workbench.tsx:569`, `onDragStart={(event) => handleDragStart(event, cid())}` at
  `:570`.
- `handleDragStart` — `workbench.tsx:312-316`: `dataTransfer.setData(WORKBENCH_DRAG_MIME, contentId)`,
  `effectAllowed = "move"`.

Drop targets (two, both on the pane):
- Pane chrome div: `onDragOver`/`onDrop`/`onDragLeave` JSX handlers at `workbench.tsx:367-371`.
- Content slot: **imperative** `addEventListener("dragover"/"drop"/"dragleave", …, true)`
  (capture phase) at `workbench.tsx:525-544`, cleaned up via `onCleanup` at `:539-543`. This
  capture-phase imperative wiring is the single trickiest thing to replace.

Drop logic:
- `onPaneDragOver` — `workbench.tsx:288-293`: filters on `dataTransfer.types.includes(WORKBENCH_DRAG_MIME)`,
  `preventDefault`, sets drop target with an edge.
- `dropEdgeForEvent` — `workbench.tsx:276-287`: walks up to the `data-pane-id` element,
  `getBoundingClientRect()`, calls `computeDropEdge`.
- `computeDropEdge` — `workbench/drag-drop.ts:4-22`: pure fn, pointer x/y → nearest edge
  (`left`/`right`/`top`/`bottom`).
- `onPaneDrop` — `workbench.tsx:294-310`: reads contentId, rejects unknown ids
  (`if (!s.contentIds.includes(cid)) return`, `:305`), then `wb.split.split(paneId, edge, cid)` (`:309`).

Visual feedback:
- `dropTarget` signal `workbench.tsx:204`; overlay rendered under `<Show when={dropTarget()}>`
  at `:615-625` (`data-testid="drop-target-${paneId}"`, `:618`).
- `DropTargetOverlay` — `workbench.tsx:631-648`: four edge zones (top/bottom/left/right at
  32%), highlighting the active edge.
- `dragSuppressed` signal (`:203`) + window `dragend`/`drop` listeners (`:214-219`) guard a
  suppressed-drag edge case.

### Cluster 2 — Tab strip (compact-switcher) — drag source only

- `canDrag(item)` — `compact-switcher/compact-switcher.tsx:136-138`: true for `session` |
  `terminal` items.
- `draggable={canDrag(item)}` at `:271`; the prefix button is `draggable={false}` at `:259`.
- `onDragStart` — `:277-282`: `dataTransfer.setData(WORKBENCH_DRAG_MIME, item.contentId)`,
  `effectAllowed = "move"`, then `props.onDragStart?.(item.contentId)`.
- `onDragEnd` — `:283`: `props.onDragEnd?.()`.
- Prop surface: `onDragStart?/onDragEnd?` — `:14-15`. **No drop handler in the strip** —
  the strip never reorders itself; the drop lands on a workbench pane.

### Cluster 3 — Sidebar navigation rows (`NavigationRow` primitive) — the leverage point

The shared row shell owns all sidebar drag wiring in ONE place:
- `navigation-row.tsx:51`: `ref={(el) => el.setAttribute("draggable", "true")}`.
- `navigation-row.tsx:60-76`: `onDragStart` seeds `WORKBENCH_DRAG_MIME` via
  `setWorkbenchDragMime(...)` (only when a live `contentId` resolves), then emits the typed
  `NavigationDragStart` (`{ event, row, payload, setWorkbenchDragData }`).
- `setWorkbenchDragMime` — `session-navigation.ts:111-118`: `setData(mime, contentId)` +
  `effectAllowed = "copy"` (note: `"copy"`, vs `"move"` in clusters 1/2).
- `navigationDragPayload` — `session-navigation.ts:106-109`: builds the typed
  `NavigationDragPayload` (`session` | `terminal`, `session-navigation.ts:50-52`).

Consumers (both just forward `onDragStart` — they do NOT reimplement drag wiring anymore;
the audit's line 217 duplication was already fixed into `NavigationRow`):
- Session rows: `session-navigation-list.tsx:60` (`<NavigationRow>`), `:76` (`onDragStart`).
- Terminal-surface rows: `terminal-surface-navigation.tsx:59` (`<NavigationRow>`), `:77`.

contentId seeding (side-effecting — opens content to get an id):
- `prepareSessionDrag` — `rail/rail-sidebar.tsx:1236-1244`: returns an existing content id or
  calls `claxedoState.layout.openSession(...)` to mint one, wired via
  `prepareSessionDragFromRows` (`:1260-1263`) at `:1786`, `:2083`, `:2326`.

Drop target: the workbench pane (Cluster 1). Sidebar drag = "drag a session/terminal into a
pane". No sidebar-internal reorder exists.

### Cluster 4 — File-tree → prompt input (cross-widget file attach — NOT reorder)

Distinct flow, distinct mime; listed for completeness because §P7 and the mobile-smoke
fixme name `file-tree.tsx`, but it is *not* pane/tab/session reorder:
- Drag source: `components/file-tree.tsx:135-140`: `draggable={local.draggable}`,
  `setData("text/plain", "file:" + path)` + `setData("text/uri-list", …)`, `effectAllowed = "copy"`;
  custom drag image at `:80-84` (`setDragImage`).
- Drop target: the prompt input global drop — `components/prompt-input/attachments.ts:143-182`:
  `handleGlobalDragOver`/`handleGlobalDrop` read `Files` / `text/plain` `file:` prefix and
  add attachments/mentions.
- The nested `draggable={false}` at `workspace-panel/workspace-files-navigator.tsx:280` and
  `compact-switcher.tsx:259` are opt-outs, not sources.

### Existing test surface (what the rewrite must keep green / convert)

- `workbench/tests/H-drag-drop.vitest.tsx`: synthesises `DragEvent` + a fake `DataTransfer`
  and dispatches `dragstart`/`dragover`/`drop`. Behavioural (asserts split geometry), so it
  survives if we keep `computeDropEdge`/`wb.split.split`; the *event synthesis* must migrate
  to pointer events.
- `navigation-row.vitest.tsx:63,81-83,110-112`: dispatches a synthetic `dragstart` and
  asserts the mime + typed payload are seeded. Same migration.
- `mobile-smoke.spec.ts:251-267`: the `test.fixme` this note unblocks.

---

## 2. Decision A vs B — hand-rolled pointer events vs a library

**Recommendation: (a) hand-rolled pointer-events controller.** A library is the wrong tool
here, for five concrete reasons:

1. **The hard cluster does not match any library's model.** `@thisbeyond/solid-dnd`'s value
   is its *sortable list* + *collision* abstraction. But the workbench has no sortable list —
   it has one droppable (a pane) whose drop *semantics are bespoke edge geometry*
   (`computeDropEdge`, `drag-drop.ts:4-22`, → split direction). A generic collision detector
   gives us nothing here; we would fight it to reproduce "nearest edge → split", and still
   hand-write the overlay. The library earns its bundle only on the trivial clusters.

2. **The codebase already owns the exact pointer-drag pattern — twice.** The workbench's own
   resize divider uses window `pointermove`/`pointerup` (`workbench.tsx:383-402`); the
   workspace-panel resize uses `setPointerCapture(event.pointerId)` +
   window `pointermove`/`pointerup` (`workspace-panel/workspace-panel.tsx:188-228`); the
   mermaid pan/zoom does the same (`components/page-editor/mermaid-block.ts:165-221`). A
   drag controller is the *same* primitive (pointerdown → threshold → move → up), so this is
   reuse of an established in-repo idiom, not new machinery.

3. **Dependency posture forbids a casual add.** Project memory records the repo is moving
   OFF heavy deps and vendors carefully, and `bunfig.toml` enforces
   `minimumReleaseAge = 259200` (3 days) with a hand-curated `minimumReleaseAgeExcludes`
   allowlist — every new dep is scrutinised. `solid-dnd` is single-maintainer and Solid-major
   specific; adding it for what is ~200 lines of pointer code we already have patterns for is
   a poor trade the reviewer will (correctly) push back on.

4. **Pointer events are strictly more testable than native DnD** — and testability *is* the
   WP-C3 gate. Playwright cannot drive HTML5 DnD (`dragTo` does not synthesise it reliably);
   the existing tests all hand-forge `DragEvent`s (§1). Playwright *natively* drives
   `page.mouse.move/down/up` and `page.touchscreen` + `dispatchEvent` pointer sequences. A
   pointer implementation is the only one where `mobile-smoke.spec.ts` behavior #4 becomes a
   real end-to-end assertion instead of another synthetic-event unit test.

5. **PointerEvent already unifies mouse + touch + pen** with universal support, so the
   library buys no cross-input coverage we don't get for free.

Cost we accept by hand-rolling: we lose native `setDragImage` (used only by file-tree,
`file-tree.tsx:80-84`) and must render a floating "drag ghost" ourselves (~20 lines, a
`position: fixed` element following `clientX/clientY`). Cheap and already implied by any
touch DnD.

---

## 3. Decision — replace native DnD entirely (do not augment)

Augmenting (keep `draggable`/`onDragStart` for desktop, add pointer for touch) is tempting
but rejected:
- It ships **two input systems** across five files, each needing its own tests — precisely
  the "a contributor fixing a drag bug in one won't know to fix the other" hazard the audit
  calls out (line 217) and that motivated the `NavigationRow` centralization in the first
  place.
- Pointer events already cover mouse, so the native path is pure redundancy on desktop.
- Coarse-pointer / hybrid (touchscreen laptop) devices get *both* handlers competing.

Replace. One `pointerdown` → movement-threshold → drag controller path for every device.
Desktop pixel-identical behaviour is preserved because the geometry, overlay, and reducer
are untouched (§4); only the trigger changes from "browser starts a native drag" to "our
controller starts one past a 4–6px / long-press threshold".

---

## 4. Compatibility strategy — what survives untouched

The rewrite is an **input-layer swap** behind stable contracts. Nothing below changes:

- `WORKBENCH_DRAG_MIME` string contract (`types.ts:40`) — kept as the *in-memory* payload key
  in the shared drag store (not a real `DataTransfer` anymore, but the same contentId string
  and the same "reject unknown ids" rule at `workbench.tsx:305`).
- `NavigationDragPayload` typed payload (`session-navigation.ts:50-52`) and
  `navigationDragPayload` (`:106-109`) — kept; `NavigationRow` emits the same typed object.
- `computeDropEdge` (`drag-drop.ts`) — kept verbatim; still the sole edge oracle.
- `DropTargetOverlay` + `dropTarget` signal (`workbench.tsx:204,615-648`) — kept; now driven
  by `pointermove` hit-testing (`document.elementFromPoint(x,y)` → nearest `[data-pane-id]`)
  instead of `dragover`.
- `wb.split.split(paneId, edge, cid)` reducer (`:309`) — kept; the commit path is identical.
- `H-drag-drop.vitest.tsx` split-geometry assertions and `navigation-row.vitest.tsx` payload
  assertions — kept behaviourally; only the event-synthesis helpers migrate from
  `DragEvent`+fake `DataTransfer` to pointer events + the shared store.

New shared module (the only genuinely new code):
- `workbench/pointer-drag.ts` — `createWorkbenchDrag()`: a small store holding
  `{ active, contentId, sourceKind, x, y }` + `start(contentId, pointerId, el)` /
  `move(x,y)` / `end()`; owns the ghost element and `setPointerCapture`. This is the single
  place mouse/touch/pen unify.
- A `useDragSource(el, () => contentId)` helper (Solid `ref` directive) applying
  `touch-action: none` (mandatory — otherwise the browser steals the gesture for scroll) and
  the pointerdown→threshold logic. Every source cluster adopts this one helper.

---

## 5. Implementation sketch + effort, per cluster

**Shared foundation (do first) — M.** `createWorkbenchDrag()` store + `useDragSource`
directive + ghost renderer + the `pointermove` → `elementFromPoint` → `data-pane-id` →
`computeDropEdge` hit-test used by the workbench. All other clusters are thin adapters onto
this. Threshold: 4–6px move for mouse; ~250ms long-press (or 8px) for touch to disambiguate
from scroll/tap inside scrollable containers (sidebar list, tab strip).

**Cluster 1 — Workbench (riskiest) — M–L.** Replace `draggable`+`onDragStart` on the pane
handle (`workbench.tsx:569-570`) with `useDragSource`. Replace the JSX `onDragOver/onDrop/
onDragLeave` (`:367-371`) and the imperative capture-phase slot listeners (`:525-544`) with a
single global `pointermove`/`pointerup` handler (active only while a drag is live) that
hit-tests panes and reuses `onPaneDragOver`/`onPaneDrop` logic minus the `DataTransfer`
plumbing. Retire `dragSuppressed` + the window `dragend`/`drop` guards (`:203,214-219`) —
pointer capture makes them unnecessary. Keep the overlay and edge math. This file is the
grandfathered risk; do it with the H-drag-drop vitest migrated first (red→green).

**Cluster 2 — Tab strip — S.** Swap `draggable`/`onDragStart`/`onDragEnd`
(`compact-switcher.tsx:271,277-283`) for `useDragSource` gated on `canDrag(item)` (`:136`).
Add `touch-action: none` to the title button. The strip is horizontally scrollable, so the
long-press threshold matters here. Emits contentId into the shared store; `props.onDragStart/
onDragEnd` semantics preserved for callers.

**Cluster 3 — Sidebar `NavigationRow` (leverage) — S.** Single edit point: replace the
`ref` `setAttribute("draggable","true")` (`navigation-row.tsx:51`) and the `onDragStart`
body (`:60-76`) with `useDragSource` + a pointerdown that calls `prepareContentId()`
(unchanged, `:68`) and emits the same typed `NavigationDragStart`. **Every session row and
terminal row inherits the fix with zero per-consumer changes** — the whole reason WP-A/ORG
centralised the shell. `prepareSessionDrag` side-effect (`rail-sidebar.tsx:1236-1244`) is
untouched.

**Cluster 4 — File-tree → prompt — S (recommend defer / scope-flag).** This is cross-widget
file attachment (mime `text/plain`+`text/uri-list`, drop target = the prompt input), not
pane/tab/session reorder, so it is arguably outside the P7 "reorder/split" mandate even
though the fixme lists `file-tree.tsx`. It also drops onto a *non-workbench* target, so it
cannot share the workbench drag store. Options: (i) give it its own tiny pointer path onto
the prompt drop zone, or (ii) leave native DnD for now and note that touch users use the
existing tap-to-open / attach-button path. Recommend (ii) for this WP and file a follow-up,
to keep the WP focused on the reorder engine. If included, ~S.

**Test conversion — S, but gate-critical.** Migrate `H-drag-drop.vitest.tsx` and
`navigation-row.vitest.tsx` event synthesis to pointer events; convert
`mobile-smoke.spec.ts:251-267` from `test.fixme` to an enforced Playwright touch test
(`page.touchscreen` long-press on a tab/row, `pointermove` across a pane, assert split via
`data-testid="drop-target-*"` then `data-testid="pane-*"` geometry). Per the goal doc
(`2026-07-10-005-goal-…md:98`), Wave-3 gate requires mobile fixmes converted to enforced +
green, vision-reviewed.

**Total: L** (matches LLD line 466). Workbench is the only M–L; everything else is S.

### Adjacent (do NOT silently fold in, but note)
The audit's `[medium]` a11y finding (lines 120–121, 155) wants a keyboard "move focused
content to adjacent pane" command, since relocation is drag-only. That is a *keyboard* gap,
orthogonal to touch, and overlaps WP-C2 (keyboard bindings). The pointer rework touches the
same handlers, so landing the keyboard command in the same PR is efficient — but it is a
distinct acceptance item and should be tracked as such, not smuggled under "touch DnD".

---

## 6. Open questions for the leader gate

1. Include Cluster 4 (file-tree→prompt) in this WP or split it out? (Recommendation: split.)
2. Long-press duration for touch drag-start — 250ms is the proposed default; confirm against
   the tab strip / sidebar scroll feel during vision review.
3. Keyboard "move to adjacent pane" (audit line 155): same PR or WP-C2? (Recommendation:
   same PR, separate acceptance line.)
