# WP-C3 — Breakpoint-Token Consolidation Inventory (READ-ONLY)

Date: 2026-07-11
Status: pre-scoping inventory (no source edits made; informs the WP-C3 `[S]`
  breakpoint-consolidation step)
Wave: 3
Scope: every viewport-conditional site under `packages/claxedo-app/src`
  (CSS `@media`, Tailwind responsive prefixes, `matchMedia`/`createMediaQuery`,
  `window.innerWidth`/`viewportWidth` comparisons, and numeric width constants
  that gate layout).
Design basis: `docs/plans/2026-07-11-004-wp-c3-workbench-collapse-design.md`
  §5 ("Breakpoint token") — already decided `BP_MD = 768` / `--bp-md: 768px`
  as the workbench-collapse boundary, and flagged (Q1) the open question of
  whether the workspace-panel's `640` threshold becomes its own token
  (`--bp-sm`) or migrates to `768`. This inventory treats that decision as
  **still open** and enumerates every other site so the leader can resolve
  all of them in one pass.

All Tailwind-scale references below use the framework's default `screens`
scale: `sm=640`, `md=768`, `lg=1024`, `xl=1280`, `2xl=1536`.

---

## 0. Headline numbers

- **11** raw CSS `@media (max-width|min-width: …)` rules across 3 files.
- **8** JS/TS sites that read `window.innerWidth` / a `viewportWidth` signal
  / `matchMedia` / `createMediaQuery` to branch layout or behavior.
- **1** legacy numeric-width behavior gate outside CSS/matchMedia
  (`context/layout.tsx` session-width floor).
- **0** Tailwind arbitrary-value breakpoint prefixes (e.g. `max-[639px]:`)
  found anywhere in `src` — every one of the 25 files that use responsive
  Tailwind prefixes (`grep -rloE '\b(sm|md|lg|xl|2xl|max-sm|max-md|max-lg|max-xl):'`)
  uses the **stock scale only** (`md:`, `max-md:`, `xl:`, `2xl:`, etc.). These
  need **no migration** — they already resolve to the token values once the
  token constants below are defined; nothing to edit.
- Distinct raw pixel values in play today: **420, 639, 640, 767, 768, 900,
  1024, 1200, 1536**. `1536` is already exactly Tailwind `2xl` (compliant).
  `639`/`767` are the `max-width` complements of `640`/`768` (also
  compliant — CSS convention pairs `min-width:768px` with `max-width:767px`
  for the boundary immediately below it).
- Grep noise ruled OUT of this inventory (matched the requested
  `420|480|639|640|767|768|900|1024|1200` sweep but are **not**
  viewport-conditional): byte-size constants (`MAX_FILE_CONTENT_BYTES`,
  `MAX_PENDING_BYTES`, etc.), animation/timeout durations (`1200ms` timers,
  `420ms` CSS keyframe duration), the `message-timeline.tsx` marquee-pacing
  function (`pace(width)` — paces an element's *own* scroll animation off its
  `clientWidth`, not a viewport breakpoint), and the page-editor floating
  popover geometry constants (`page-editor-geometry.ts` — `420`/`1024` there
  size a floating AI/toolbar popover relative to the editor's own bounding
  rect, not the viewport).

---

## 1. CSS `@media` rules (11 sites, 3 files)

### `src/claxedo-ui/ui-overrides.css`

| Line | Raw value | Gates | → Token | Risk |
|---|---|---|---|---|
| `ui-overrides.css:47` | `@media (min-width: 768px)` | Restores desktop-width override (`max-width: 50rem`/800px) for `.md\:max-w-\[500px\].md\:mx-auto` — a CSS-selector shim keyed to Tailwind's own generated `md:` class name (comment: "Upstream narrowed from 800px/1000px to 500px/700px"). | `--bp-md` (768, exact match — this literally re-derives Tailwind's own `md` breakpoint) | Pure-visual (max-width override only) |
| `ui-overrides.css:52` | `@media (min-width: 1536px)` | Same pattern for the `2xl:max-w-[700px]` override → 1000px. | `--bp-2xl` (1536, exact match) | Pure-visual |

