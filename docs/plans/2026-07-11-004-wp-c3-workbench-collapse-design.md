# WP-C3 — Narrow-Viewport Workbench Collapse Mode (Design Note)

Date: 2026-07-11
Status: proposed (design gate for WP-C3 collapse sub-worker; code blocked on this note)
Wave: 3 (Product-goal features)
Parent WP: WP-C3 · Responsive/mobile, LLD `2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md`
  lines 466–476 ("narrow-viewport workbench collapse mode (single-pane + switcher —
  design note required before code)").
Audit basis: `2026-07-10-003-claxedo-app-audit-findings-appendix.md` `responsive` section,
  esp. the two `[critical]` findings (lines 1048–1053) and refactor step "[L] Add a
  narrow-viewport collapse mode to Workbench" (lines 1094–1095).
Acceptance bar: `packages/claxedo-app/e2e/playwright/mobile-smoke.spec.ts` — this note
  maps each of its four documented behaviors (2 green, 2 `test.fixme`) to a design decision.

> **Live-tree note (read before citing the LLD/audit prose).** WP-ORG-2 has already landed
> in the working tree: `claxedo-ui/layout/` → `claxedo-ui/workbench/`, `claxedo-ui/layouts/`
> → `claxedo-ui/rail/`, and the PascalCase files are kebab-cased. Every path in the LLD and
> audit that says `layout/workbench.tsx`, `layouts/rail-workbench-*.tsx`,
> `workspace-panel/WorkspacePanel.tsx`, `compact-switcher/CompactSwitcher.tsx`,
> `claxedo-layout.css`, or `tab-page.css` resolves in the live tree to
> `workbench/workbench.tsx`, `rail/rail-workbench-*.tsx`,
> `workspace-panel/workspace-panel.tsx`, `compact-switcher/compact-switcher.tsx`,
> `app-shell.css`, and `components/page-editor/page-editor.css` respectively. All
> file:line citations below are against the **live tree**.

---

## 0. TL;DR of the decisions

1. **Collapse model:** below the breakpoint, the workbench renders exactly one pane
   full-bleed (the focused pane) and hides all others. Splits are **preserved-but-hidden**,
   never flattened; re-widening restores the exact prior split geometry with zero user
   action. This falls out for free from decision 4.
2. **Switcher affordance:** reuse the existing **compact-switcher** tab strip
   (`compact-switcher/compact-switcher.tsx`, already rendered in the workbench top bar via
   `rail/workbench-shell-header.tsx`). No new bottom bar. In collapsed mode it is the
   pane/surface switcher; its selection path already re-focuses surfaces, which re-projects
   the single visible pane.
3. **Mobile sidebar drawer:** make the *already-wired-but-unreachable* drawer **live** by
   adding an `openMobileSidebar` setter and routing the workbench header's existing "show
   sidebar" button to it when narrow. This flips mobile-smoke behavior 1. The auto-opening
   workspace review panel is **suppressed at narrow boot** via a guard in `route-intent.ts`,
   removing the spec's `closeWorkspacePanelIfOpen` workaround.
4. **State model:** collapse is a **pure VIEW-layer projection** over unchanged
   `WorkbenchState`. No reducer, no `types.ts`, no persistence change. Exact touch points
   enumerated in §4.
5. **Breakpoint:** one token, `--bp-md` / `BP_MD = 768` (Tailwind `md`), matching the point
   at which the rail sidebar already becomes a drawer (`app-shell.css` `max-md` rules). The
   workbench measures its **own canvas width**, not `window.innerWidth`.
6. **Keyboard/touch parity:** switcher selection is click/tap + focusable `<button>`s
   (already); arrow-key pane focus doubles as next/prev-pane switching in collapsed mode.
7. **Testability:** pure projection helper → vitest; collapsed DOM rendering → `.vitest.tsx`
   (jsdom); the collapse behavior + drawer + no-auto-open → mobile Playwright (flips
   behaviors 1 and the collapse half of 4; 2 and 3 stay green).

---