Both are **already exactly on the Tailwind scale** — the ad hoc part is that
the *values* (768, 1536) are hand-typed pixel literals instead of a shared
token; the *boundaries themselves* need no change, only the literal → token
swap.

### `src/claxedo-ui/app-shell.css`

| Line | Raw value | Gates | → Token | Risk |
|---|---|---|---|---|
| `app-shell.css:23` | `@media (max-width: 767px), (pointer: coarse)` | Touch-target floor (40×40 min tap size) + touch transition/press-state rules for buttons app-wide (`[data-claxedo] button`, settings dialog, diagnostics dialog). Referenced directly by the WP-C3 collapse design note §6 as the source of the switcher's touch floor. | `--bp-md` complement (767 = "below md") | **Behavior-gating** — this is an accessibility/touch-target floor, not decorative. Changing the boundary changes which viewport widths get 40px tap targets. |
| `app-shell.css:71` | `@media (max-width: 767px)` | Diagnostics dialog goes full-viewport (`100vw`/`100dvh`, `border-radius:0`) below the boundary. | `--bp-md` complement | Pure-visual (dialog chrome sizing) |
| `app-shell.css:122` | `@media (max-width: 767px)` | `.claxedo-rail-sidebar-panel` transform reset (kills the desktop `-8px` offset) below the boundary — paired with the mobile sidebar drawer logic the collapse design note (§3.1) makes live. | `--bp-md` complement | **Behavior-gating** — feeds directly into the mobile-drawer feature the collapse design note is wiring up; a boundary drift here would desync the drawer's CSS transform state from its JS `mobileSidebarOpen` boundary check once that JS gets a narrow-viewport predicate (design note §3.2 Q3). |
| `app-shell.css:147` | `@media (max-width: 639px)` | Settings dialog "mobile drill-down": single-column layout, menu/content mode toggling (`.settings-mobile-menu`, `.settings-mobile-content`, `.settings-mobile-back`). | `--bp-sm` complement (639 = "below sm/640") | **Behavior-gating** — this is a structural layout mode switch (two-pane → drill-down single pane), not cosmetic. This is the **one CSS site that does NOT match `BP_MD`** — it sits a full step below at the `sm` boundary, and it has a live JS counterpart at `settings.tsx:38` (§2) using the exact same `640` value. These two must move together. |

### `src/claxedo-ui/components/page-editor/page-editor.css`

All 5 rules are top-level (not nested inside another selector or container
query — confirmed by brace-depth scan) and form a cascading 5-tier
responsive system specific to the Notion-style page editor, called out by
name in the design note (§5, "Reconciliation" bullet) as C3's `[S]`
consolidation target:

| Line | Raw value | Gates | → Token | Risk |
|---|---|---|---|---|
| `page-editor.css:510` | `@media (max-width: 1200px)` | Reduces page-shell horizontal padding 60px→42px; repositions `.notion-page-actions` inset. | **No clean Tailwind match** (between `lg`=1024 and `xl`=1280). Closest candidates: round down to `lg` (1024, tightens the trigger — collides with the very next tier at 1024, see below) or up to `xl` (1280, loosens it slightly). Recommend treating as genuinely bespoke (`--bp-editor-wide` or similar) rather than forcing a collision with the 1024 tier immediately below it. | Pure-visual (padding/positioning only) |
| `page-editor.css:518` | `@media (max-width: 900px)` | Further padding reduction (42px→28px) + `.notion-page-actions` flips from `position: static` to wrapped inline row; button font/padding shrink. | **No clean Tailwind match** (between `md`=768 and `lg`=1024). Same collision problem as above if forced onto `md` or `lg`. Recommend bespoke tier, or fold into the `768` tier below if the visual difference between 900 and 768 is judged negligible (needs a visual diff, flagged as open question). | Mostly visual, but the `position: static` flip is a real layout-mode change for the action buttons, so treat as **low-behavior-risk** rather than pure-visual. |
| `page-editor.css:1460` | `@media (max-width: 1024px)` | Side-dock collapse: `.notion-page-shell-with-side-dock` goes to `width:min(100%,920px)`; `.notion-page-dock-side` flips from a right/left-anchored floating dock to a full-width bottom-anchored dock (`top:auto; bottom:0`); dock resize handle and toolbar are hidden; TOC sidebar (`.notion-toc-wrap`) is hidden. | **Clean match: `--bp-lg` (1024, exact).** | **Behavior-gating** — this changes the dock's anchor/interaction model (draggable side panel → fixed bottom sheet), not just spacing. Highest-risk item in this file to retarget precisely because it's already exact — no value change needed, only literal→token swap, so risk is **low** *if* the swap is literal-for-literal. |
| `page-editor.css:1522` | `@media (max-width: 768px)` | Main "mobile mode" for the page editor: page shell goes full-width/no-max-width, title/heading font sizes shrink, floating toolbar/AI menu/link popover/convert menu all switch from anchored-near-selection to fixed-bottom-sheet positioning (`bottom: env(safe-area-inset-bottom)…`), slash-command menu width caps change. | **Clean match: `--bp-md` (768, exact) — same boundary as the workbench collapse mode.** Aligning these means "the editor enters mobile mode" and "the workbench collapses to single-pane" fire at the identical width, which is the semantically coherent outcome the design note argues for at the shell level (§5, "one coherent state"). | **Behavior-gating** — multiple floating UI elements switch positioning strategy entirely (anchored popover → fixed bottom sheet). No value change needed (already exactly 768), so mechanical risk is low, but this is the single largest blast-radius rule in the file. |
| `page-editor.css:1646` | `@media (max-width: 420px)` | Extra tight-phone tier: page-shell padding drops to 12px, title font 30px, editor body font 15px. | **No Tailwind-scale match at all** — Tailwind's default scale has nothing below `sm`=640. This is the one rule that is **behavior-relevant to today's mobile e2e coverage**: `mobile-smoke.spec.ts` runs at iPhone 13 = **390px width**, which is *below* 420, so this tier is live during the existing narrow-viewport Playwright suite. Recommend keeping a **named bespoke token** (e.g. `--bp-xs: 420px`, explicitly documented as "not on the Tailwind default scale, kept for the page-editor's extra-narrow-phone tier") rather than silently rounding it into `sm`/`640` — rounding up would fire the tier at a much wider range (390–640 instead of 390–420) and is a real visual behavior change, not a no-op token swap. | Pure-visual (font-size/padding only) but **do not silently renumber** — treat any value change here as behavior-changing given the live e2e coverage at 390px. |

---

## 2. JS/TS `matchMedia` / `innerWidth` / `createMediaQuery` sites (8)