## 1. The collapse model — what happens to panes and splits

### 1.1 Boundary

The workbench enters **collapsed (single-pane) mode** when its own measured canvas width is
below the breakpoint (§5). "Its own width" = the `containerSize()` signal that
`workbench.tsx` already maintains from a `ResizeObserver` on `rootEl`
(`workbench/workbench.tsx:51–66`). This is deliberately **not** `window.innerWidth`, because
the workbench column is inset by the workspace-panel margin
(`rail/rail-workbench-shell.tsx:65`, `margin-right: workspacePanelWidth`) and, on desktop,
by the pinned rail. Measuring the canvas means collapse triggers on the space actually
available to panes, and it composes correctly with the panel/rail without extra plumbing.

### 1.2 What renders

- **Collapsed:** exactly one pane is laid out at `{top:0,left:0,width:1,height:1}` (full
  bleed). Which pane: the **focused pane** (`state.focusedPaneId`), falling back to the
  first pane when focus is null but panes exist. All other panes are `display:none` (their
  content stays mounted — see §1.4).
- **Expanded:** unchanged — `computePaneRects(state.split.root)` drives the absolute
  percentage rects exactly as today (`workbench/workbench.tsx:107`, `225`, `476`).

### 1.3 Splits are PRESERVED, not flattened (and re-widen restores)

Because collapse is a pure projection (§4), `state.split`, `state.panes`, and
`state.focusedPaneId` are **untouched** when entering/leaving collapsed mode. Consequences:

- Re-widening past the breakpoint (rotate, resize, undock) re-renders the original 2-/3-way
  split with **no state write and no reconstruction** — `computePaneRects` simply resumes
  driving the rects.
- The persisted layout (`claxedo.state.v5`, `state/provider.tsx:34`, persisted through
  `sameWorkbenchState` at `state/provider.tsx:81`) is identical on a phone and on a desktop
  reopening the same session; a mobile session never silently discards a user's desktop
  split.

**Why not flatten** (i.e. collapse the split tree to a single pane in state on entry):
1. It is *lossy* — the split arrangement is destroyed and must be heuristically rebuilt on
   re-widen, which is exactly the kind of irreversible geometry churn this refactor is
   trying to remove.
2. It writes to the persisted `WorkbenchState` on a viewport change, so a resize/rotate loop
   thrashes `localStorage` (the debounced persist at `state/provider.tsx:162`) and a
   desktop user who ever loaded the app narrow loses their split permanently.
3. It couples a *presentation* concern (viewport width) to the *domain* reducer, violating
   the workbench's own controlled-state contract (`workbench/provider.tsx` — state lives in
   the consumer, the component only projects it).

Projection gives preserved-but-hidden **for free** and is strictly safer, so it is the
decision. There is no scenario in scope where flatten is preferable.

### 1.4 Mounting is unchanged

Hidden panes keep their content mounted: `aliveForRender()` and the mount-retention policy
(`workbench/workbench.tsx:249–273`, `maxMountedContents={12}` from
`rail/rail-workbench-canvas.tsx:39`) are untouched. A collapsed-away terminal or session is
still live in the DOM (just `display:none`), so switching to it is instant and preserves
scrollback/state. The only per-pane visual change is the rect each slot is given.

---

## 2. Switcher affordance for hidden panes/tabs

**Decision: reuse the compact-switcher; do not add a bottom bar.**

The compact-switcher (`compact-switcher/compact-switcher.tsx`) is already the workbench's
tab strip: a `<nav data-testid="compact-switcher">` (line 220) of real `<button>` tabs, one
per surface, horizontally scrollable (`overflow-x-auto`, line 221), rendered in the top bar
by `rail/workbench-shell-header.tsx` (import line 3) whenever `projectsCount() > 0`
(`rail/rail-workbench-shell.tsx:68`). It is present and identical on desktop and mobile.

Why it is the right collapse switcher:

- It already **lists every surface**, including ones bound to currently-hidden panes and
  fully-stashed surfaces — exactly the set a single-pane user needs to reach.
- Its `select()` path (`compact-switcher.tsx:192–206`) commits a surface selection that
  re-focuses/re-shows that surface. Because our projection keys the single visible pane off
  `state.focusedPaneId`, **selecting a tab that lives in a different pane changes the focus
  and the projection swaps the visible pane automatically** — no new selection logic needed.
- Its tab buttons carry `aria-label` (`compact-switcher.tsx:257,268`) and therefore receive
  the 40×40 touch-target floor from `app-shell.css:34–54` under `(pointer: coarse)`. It is
  already touch-tap usable.

What the collapse worker does **not** need from the switcher: its **drag reorder**
(`draggable` at `compact-switcher.tsx:271`, `canDrag` line 136) is touch-broken, but that is
behavior 4's *DnD* half and belongs to the sibling C3 touch-DnD worker (§8). Collapse relies
only on tap-to-select, which works.

Minor polish left as an open question (§8): on a very narrow top bar the switcher shares
horizontal space with the new/settings/panel controls; if it proves cramped in the mobile
Playwright run, promote it to its own full-width row under the top bar at `<md`. This is a
CSS-only change in `rail/workbench-shell-header.tsx` and does not affect the state model.

---

## 3. Interaction with the mobile sidebar drawer and the auto-opening workspace panel

### 3.1 The drawer is wired but has no opener (make it live)

The mobile drawer chrome fully exists in `rail/rail-sidebar-shell.tsx`:
- scrim `<Show when={props.mobileSidebarOpen()}>` (line 99),
- slide transform `${mobileSidebarOpen() ? "max-md:translate-x-0" : "max-md:-translate-x-full"}`
  (line 114),
- and `closeMobileSidebar()` is already called from every nav action inside it
  (lines 134–181: workspace/session/new/settings/help select all close the drawer).

The **only** missing piece is a way to set it open. `rail/rail-shell-chrome-state.ts`
exposes `mobileSidebarOpen` (signal, line 18) and `closeMobileSidebar` (line 61) — and
`closeMobileSidebar` is the *only* setter, hard-wired to `setMobileSidebarOpen(false)`.
Nothing anywhere sets it `true`. This is precisely the dead-code state pinned by
mobile-smoke behavior 1 (`mobile-smoke.spec.ts:185–196`) and the identical citation in
`core-sidebar-tree.spec.ts:947`.

**Fix (small, outside `workbench/` — see ownership caveat §8):**
1. In `rail/rail-shell-chrome-state.ts`, add `openMobileSidebar: () => setMobileSidebarOpen(true)`
   (and optionally `toggleMobileSidebar`) to the returned object (line 58–62).
2. The workbench top bar already has a "show sidebar" affordance:
   `WorkbenchShellHeader` `onShowSidebar` → `app-shell-layout.tsx:341` currently wires it to
   `toggleSidebar` (→ `shellLayout.toggleRail()`, `app-shell-layout.tsx:251`). Change that
   wiring so that **when narrow** it calls `chrome.openMobileSidebar()` and otherwise keeps
   `toggleRail()`. The narrow test is the same `BP_MD` predicate (§5).

This makes the drawer reachable on a phone (open via header button, scrim/nav-select to
close) and flips behavior 1 from `test.fixme` to a real assertion (§7). It belongs in this
WP conceptually because "single-pane + switcher" narrow mode is unusable without a way to
reach project/session navigation, and the drawer is that way — but it edits chrome/rail
files, so it is called out as a coordination item in §8, not silently absorbed.

### 3.2 The auto-opening workspace review panel covers the whole phone screen

`route-intent.ts:508–519`: when a bare `/:dir/session` boot resolves to `workspaceBrowse`
with no `sessionId`/`pageId`/`terminalId`, it unconditionally calls
`state.workspacePanel.open("review", { workspaceDir })`. On desktop the panel is ~70% width
(`workspace-panel.tsx:34`) and harmless. At `<640` the panel forces `width:"100%"`
(`workspace-panel.tsx:31` `isMobile()`, `:105` `panelStyleWidth()`), so it covers the entire
screen — including the draft composer — with no user action. mobile-smoke documents this at
`mobile-smoke.spec.ts:121–142` and works around it with `closeWorkspacePanelIfOpen`.