| # | File:line | Mechanism | Raw value | Gates | → Token | Risk |
|---|---|---|---|---|---|---|
| 1 | `src/pages/session.tsx:450` | `createMediaQuery("(min-width: 768px)")` (`@solid-primitives/media`) — reactive | 768 | `isDesktop`/`centered` — drives the session timeline/composer's centered max-width (`md:max-w-200 2xl:max-w-[1000px]` classes at `message-timeline.tsx:1156,1433` and `session-composer-region.tsx:193`, which are themselves already on-scale Tailwind prefixes). | `--bp-md` / `BP_MD` (exact) | Pure-visual (centering/max-width) but this is the **cleanest existing pattern** — a reactive primitive reading the literal Tailwind boundary. Recommend this call site becomes the template for a shared `useBreakpoint`/`isDesktop()` helper once `utils/breakpoints.ts` exists, rather than inlining `"(min-width: 768px)"` as a string literal here (drift risk: nothing ties this string to the CSS custom property). |
| 2 | `src/terminal/backend/renderer.ts:107` (boundary asserted in `renderer.test.ts:145,149,153` at 767/1920/1280) | `win.innerWidth <= 767` (imperative, one-shot at renderer-selection time) — companion `matchMedia("(pointer: coarse)")` check at line 106 | 767 | `shouldPreferDomRenderer()` — forces the terminal to the DOM (non-WebGL) renderer below the boundary, to dodge a mobile-Safari/Chrome WebGL canvas-blanking bug. | `BP_MD` complement (767 = "below md") | **Behavior-gating and safety-critical** — this is a rendering-mode fallback for a real browser bug, not layout polish. Exact value must be preserved (`<= 767` ⇔ `< 768`); only the literal→constant swap should happen here. Injectable `win` param already makes this trivially testable — the existing test (`renderer.test.ts`) pins the exact 767/1280 boundary and would need its literal updated in lockstep if the constant changes shape (e.g., import vs. inline). |
| 3 | `src/components/dialogs/settings.tsx:38` | `window.innerWidth < 640` (imperative, read inside a pointer-drag handler) | 640 | Disables desktop-only dialog free-drag (repositioning by dragging the title bar) below the boundary — pairs with the **CSS** mobile drill-down layout at `app-shell.css:147` (§1) which uses the same 640/639 boundary via a *separate* `mobile` signal (`settings.tsx:24,98,103-104,112`) that is driven by tab-selection, not viewport width. | `--bp-sm` (640, exact) | Pure-visual/interaction (drag is simply inert on mobile, no error state) but **must stay paired** with `app-shell.css:147`'s `639`. These two are the strongest "same feature, two literals" pair in the codebase outside `640`↔`app-shell.css:147` reconciliation is the same one. |
| 4 | `src/claxedo-ui/workspace-panel/workspace-panel.tsx:28` | `createSignal(... window.innerWidth)`, updated on `resize` (`:170`) | 1024 (SSR-only default, not a gate) | Not itself a breakpoint — just the pre-hydration fallback value for the reactive `viewportWidth` signal. Included for completeness since it's the same signal line 31 gates on. | n/a (not a boundary) | n/a |
| 5 | `src/claxedo-ui/workspace-panel/workspace-panel.tsx:31` | `viewportWidth() < 640` (reactive) | 640 | `isMobile()` — forces the workspace panel to `width:100%` (`:105` `panelStyleWidth`), sizes `restingPanelWidth` off `availableWidth()` instead of the desktop 70/86% clamp (`:100-104`), and (via `:261`) **hides the resize-drag separator entirely** below the boundary. This is the mechanism `mobile-smoke.spec.ts` behavior 2 pins green today, and the exact reconciliation point flagged as **Q1** in the collapse design note (§5): keep as its own `--bp-sm=640` token, or migrate to `768` to match the workbench collapse (`BP_MD`)? | `--bp-sm` (640) **or** migrate to `--bp-md` (768) — **open decision, not resolved by this inventory** | **Behavior-gating, highest-traffic site** — full-width panel mode + resize-handle removal is asserted by a green Playwright test today. Any value change here is a behavior change with direct e2e coverage; treat as the highest-priority item to resolve explicitly (not silently) in the consolidation PR. |
| 6 | `src/claxedo-ui/components/review-workspace/review-tab.tsx:89` | `window.innerWidth < 768` (imperative, one-shot at component-init — `initialDiffStyle()`) | 768 | Default diff view mode: `"unified"` below the boundary vs. `"split"` above. One-time read, not reactive — a user resizing past 768 after load does not flip the diff style back. | `--bp-md` (768, exact) | Pure-visual/UX default only (user can still manually switch modes); low risk, but note the **non-reactivity** is itself worth flagging during consolidation — if the shared helper becomes a reactive `isNarrowViewport()`/hook (as `utils/breakpoints.ts` is proposed to be, per design note §8 Q3), this call site would need to explicitly opt out of reactivity to preserve current "computed once at mount" semantics, or the consolidation should decide to make it reactive too (behavior change, needs a call). |
| 7 | `src/context/layout.tsx:740-742` | Plain numeric comparison on a **persisted layout-store field** (`store.session.width`), not `window.innerWidth` | 640 | When the review panel opens, if the persisted session-pane width is below 640 it's bumped up to 640 (`setStore("session", "width", 640)`). This is **not a viewport-conditional site** in the "reads current viewport" sense — it's a minimum-content-width floor for a resizable pane, expressed with the same numeral as the `sm` boundary by convention/coincidence. | Could become `--bp-sm` (640) for documentation clarity, but this is conceptually a **content minimum**, not a breakpoint — recommend leaving as a named `MIN_SESSION_PANE_WIDTH` constant (equal in value to `--bp-sm`) rather than importing the breakpoint token directly, to avoid implying viewport semantics that don't apply here. | Low risk either way (internal store clamp, no external assertion found in `*.test.*`/`*.spec.*` on this exact line) |
| 8 | `src/claxedo-ui/components/page-editor/page-editor-model.ts:58-61` (`clampDockWidth`) + call site `page-editor-dock.tsx:66-67,171,190` | `innerWidth` passed in as a parameter (testable pure function) | `360` (min), `900` (SSR-branch max), `420` (floor on the live-branch max), `-320` (reserved gutter subtracted from `innerWidth`) | Clamps the page-editor's resizable side-dock width. `innerWidth === undefined` → SSR branch clamps to `[360,900]`; live branch computes `max = Math.max(420, innerWidth - 320)` then clamps to `[360, max]`. Pinned by `page-editor-model.test.ts:94-103`. | **Not a breakpoint** — this is a resizable-panel min/max width formula (reserves 320px of viewport for the editor body, floors the dock's own max at 420px so it never goes below a readable width). Recommend leaving these literals as-is; they are a sizing formula, not a layout-mode gate, and forcing them onto the Tailwind scale would be a category error. | n/a — flagging as **correctly out of scope**, since it was one of the sites the requested grep sweep surfaces but does not belong in the token consolidation. |