**Decision: suppress the auto-open at narrow boot** rather than paper over it. Add a
narrow-viewport guard to the `workspaceBrowse` branch at `route-intent.ts:508` so it does
**not** auto-open the review panel when the shell is in collapsed mode; the draft composer
becomes the boot surface (the desktop-side-by-side rationale for the auto-open does not
exist at phone width). This:
- removes the need for the spec's `closeWorkspacePanelIfOpen` helper and lets the mobile
  Playwright suite assert the panel is *not* auto-open at narrow boot (§7),
- keeps the desktop behavior byte-for-byte identical.

This is the **one logic change outside pure projection** in the whole design, and it is a
guard, not a rewrite. Caveat: `route-intent.ts` runs as non-reactive imperative resolution,
so the narrow predicate there must read width directly (`window.innerWidth < BP_MD`) or be
handed a capability from the caller — flagged as an open question (§8, Q3) because plumbing
a reactive signal into route-intent is heavier than the guard itself.

### 3.3 Relationship between the drawer and the collapsed workbench

They are orthogonal surfaces at `<md`: the **drawer** (left, `z-[100]`,
`rail-sidebar-shell.tsx:112`) is project/session navigation; the **collapsed workbench**
(single pane + top-bar switcher) is the active work surface; the **workspace panel** (right,
full-width when open, `workspace-panel.tsx:105`) is Files/Processes/Review, opened
explicitly and closed via its own in-header toggle
(`workspace-panel-toggle`, `rail/workbench-shell-header.tsx:34`). All three already stack by
z-index; collapse does not change their stacking, only how many workbench panes are visible
underneath.

---

## 4. State-model changes — pure VIEW projection, exact touch points

**Claim: collapse requires zero changes to `WorkbenchState`, reducers, selectors' return
shapes, or persistence.** `WorkbenchState` (`workbench/types.ts:19–26`) has no viewport
field and gains none. All edits are inside the view layer of `workbench/workbench.tsx` plus
one new tested pure helper.

### 4.1 New pure helper (tested in isolation)

New file `workbench/collapse-projection.ts` exporting a pure function, e.g.:

```
collapsePaneRects(state: WorkbenchState): Map<string, PaneRect>
```

Returns a single-entry map `{ visiblePaneId → {top:0,left:0,width:1,height:1} }` where
`visiblePaneId = state.focusedPaneId ?? state.panes[0]?.id`. Pure, DOM-free, no state
mutation. This is the tested seam; `workbench.tsx` only decides *when* to call it.

### 4.2 Exact edits in `workbench/workbench.tsx` (view layer only)