---

## 3. Container queries (found, but out of scope)

- `src/index.css:52-53,123` — `container-type: inline-size` / `@container
  getting-started (min-width: 17rem)` on a `getting-started` card widget.
  Component-local container query, unrelated to shell/viewport breakpoints.
  Not a candidate for the `BP_*` token set.
- `src/claxedo-ui/app-shell.css:84,89` and `src/pages/session.tsx:1308`,
  `src/components/session/session-context-tab.tsx:304` use the Tailwind
  `@container`/`.@container` utility class name itself (container queries
  keyed off a parent's size, not the viewport) — orthogonal mechanism,
  correctly excluded from a *viewport* breakpoint token set.

## 4. Tailwind arbitrary-value breakpoints: none found

Explicitly searched for `max-[Npx]:` / `min-[Npx]:` arbitrary-value
responsive variants across every `.tsx`/`.ts` file in `src` — **zero
matches**. Every one of the 25 files using responsive Tailwind prefixes
(`rail-sidebar-shell.tsx`, `rail-sidebar.tsx`, `rail-workbench-shell.tsx`,
`workbench-shell-header.tsx`, `workspace-toolbar.tsx`, `settings.tsx`,
`model-control.tsx`, `toolbar-controls.tsx`, `session-header.tsx`,
`connections.tsx`, `general.tsx`, `keybinds.tsx`, `models.tsx`,
`providers.tsx`, `sandbox-section.tsx`, `terminals.tsx`, `titlebar.tsx`,
`cards.tsx`, `panel.tsx`, `home.tsx`, `session.tsx`,
`session-composer-region.tsx`, `message-timeline.tsx`,
`agent-harness-selector.tsx`, `dialog-process-diagnostics.tsx`) uses only
`sm:`/`md:`/`lg:`/`xl:`/`2xl:`/`max-md:` etc. — the stock scale. These
require **no source changes** for the consolidation; they already resolve
correctly once (if) the Tailwind config's `screens` stays at its current
defaults. (Note: several of these files also use `max-w-[Npx]` arbitrary
*sizing* values, e.g. `model-control.tsx:22`'s `max-md:max-w-[72px]` — those
are element-width caps, not breakpoint thresholds, and are out of scope.)

---

## 5. Proposed token set

### 5.1 Decision this inventory does NOT make

Per design note §5 Q1, whether the workspace panel's `640` boundary
(`workspace-panel.tsx:31`, `settings.tsx:38`, `app-shell.css:147`) stays a
distinct `--bp-sm` tier or migrates up to `--bp-md`/768 to match the
workbench collapse is a product/visual call (it changes the 640–768 "tablet
band" behavior) — flagging it here as the **first thing the consolidation
PR must decide explicitly**, not default silently. This inventory assumes
**option (a) — keep both** for the token list below, since it is the
zero-behavior-change default; the alternative is a one-line change if the
leader picks (b).

### 5.2 TS constants (proposed home: `src/utils/breakpoints.ts`, new file —
confirmed not to exist yet via `find`/`grep`)

```ts
// src/utils/breakpoints.ts
export const BP_SM = 640   // Tailwind `sm` — workspace-panel full-width /
                            // settings-dialog drill-down / settings free-drag
export const BP_MD = 768   // Tailwind `md` — workbench collapse (design note
                            // 2026-07-11-004 §5) / rail sidebar drawer /
                            // page-editor mobile mode / terminal DOM-renderer
                            // fallback / review-tab default diff style /
                            // session timeline centering
export const BP_LG = 1024  // Tailwind `lg` — page-editor side-dock collapse
export const BP_XL = 1280  // Tailwind `xl` — (currently unused as a gate;
                            // reserved if page-editor's 1200 tier rounds up)
export const BP_2XL = 1536 // Tailwind `2xl` — ui-overrides timeline/composer
                            // max-width restore

// Bespoke, NOT on the Tailwind default scale — kept as named exceptions
// rather than forced onto the nearest stock step (see §1, page-editor.css
// rows for 1200/900/420).
export const BP_EDITOR_WIDE = 1200  // page-editor.css:510 padding tier
export const BP_EDITOR_COMPACT = 900 // page-editor.css:518 padding/actions tier
export const BP_XS = 420            // page-editor.css:1646 extra-narrow-phone
                                     // tier — live at the mobile-smoke iPhone
                                     // 13 (390px) viewport, do not fold into BP_SM

export function isNarrowViewport(width = typeof window === "undefined" ? undefined : window.innerWidth): boolean {
  return width !== undefined && width < BP_MD
}
```

The three `BP_EDITOR_*`/`BP_XS` bespoke constants intentionally break the
"aligned to the Tailwind scale" mandate for the 3 page-editor tiers that
have no clean stock-scale equivalent (§1 table) — recommend the
consolidation PR confirm this trade-off explicitly (collapse them into
`BP_LG`/`BP_MD`/`BP_SM` and accept the visual tier shift, vs. keep as
named bespoke constants) rather than the inventory silently picking one.

### 5.3 CSS custom properties (proposed home: `app-shell.css` `:root`, since
that file already owns the shell-level narrow-viewport rules)