| # | Location (live line) | Change |
|---|---|---|
| 1 | `:51` `containerSize` signal (already exists) | Reuse it. Add `const collapsed = createMemo(() => { const w = containerSize().w; return w > 0 && w < BP_MD })`. The `w > 0` guard avoids a false collapse before first measure. |
| 2 | `:107` `rectMemo = createMemo(() => computePaneRects(...))` | **Leave unchanged** (still the true geometry; used by resize divider math and arrow-focus). Add a new `displayRects = createMemo(() => collapsed() ? collapsePaneRects(ctx.getState()) : rectMemo())`. |
| 3 | `:225` `paneRectStyle(paneId)` | Read `displayRects()` instead of `rectMemo()`. Panes absent from the collapsed map return `{display:"none"}` (already the "no rect" path at `:228`). |
| 4 | `:476` `slotStyle()` (content slots) | Read `displayRects()` for the visible-pane rect (`:492`). Unchanged stashed-content branch (`:480`). |
| 5 | `:324` `dropTargetPaneStyle` | Follows `paneRectStyle` automatically (it spreads it). No direct edit. |
| 6 | `:381` resize divider `<Show when={rootSplit()}>` | `<Show when={rootSplit() && !collapsed()}>` — no divider in single-pane mode (also matches mobile-smoke behavior 2's expectation that pointer-resize handles are absent at narrow width, cf. `workspace-panel.tsx:261`). |
| 7 | `:110–142` `scheduleResizeEmit` / `onPaneResize` | Emit from `displayRects()` (not `rectMemo()`) so the visible terminal refits to the full-bleed rect (`emitTerminalFit`, `rail-workbench-canvas.tsx:63`). |
| 8 | `:562–613` pane-handle (`:570`) + pane-close-zone (`:580`) | Already positioned via `paneRectStyle`; they inherit `display:none` for hidden panes. Optionally short-circuit the drag-handle in collapsed mode (its DnD is touch-dead anyway — behavior 4). |
| 9 | `:650` `moveFocusByDirection` | Leave as-is: it reads `computePaneRects` and only sets `focusedPaneId`. In collapsed mode arrow-focus therefore acts as next/prev-pane switching (desirable parity, §6). |

Nothing in `workbench/provider.tsx`, `workbench/selectors.ts`, `workbench/reducers/**`, or
`state/provider.tsx` changes. `selectors.focusedContent` (`selectors.ts:27`) and
`state.focusedPaneId` are the only reads the projection needs, and they already exist.

### 4.3 The one non-projection edit (already covered §3.2)

`state/route-intent.ts:508` gains a narrow guard on the `workspaceBrowse` auto-open. This is
*route-resolution* logic, not workbench state, and is the single behavioral change; it is
independently testable (§7) and desktop-inert.

### 4.4 Chrome-state edit (already covered §3.1)

`rail/rail-shell-chrome-state.ts:58–62` gains `openMobileSidebar`; `app-shell-layout.tsx:341`
re-wires `onShowSidebar`. Chrome signals, not workbench state.

---

## 5. Breakpoint token

**Decision: one token, `BP_MD = 768` (Tailwind `md`) / `--bp-md: 768px`, is THE narrow
cutover for the whole shell.**

Rationale:
- It matches the point at which the **rail sidebar already becomes a drawer**: every mobile
  drawer rule in `rail-sidebar-shell.tsx` uses Tailwind `max-md` (`:112`, `:114`) = `<768`,
  and `app-shell.css` narrow rules use `max-width:767px` (`:23,:71,:122`). Collapsing the
  workbench at the *same* boundary means "narrow mode" is one coherent state: drawer + single
  pane together, no dead zone where the sidebar is a drawer but panes are still slivered.
- It replaces the ad-hoc `767`/`639` (`app-shell.css`) and `1200/900/1024/768/420`
  (`components/page-editor/page-editor.css:510,518,1460,1522,1646`) magic numbers called out
  as a `[medium]` finding (audit lines 1063–1065) — those should be migrated to the token by
  C3's breakpoint-consolidation step; this note only *defines* it.

**Delivery — needs both JS and CSS, from one source:**
The workbench decides collapse in JS (it reads `containerSize().w`), so a CSS-only media
query is insufficient. Provide:
- a TS constant `BP_MD = 768` (proposed home: a new `src/utils/breakpoints.ts`, or wherever
  WP-01's vocabulary work lands shared tokens),
- a matching `:root { --bp-md: 768px }`,
- a tiny **parity guard test** asserting the TS constant equals the CSS custom property
  (same pattern as the i18n manifest parity test, LLD WP-A6), so they cannot drift.

**Reconciliation with `workspace-panel.tsx` `isMobile() < 640`:** the panel's full-width
threshold is `640` (`:31`), one Tailwind step below the workbench collapse at `768`. Two
defensible options — flagged as Q1 in §8:
- (a) Keep both as named tokens (`--bp-sm=640` for panel full-width, `--bp-md=768` for
  workbench collapse). Cleaner semantically, but two tokens.
- (b) Migrate the panel to `768` too (one token). Simpler, but widens the full-width-panel
  trigger.
Either way, mobile-smoke runs at iPhone 13 (390px), far below both, so behaviors 2/3 are
unaffected by the choice; it only matters in the 640–768 tablet band.

---

## 6. Keyboard / touch parity

- **Touch:** switching panes is tapping a compact-switcher tab — real `<button>` with
  `aria-label`, 40px touch floor under `(pointer: coarse)` (`app-shell.css:34–54`). No DnD
  needed for the collapse feature itself.
- **Keyboard:** the switcher tabs are natively focusable/activatable (Enter/Space on
  `<button>`). Additionally, the existing workbench arrow-key focus chords
  (`workbench.tsx:177–193` → `moveFocusByDirection`, `:650`) set `focusedPaneId`, which in
  collapsed mode swaps the single visible pane — i.e. `mod`+arrow becomes prev/next-pane in
  collapsed mode with no extra code. The keyboard-split chord (`:162`, `mruHiddenContent`)
  still splits state; the new pane simply won't be visible until re-widen or until it's
  focused — acceptable (it is not *lost*), and flagged as a minor UX question (Q4).
- **Resize divider:** absent in collapsed mode (edit #6), so its keyboard resize
  (`workbench.tsx:407–420`) is simply not present — nothing to orphan. The workspace-panel's
  own resize separator is likewise `!isMobile()`-gated (`workspace-panel.tsx:261`),
  consistent.
- **Reduced motion:** existing `prefers-reduced-motion` rules already cover the panel/rail
  transitions (`app-shell.css:128–138`); the collapse projection introduces no new animated
  property (panes just swap which rect is full-bleed), so no new motion to gate.

---

## 7. Testability — which layer proves what

Mapping to the acceptance bar (`mobile-smoke.spec.ts`):

| Behavior | Today | After this design | Test layer |
|---|---|---|---|
| 1 — mobile drawer opens/scrim-closes/closes-on-select (`:185`) | `test.fixme` (dead code, no opener) | **Flip to real** once `openMobileSidebar` + header wiring land (§3.1) | mobile Playwright |
| 2 — workspace panel full-width, no resize handle `<640` (`:198`) | green | **stays green** (untouched; collapse gates the *workbench* divider, not the panel) | mobile Playwright |
| 3 — seeded timeline scrolls narrow (`:228`) | green | **stays green** | mobile Playwright |
| 4 — multipane + DnD touch equivalent (`:251`) | `test.fixme` (no impl) | **Split:** the *collapse* half becomes real (new behavior 5, below); the *touch-DnD* half stays `fixme` for the sibling worker | mobile Playwright + vitest |

**New mobile Playwright assertions (this WP's falsifiable evidence):**
- *Behavior 5 (collapse):* seed a 2-pane split (drive a split in a desktop-project setup or
  seed `claxedo.state.v5`), load at iPhone 13, assert exactly one `[data-pane-id]` slot is
  visible (others `display:none`), the compact-switcher lists both surfaces, and tapping the
  non-visible surface's tab swaps which pane is visible — proving preserved-but-hidden +
  switcher.
- *No auto-open at narrow boot:* assert `[data-testid="workspace-panel-shell"]` is
  `data-open="false"` immediately after `openWorkbench` at narrow width, then delete the
  `closeWorkspacePanelIfOpen` workaround (`mobile-smoke.spec.ts:135`).

**vitest (pure, no DOM):** `workbench/collapse-projection.test.ts` — boundary at `BP_MD`
(width just below/above; `w===0` guard returns full geometry, not collapsed), visible-pane
selection (focused wins; null-focus → first pane), and an invariant test that
`collapsePaneRects` does **not** mutate its input `WorkbenchState` (the projection-purity
guarantee). Colocate; if the leader prefers the lettered ordered-spec suite
(`workbench/tests/A–N`, README convention), add it as `O-collapse.test.ts`.

**vitest DOM (`.vitest.tsx`, jsdom):** a collapsed-render spec modeled on
`workbench/tests/M-callbacks.vitest.tsx` / `N-reactivity.vitest.tsx` (+ `dom-helpers.tsx`):
mount `<Workbench>` with a 2-pane state, force a narrow container width, assert only the
focused pane slot has a non-`none` rect and `workbench-divider` is absent; change
`focusedPaneId`, assert the visible slot swaps. This guards the projection wiring without a
browser.

**Breakpoint parity guard:** TS `BP_MD` ≡ CSS `--bp-md` (§5).

---

## 8. Non-goals and open questions

### Non-goals (explicitly out of scope for the collapse worker)
- **Touch-compatible drag/reorder/split** (behavior 4's DnD half; audit `[critical]` line
  1048; refactor step "[L] … replace/augment native HTML5 DnD", lines 1092–1093). Owned by
  the sibling C3 touch-DnD worker via the `workbench/drag-drop.ts` seam. Collapse must not
  depend on DnD, and does not.
- **Terminal accessory key row** for soft keyboards (audit `[high]` line 1054; separate C3
  step, lines 1096–1097).
- **Full breakpoint-literal CSS migration** in `page-editor.css` etc. — this note *defines*
  `--bp-md`; sweeping the 420/639/767/900/1200 literals is C3's `[S]` consolidation step
  (audit lines 1098–1099).
- **rail-sidebar.tsx god-file split** (audit `[high]` line 1057; that is WP-B2 / a separate
  C3 step).
- **Any change to desktop multipane behavior.** Collapse is inert at `≥ BP_MD`.

### Open questions for the leader
1. **Panel threshold reconciliation (§5):** keep two tokens (`--bp-sm=640` panel full-width,
   `--bp-md=768` workbench collapse) or migrate the panel's `isMobile()` (`workspace-panel.tsx:31`)
   to `768` for a single token? (No effect on the mobile-smoke phone viewport either way.)
2. **Ownership of the drawer-opener + header wiring (§3.1).** LLD WP-C3 ownership (lines
   466–469) is `workbench/workbench.tsx`, DnD call sites, the CSS breakpoints, terminal
   mobile surface, and mobile e2e — it does **not** include `rail/rail-shell-chrome-state.ts`
   or `shell/app-shell-layout.tsx`. Wiring `openMobileSidebar` (which flips behavior 1) edits
   both. Confirm this stays in the collapse WP (recommended — it is the same "narrow mode"
   feature and ~6 lines) or is dispatched as a coordinated micro-WP to whoever owns
   rail/shell chrome. Note `utils/workspace-runtime-route-audit.test.ts:2920` asserts the
   current `closeMobileSidebar` wiring string and may need updating.
3. **Narrow-detection inside `route-intent.ts` (§3.2).** The auto-open guard runs in
   imperative, non-reactive resolution. Read `window.innerWidth < BP_MD` directly (simple,
   but a raw global read in resolution logic), or thread a `narrow()` capability from the
   caller (cleaner, more plumbing)? Recommend the direct read behind a named
   `isNarrowViewport()` helper in `utils/breakpoints.ts` so the magic is centralized.
4. **Keyboard-split in collapsed mode (§6).** `mod+\` still creates a real (hidden) pane. Is
   "split creates an off-screen pane you reach via the switcher" acceptable, or should the
   split chord be a no-op / act as "reveal MRU surface in the single pane" when collapsed?
   (Recommend: leave it — the pane is reachable, not lost — but confirm.)
5. **Switcher prominence (§2).** If the mobile Playwright run shows the top-bar switcher
   cramped against the new/settings/panel controls at 390px, promote it to a full-width row
   under the top bar at `<md` (CSS-only in `rail/workbench-shell-header.tsx`). Confirm
   whether to do this proactively or only if the run flags it.

### Not decidable without more input
- Whether behavior-5's Playwright setup should seed a split via `claxedo.state.v5` localStorage
  or drive a real split gesture first depends on the e2e session's fixture conventions
  (that session owns `e2e/**` per LLD line 517–519). The collapse worker should coordinate
  the seed shape with that session rather than invent one; both are viable and this note does
  not pick one.