```css
:root {
  --bp-sm: 640px;
  --bp-md: 768px;
  --bp-lg: 1024px;
  --bp-xl: 1280px;
  --bp-2xl: 1536px;
  --bp-editor-wide: 1200px;
  --bp-editor-compact: 900px;
  --bp-xs: 420px;
}
```

CSS custom properties **cannot be interpolated into `@media` query
conditions** (a well-known CSS limitation — `@media (max-width: var(--bp-md))`
is invalid), so defining `--bp-md` etc. documents the value for
`calc()`/inline-style use (e.g. JS-driven inline styles, or `clamp()`
expressions) but every `@media (max-width: 767px)` rule listed in §1 must
keep the **literal pixel number** in the media condition itself — the win is
that the literal is now sourced from/checked against a single documented
constant instead of re-typed ad hoc per file. This is exactly why §5.4's
parity guard matters: it is the only mechanism tying the CSS literal back to
the TS constant.

### 5.4 TS/CSS parity guard (per design note §5, "same pattern as the i18n
locale manifest parity test," WP-A6)

Proposed: a small vitest asserting, for each token, that the numeric value
in `src/utils/breakpoints.ts` equals the pixel number parsed out of the
corresponding `--bp-*` custom property in `app-shell.css`'s `:root` block
(parse the CSS file as text with a small regex — same technique the i18n
manifest parity test uses against JSON, no CSS-in-JS/PostCSS dependency
needed). Because raw `@media` conditions can't reference the custom
property, this guard is the **only** thing preventing a future edit from
changing `BP_MD` in TS without updating the `767`/`768` literals scattered
across `app-shell.css`, `page-editor.css`, `renderer.ts`,
`workspace-panel.tsx`, `review-tab.tsx`, and `settings.tsx` — recommend the
guard enumerate every literal site from §1/§2 by file:line (not just the
`:root` block) so a future drift is caught at the call site, not just at the
token definition.

---

## 6. Migration risk summary

| Risk tier | Sites | Notes |
|---|---|---|
| **Pure-visual, exact-value match (safe literal→token swap)** | `ui-overrides.css:47,52`; `app-shell.css:71`; `page-editor.css:1460,1522`; `renderer.ts:107`/`renderer.test.ts`; `review-tab.tsx:89`; `session.tsx:450` | No numeric change, just naming. Still needs the parity guard (§5.4) and, for `renderer.test.ts`, updating the test's literal in lockstep. |
| **Behavior-gating, exact-value match** | `app-shell.css:23,122`; `workspace-panel.tsx:31` (+ its `:261` divider gate); `settings.tsx:38`; `app-shell.css:147` | Real interaction/layout-mode changes (touch targets, drawer transform, panel full-width + resize-handle removal, dialog drill-down, free-drag). Safe to retoken (no value change) but each has e2e coverage (`mobile-smoke.spec.ts`, `core-sidebar-tree.spec.ts`) that should be re-run, not just trusted from a diff read. |
| **No clean Tailwind-scale match — requires an explicit decision** | `page-editor.css:510` (1200), `page-editor.css:518` (900), `page-editor.css:1646` (420) | Only path to zero-behavior-change is keeping bespoke named constants (`BP_EDITOR_WIDE`/`BP_EDITOR_COMPACT`/`BP_XS`, §5.2). Forcing onto `lg`/`md`/`sm` changes real trigger widths, and `page-editor.css:1460` (1024) already occupies the `lg` slot, so `1200`→`lg` would collide two rules onto the same boundary. |
| **Open product decision, not a mechanical migration** | `workspace-panel.tsx:31`'s `640` vs. workbench's `768` (design note §5 Q1) | This inventory intentionally does not resolve it; flagged as the first call the consolidation PR needs. |
| **Correctly out of scope (verified, not touched)** | `context/layout.tsx:740-742` (content-width floor, not a viewport read); `page-editor-model.ts:58-61`/`page-editor-dock.tsx` (`clampDockWidth`, a resizable-panel sizing formula); `page-editor-geometry.ts` (floating popover geometry); `message-timeline.tsx`'s `pace()` (animation pacing off element width); `index.css`'s `@container` (component container query, not viewport) | Included here so a future reader of this doc can see they were considered and deliberately excluded, not missed. |

---

## 7. Files touched by a full consolidation (for scoping the follow-up PR)

New file:
- `src/utils/breakpoints.ts` (does not exist yet — confirmed via `find`)

Edited (CSS):
- `src/claxedo-ui/app-shell.css` (`:root` token block + 4 `@media` literal sites)
- `src/claxedo-ui/ui-overrides.css` (2 `@media` literal sites)
- `src/claxedo-ui/components/page-editor/page-editor.css` (5 `@media` literal sites)

Edited (TS/TSX):
- `src/terminal/backend/renderer.ts` (+ `renderer.test.ts` literal)
- `src/components/dialogs/settings.tsx`
- `src/claxedo-ui/workspace-panel/workspace-panel.tsx`
- `src/claxedo-ui/components/review-workspace/review-tab.tsx`
- `src/pages/session.tsx`

New test:
- a breakpoint TS/CSS parity guard (colocated near `src/utils/breakpoints.ts`
  or under `src/claxedo-ui/tests/` alongside the existing ordered-spec
  convention referenced in the collapse design note §7)

Not touched (explicitly out of scope per §6's last row):
- `context/layout.tsx`, `page-editor-model.ts`/`page-editor-dock.tsx`,
  `page-editor-geometry.ts`, `message-timeline.tsx`, `index.css`
