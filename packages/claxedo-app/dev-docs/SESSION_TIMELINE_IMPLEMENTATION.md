# Session Timeline Redesign — Implementation Plan

This is the execution plan for rebuilding the claxedo session timeline in the spirit of the Codex
timeline, **inside claxedo's own design language**. It is written so an executing agent can pick up
any single item without further research.

Companion docs (same directory, read them first if context is needed):
- [`CODEX_TIMELINE_DESIGN.md`](./CODEX_TIMELINE_DESIGN.md) — what the target behaviors and exact
  visual values are (sections cited below as "D§n").
- [`CLAXEDO_TIMELINE_AUDIT.md`](./CLAXEDO_TIMELINE_AUDIT.md) — gap analysis (workstreams cited as
  "WSn").

---

## 0. How to execute this plan

- **Repo**: `/Users/yashvardhansingh/test/opencode`. App: `packages/claxedo-app` (SolidJS).
  Shared rendering: `packages/session-ui`. Primitives: `packages/ui`.
- **Verify with**: `bun typecheck` run **from `packages/claxedo-app`** (never `tsc`, never from
  repo root). Tests also run from the package dir only.
- **Item order**: do Phase 0 before anything else; inside a phase items are independent.
- **Each item specifies**: goal → experience gain → backend status → exact files → numbered steps
  → acceptance checks. If a step conflicts with reality, stop and report — do not improvise new
  architecture.
- **Invariants — do not break**: workbench pane system, session header/composer, light theme,
  theme switching, virtualizer scroll anchoring, per-part open-state persistence, mobile/narrow
  layouts.

---

## 1. Experience goals (what the user gets)

| Today | After |
|---|---|
| A 40-command turn = 40 loud rows, forever | 1–3 quiet group lines; turn folds to "Worked for 2m 14s ›" when the answer arrives |
| Every row full-brightness text | Work whispers at 40–60% opacity; prose speaks at 100%; hovering a row lifts it |
| `+58 -43` shouts red/green from every row | Stats muted at rest, color only under the pointer |
| You can't tell rows expand | Chevron fades in exactly where your cursor is |
| Subagent = navigate away | Chip with a unique glyph → opens beside the timeline |
| Bash output = hidden-scrollbar box | Edge fades show scrollability; hover reveals the bar |
| Mermaid = plain code | Rendered themed diagram, click to zoom |

These map to Codex design principles D§1: *prose is the product, work is muffled; muted by
default, bright on hover; affordances invisible until needed; the turn is the unit of collapse;
artifacts are first-class objects.*

---

## 2. Design-language compatibility (read before Phase 0)

**What already fits** (no change to app identity): dark-first theme with hairline borders, 14px
chat text, ghost hover actions, SVG-sprite icons, `TextShimmer`, Kobalte collapsibles, 32px rows.
Codex's 36px rows / 20px radii / superellipse corners are **not** imported — claxedo keeps its own
density and radii. Only the *muted ladder, hover gates, grouping, and folding* cross over.

**Barriers (flagged, with decisions):**

1. **Dual token systems + dead `data-new-layout` path — the one real barrier.**
   Legacy tokens (`--text-*`, `--surface-*`) live in `packages/ui/src/styles/theme.css`; a v2 set
   (`--v2-*`) lives in `packages/ui/src/v2/styles/theme.css`; many components carry
   `body:not([data-new-layout])` overrides back to legacy, and **the app never sets
   `data-new-layout`** (only storybook does). Styling work placed in v2-only branches is dead code
   in production.
   **Decision: implement everything in this plan against the legacy token system.** Do not extend
   `data-new-layout` forks. (A separate cleanup can retire v2/dead paths; out of scope here.)
2. **Muted ladder mapping.** Codex uses alpha steps (100/70/60/50/40/30%). Claxedo's legacy ramp
   is theme-resolved (works in light + dark): `--text-strong` (100%), `--text-base`, `--text-weak`,
   `--text-weaker` (≈42% dark). Map: *verb → `--text-base` (brightened to `--text-strong` on
   hover), trailing detail → `--text-weak`, deepest detail → `--text-weaker`.* This gives the full
   ladder with **zero new tokens**. If a step is visually missing in dark, add one legacy variable
   in `theme.css` rather than a hardcoded alpha.
3. **No framer-motion (SolidJS).** All expand/collapse = measured-pixel height + **CSS transition**
   (interruptible, per feel-rule F4). Do not add a JS animation library. For list enter/exit use
   opacity + small `translateY(4px)` only.
4. **Light theme.** Never use raw alpha whites for the ladder — always the token names above so
   light mode resolves correctly.
5. **Icons.** Use the existing sprite (`packages/ui/src/components/icon.tsx`, `<Icon name size/>`,
   small=16px). Available: `terminal`, `console`, `pencil-line`, `edit-small-2`, `magnifying-glass`,
   `file`, `folder`, `task`, `subagent`, `brain`, `checklist`, `chevron-down`, `chevron-right`,
   `expand`, `collapse`, `window-cursor`, `mcp`. No new icon set.

**Feel rules — apply to every item (from the interface-polish checklist):**

- F1 `font-variant-numeric: tabular-nums` on every counter/timer/diffstat.
- F2 Hover reveals use `opacity`/`color`/`transform` transitions only — **never `transition: all`**.
- F3 Expand/collapse transitions: `height` (measured px) + `opacity`, `.15s–.3s`, standard ease;
  interruptible at any frame.
- F4 Enter animations: split into chunks, stagger ≤100ms; exits are *softer* than enters (small
  translateY, no full collapse drama). No entrance animation on initial render of restored state.
- F5 Hit areas: icon buttons ≥ 40×40px effective area (pseudo-element padding allowed); full-width
  rows are already fine.
- F6 Concentric radii: card inner elements = outer radius − padding.
- F7 `will-change` only on `transform`/`opacity` and only if first-frame stutter is observed.
- F8 `-webkit-font-smoothing: antialiased` stays on (already global — keep).
- F9 Numbers that change (elapsed timers, counts) must not cause layout shift: `tabular-nums` +
  `min-width` where needed.
- F10 Respect `prefers-reduced-motion`: gate all shimmer/spinner/transition extras behind it.

---

## 3. Build list & backend support matrix

Backend of record: `packages/opencode` Effect HttpApi; client `@opencode-ai/sdk/v2`
(`packages/sdk/js/src/v2/gen/types.gen.ts`); SSE via `GET /event` (events consumed in
`event-ingress.ts:60-78`). **Legend: ✅ available · 🟡 partial (small gap, fix specified) ·
🔴 missing (backend work required).**

| # | Item | Backend | Evidence / gap |
|---|---|---|---|
| T1 | Muted activity-row anatomy | ✅ client-only | styling only |
| T2 | Hover-gated diffstat colors | ✅ client-only | styling only |
| T3 | Grouping pass (bash/edit/write/web) | ✅ client-only | parts ordered by id (`message-v2.ts:107`); existing `groupParts` |
| T4 | `WorkGroup` component | ✅ client-only | generalizes `ContextToolGroup` |
| T5 | Turn fold → "Worked for Xs" | ✅ | `User.time.created`, `Assistant.time.{created,completed}`; already computed at `message-timeline.tsx:1046` |
| T6 | Live elapsed timers | ✅ | `ToolStateRunning.time.start`, `Completed/Error.time.{start,end}` (`packages/schema/src/v1/session.ts:266-302`) |
| T7 | Final-answer detection for auto-fold | 🟡 | signals exist (`Assistant.finish`, `time.completed`, `step-finish.reason`, `session.status`); heuristic already in app (`assistantCopyPartID`). Optional: tag final text part in `processor.ts` |
| T8 | Per-file edited rows | ✅ | edit `metadata.{diff,filediff}` (`edit.ts:188`), apply_patch `metadata.files[]{relativePath,patch,additions,deletions}` (`apply_patch.ts:295`); `FileDiff.Info` in `packages/schema/src/file-diff.ts`. Minor: `write` lacks `filediff` (use after-content) |
| T9 | Turn file-changes card + Undo/Review | ✅ | `POST /session/:id/revert {messageID,partID?}` + `/unrevert` (git-snapshot, `session/revert.ts`); per-turn diffs on `User.summary.diffs` + `GET /session/:id/diff?messageID=` + `session.diff` event |
| T10 | Hover diff popover | ✅ | same diff metadata as T8 |
| T11 | Right-click context menus | 🟡 | `Platform.openPath(path, app?)`, `openLink` exist (`platform-provider.tsx:38-71`); **gap**: `showItemInFolder` → add one Electron IPC (cf. `claxedo-desktop main/ipc.ts:140` `shell.openPath`) + one `Platform` method |
| T12 | Subagent chips + glyph identity | ✅ | task part `state.metadata = {parentSessionId, sessionId, model, background?, jobId?}`, `input {subagent_type, prompt, description}` (`task.ts:171-181`) |
| T13 | Subagent side preview + diffstats | 🟡 | child = full session (`parentID`), same APIs, `GET /session/:id/children`; per-turn child diffs via `session.diff?messageID=`; whole-child aggregate needs client-side sum of `summary.diffs` |
| T14 | Mermaid diagrams | ✅ | raw markdown in `TextPart.text`; **app already has `platform.renderMermaid`** |
| T15 | Inline-code pill (kill dead path) | ✅ client-only | `markdown.css:225-250` gated behind `data-new-layout` |
| T16 | `@path` file chips in markdown | ✅ | paths present in text; file-open via `Platform.openPath` |
| T17 | Shimmer running verbs | ✅ client-only | `TextShimmer` exists (`@opencode-ai/ui/text-shimmer`) |
| T18 | "Thought for Ns" reasoning row | ✅ | `ReasoningPart {text, time{start,end?}}` |
| T19 | Compaction marker upgrade | 🟡 | `CompactionPart {auto, overflow?}` + `session.compacted` event exist; token before/after **missing** → add 2 optional ints to `CompactionPart` + populate in `compaction.ts` |
| T20 | Bash output scroll affordance | ✅ client-only | styling only |
| T21 | Dot-wave jump-to-bottom while busy | ✅ | `session.status` busy/idle |
| T22 | Turn token footer (optional) | ✅ | `Assistant.cost`, `tokens.{input,output,reasoning,cache}` (`schema:471-481`) |
| T23 | Dev-server localhost row (optional) | 🟡 | shell `state.output`/`metadata.output` retained client-side → regex possible; no port concept exists anywhere yet |
| T24 | Permission/question inline (optional) | ✅ | `PermissionRequest {permission, patterns, metadata, always, tool?{messageID,callID}}` anchors to the exact tool part; events `permission.asked/replied`, `question.*` |

Nothing is 🔴. Two 🟡 gaps need tiny backend/desktop additions (T11 `showItemInFolder`, T19 token
delta); two are optional heuristics (T7, T23).

---

## Phase 0 — Foundations (must land first)

### T0.1 Activity-row CSS primitive

**Goal**: one reusable row anatomy implementing the muted ladder + hover gate, used by every tool
row, group header, file row, and the turn-fold row.

**Experience gain**: the entire timeline calms down; work stops competing with prose. This is the
single highest-leverage visual change (D§1, D§8 rule 1).

**Backend**: ✅ (styling only).

**Files**:
- New: `packages/session-ui/src/components/activity-row.css`
- New: `packages/session-ui/src/components/activity-row.tsx`
- Import css once via the component (session-ui components co-locate css; see `basic-tool.tsx`).

**Spec** (values from D§3.3, D§6; tokens from §2 above):

DOM:
```
<div class="activity-row" data-active=..>
  <button class="activity-row__hit" aria-expanded=.. />   <!-- absolute inset-0 overlay, does the toggling -->
  <Icon name class="activity-row__icon" />                <!-- 16px, color: var(--icon-weak) -->
  <span class="activity-row__summary">
    <span class="activity-row__verb">Shell</span>
    <span class="activity-row__tail">ls packages/…</span>  <!-- truncate, single line -->
  </span>
  <span class="activity-row__accessory">…</span>          <!-- optional right side (diffstat, elapsed) -->
  <svg class="activity-row__chevron" />                    <!-- chevron-right, rotate-90 when open -->
</div>
```

CSS rules:
- `.activity-row`: `position:relative; display:flex; align-items:center; gap:8px; height:32px;
  max-width:100%; cursor:pointer;` (claxedo keeps 32px rows).
- Verb: `color: var(--text-base); font-weight: 500;` Tail (single-line, `min-width:0; overflow:
  hidden; text-overflow:ellipsis; white-space:nowrap`): `color: var(--text-weak);`
  Nested deeper detail: `var(--text-weaker)`.
- **Hover gate** (mouse-only, mirroring D§3.3):
  `@media (hover:hover) { .activity-row:hover .activity-row__verb,
  .activity-row:hover .activity-row__tail { color: var(--text-strong); } }`
  Also apply on `.activity-row:focus-visible`.
- Chevron: `opacity:0; transition: opacity .15s, transform .3s;` → shown on
  `@media(hover:hover) .activity-row:hover`, `:focus-visible`, or `[aria-expanded="true"]`
  (then `transform: rotate(90deg)`).
- Icon: 16px, `color: var(--icon-weak)` — always muted, never brightens on hover (D§3.3).
- Overlay button: `position:absolute; inset:0; background:transparent;` with
  `:focus-visible { box-shadow: inset 0 0 0 1px var(--border-focus, var(--border-weak-base)) }`.
  Summary content `pointer-events:none` except real links/buttons
  (`.activity-row a, .activity-row button { pointer-events:auto }`).
- Transitions list exact properties only (F2). All colors via tokens (§2 rule 4).

**Steps**:
1. Create the two files above. Export `ActivityRow` with props
   `{icon?, verb, tail?, accessory?, expanded?, onToggle?, active?}`.
2. Add one storybook-free smoke usage: swap it into `BasicTool` behind no flag in T1 (next item) —
   do not wire features here.
3. `bun typecheck` from `packages/claxedo-app`.

**Acceptance**: row renders verb 500-weight + truncated tail; hover brightens both to
`--text-strong` and reveals chevron (mouse only); chevron rotated when `expanded`; focus-visible
shows inset ring; light theme shows equivalent dark-ink ladder.

### T0.2 `DiffStatMuted` — hover-gated diffstat

**Goal**: `+N −N` that is `--text-weaker` at rest and green/red only while its row is hovered
(D§3.5, D§5).

**Experience gain**: kills the permanent red/green noise that currently shouts from every edit
row (audit A2).

**Files**: `packages/ui/src/components/diff-changes.tsx` (add a `muted-hover` variant, keep
existing variants untouched); consumed later by T1/T8/T9.

**Steps**:
1. Add prop `variant?: "default" | "muted-hover"` (default keeps current behavior).
2. In `muted-hover`, wrap each counter in a span colored `var(--text-weaker)`; on
   `@media(hover:hover) .activity-row:hover &` (parent hover), color `var(--text-diff-add-base)` /
   `var(--text-diff-delete-base)`.
3. `tabular-nums` on the numbers (F1/F9).

**Acceptance**: at rest stats match surrounding muted text; on row hover they light green/red;
existing call sites unchanged.

### T0.3 Turn-collapse state store

**Goal**: session-scoped, per-turn fold persistence mirroring the existing `timelineCache`
pattern (`message-timeline.tsx:124` module Map, seeded into store at `:528`, written back with
max-16 eviction at `:711-714`).

**Files**: `packages/claxedo-app/src/features/session/ui/message-timeline.tsx` (extend cache
record `{measurements, toolOpen, turnFold: Record<userMessageID, boolean>}`), or better a small
new module `turn-fold-store.ts` next to it to keep the diff small.

**Steps**:
1. Create `turn-fold-store.ts`: `createTurnFoldStore(sessionKey)` exposing
   `isFolded(userMessageID)`, `setFolded(id, v)`, hydrate-from/evict-to the module cache exactly
   like `toolOpen`.
2. Default: `undefined` = "auto" (auto-fold logic in T5 decides; explicit user toggle wins).

**Acceptance**: fold state survives pane remount and session switching (16-session eviction).

---

## Phase 1 — Row language (WS1)

### T1. Rebuild `BasicTool` trigger on `ActivityRow`

**Goal**: every tool row (bash, edit, write, generic MCP) uses the T0.1 anatomy: muted icon,
verb, truncated tail, hover brighten, gated chevron. **Also render the registered icon** — the
`icon` prop exists but is never rendered (unused `.basic-tool-tool-indicator` CSS awaits it).

**Experience gain**: tool category readable at a glance; rows whisper (audit A1/A3; D§3.3).

**Backend**: ✅.

**Files**: `packages/session-ui/src/components/basic-tool.tsx:85` (trigger JSX),
`basic-tool.css`, `packages/session-ui/src/components/message-part.tsx` (registry entries pass
icons already — verify each `ToolRegistry` entry's `icon`; fill gaps: bash→`terminal`,
edit/write→`pencil-line`, read→`glasses`, glob/grep→`magnifying-glass`, list→`folder`,
webfetch/websearch→`window-cursor`, task→`subagent`).

**Steps**:
1. Replace the trigger internals with `ActivityRow` (keep Kobalte `Collapsible` behavior, open
   state, pending lock `basic-tool.tsx:178-182`).
2. Verb = existing title (keep `TextShimmer` while pending — T17 makes this nicer later);
   tail = existing subtitle + arg chips area, single-line truncated.
3. Delete the now-dead old trigger CSS; keep content-area styles.
4. Keep per-part `toolOpen` wiring untouched (`message-timeline.tsx:527`).

**Acceptance**: all existing tools render muted rows; chevron behavior identical gate as T0.1;
expanded content unchanged; `shellToolPartsExpanded`/`editToolPartsExpanded` settings still
respected; typecheck green; tool outputs still re-measure the virtual row on toggle
(`onSizeChange` path — verify `measureElement` still fires via the existing ResizeObserver).

### T2. Apply `DiffStatMuted` to edit/write/patch rows

**Files**: registry entries in `message-part.tsx` (`:2100` edit, `:2206` write, `:2266`
apply_patch) — swap `DiffChanges` → `variant="muted-hover"`; ensure their trigger has the
`activity-row` class ancestor so the parent-hover selector works.

**Acceptance**: at rest no red/green anywhere in collapsed rows; hover lights stats (D§5).

---

## Phase 2 — Grouping (WS2)

### T3. Unified grouping pass in the data layer

**Goal**: consecutive `bash`, `edit`, `write`, `apply_patch`, `webfetch`, `websearch` tool parts
fold into one group; **a single call stays a standalone row** (D§3.4, D§4 pass P). Existing
context group (read/glob/grep/list) keeps its behavior.

**Experience gain**: a 40-command turn costs 1–3 lines instead of 40 rows (audit B1).

**Backend**: ✅ (ordering guaranteed by ascending part id, `message-v2.ts:107`).

**Files**:
- `packages/claxedo-app/src/features/session/ui/message-timeline.data.ts` — `groupParts`
  (`:388-429`) is where groups are built today; `PartGroup` type + `sameGroup` live in
  `packages/session-ui/src/components/message-part.tsx:636,652` (duplicated logic — consolidate
  per audit I3: make `message-timeline.data.ts` the single owner, session-ui consumes the type).
- Group key: `work:${firstPart.id}`.

**Grouping rules** (mirror D§3.4 exactly):
1. Groupable: `bash`, `edit`, `write`, `apply_patch`, `webfetch`, `websearch` (+ existing context
   tools as today).
2. Break the group on: non-tool parts (text/reasoning), `TurnDivider`, question/task/error rows.
3. Only group runs of length ≥ 2.
4. Never group across user messages (already guaranteed — construction is per user message).

**Summary text** (header, mirroring D§3.4 segment rules): join with " · " — leading segment
sentence-case, followers lowercase: e.g. `Edited files · Ran 3 commands`, `Explored · 1 search`,
`Ran 2 commands · Searched the web`. Segments: counts per category (`Read {n} files`,
`Searched code`, `Ran {n} commands`, `Edited {n} files`, `Fetched {n} pages`); past tense when
settled, present-continuous while running (`Editing files · Running command`).

**Steps**:
1. Extend `PartGroup` union with `{type:"work", tool:"bash"|"edit"|..., refs, key}`.
2. Implement the greedy pass next to the context one in `groupParts`; interrupted-turn split
   around `TurnDivider` already exists — reuse.
3. Update `renderTimelineRow`/`AssistantPart` branch (`message-timeline.tsx:1172`,
   `renderAssistantPartGroup :1089`) to route `type:"work"` to T4's component.
4. Keep `key()` stable: `assistant-part:${userMessageID}:${group.key}` pattern already handles
   new keys.

**Acceptance**: 3 consecutive bash calls → one row; 1 bash alone → standalone row; text between
two bash runs → two groups; group header shows the segmented summary; virtualization keys stable
across streaming updates (no row flicker — `reuse()` in data.ts:158 keeps instance identity).

### T4. `WorkGroup` component

**Goal**: generalize `ContextToolGroup` (`message-part.tsx:1057`): collapsed by default; header =
icon (category of first item; edit icons win if any edit exists — D§3.4 icon priority), segmented
summary, gated chevron; expanded body = scrollable list of the grouped rows, **nested rows dimmer
and icon-less** (D§3.4).

**Experience gain**: one click reveals the full work detail; closed state stays one line.

**Files**: new `packages/session-ui/src/components/work-group.tsx` + `.css`; reuse
`AnimatedCountList`/rolling-count pattern from `ContextToolGroup` for live count changes.

**Spec**:
- Open state: local signal default `false`; on toggle call the `onSizeChange` prop (the
  virtualizer re-measures — same pattern ContextToolGroup uses).
- Expanded body: `max-height: 224px; overflow-y:auto;` with **edge fades**:
  `mask-image: linear-gradient(to bottom, transparent, black 24px, black calc(100% - 24px),
  transparent)` applied only when scrollable (add a `data-scrollable` attr toggled by a tiny
  `ResizeObserver`+scroll check; CSS scroll-driven `animation-timeline: scroll(self)` optional
  progressive enhancement).
- Nested rows: render `ActivityRow` with `data-nested` → icon hidden, colors one step weaker,
  left padding 8px (depth by dimming, not tree guides — D§8 rule 6).
- Body 4px row gap (`--conversation-grouped-item-gap` equivalent: just `gap:4px`).
- While any member runs: header verb shimmers (`TextShimmer`), and the running member's summary
  replaces the static tail (D§3.4 `active` header kind).

**Acceptance**: default collapsed; expand shows all member rows with dimmed nested style; body
scrolls with edge fades at 224px; live updates swap header summary (debounced ≥1/s to avoid
flicker — simple `setTimeout` throttle); reduced-motion disables shimmer.

---

## Phase 3 — Turn fold & time (WS3)

### T5. `TurnFoldRow` — "Worked for 2m 14s ›"

**Goal**: when a turn completes, its tool/group rows fold behind one divider row above the final
assistant text (D§3.6). Auto-fold on completion; user toggle persists via T0.3.

**Experience gain**: finished sessions read as Q→A pairs; the signature Codex behavior (audit B2).

**Backend**: ✅ durations (`User.time.created`, `Assistant.time.completed` — app already computes
`turnDurationMs` at `message-timeline.tsx:1046`). Final-answer detection 🟡: use the existing
heuristic (last text part of a settled assistant message, the `assistantCopyPartID` approach) —
fold trigger = *turn settled* (`session.status` idle) AND ≥1 foldable row exists. Good enough; no
backend change.

**Files**:
- `message-timeline.data.ts`: new row variant `TurnFold` — 5 touch points (row Map, class, union,
  `key()`, `is()`) per the integration map. Construct it in `constructMessageRows` where
  `DiffSummary` is decided (`:267-275` region): when the turn is settled and produced ≥2 foldable
  rows (groups + standalone tool rows), emit `TurnFold {userMessageID, durationMs, foldCount}`
  **instead of** those rows when folded; when unfolded, emit rows then the fold row as a divider
  at the end (like Codex: button + hairline rule, D§3.6).
- `message-timeline.tsx`: `renderTimelineRow` branch → new `TurnFoldRow` component.

**Component spec**:
- Row: full-width button (ActivityRow styling, no icon), label:
  - folded: `Worked for {duration}` + right chevron; unfolded: `Worked for {duration}` + down
    chevron. The row exists only once the turn completes; a running turn has no fold and no
    control (`turnFoldDecision` in `session-ui/src/components/turn-fold.ts`).
- Duration format (D§3.6): `<60s → "5s"`, `<1h → "2m 14s"`, else `"1h 22m 5s"`.
- Below the button: full-width hairline `border-top: 1px solid var(--border-weak-base)`.
- Fold/unfold: CSS height transition (measured px, F3); unfolded content re-enters with
  `opacity + translateY(-8px→0)` `.22s` (D§3.6); reduced-motion → opacity only.
- `tabular-nums` on the duration (F1/F9).

**Steps**:
1. Add the `TurnFold` variant + key `turn-fold:${userMessageID}`.
2. Build `TurnFoldRow` in `message-timeline.tsx` (mirrors `TurnDivider` JSX shape at
   `message-timeline.data.ts:185-201` + toggle + `onSizeChange`).
3. Wire T0.3 store: folded = `userChoice ?? (settled && foldCount>=2)`.
4. Verify prepend/windowing (`history-window.ts`) treats folded rows as one row.

**Acceptance**: complete a turn with 5 tool calls → they fold to one line automatically; click →
expand with chevron rotate + content reveal; reload → state remembered; turns with a single tool
call never fold; turn ending without text (tool-call-final) still folds (duration exists
regardless — fixes audit gap 17).

### T6. Live elapsed timers

**Goal**: running tool rows show "Running for 5s" in the tail (D§3.3, D§7). The fold row
does not exist while the turn runs, so it carries no ticker.

**Backend**: ✅ (`session.status` busy; `ToolStateRunning.time.start`).

**Files**: `basic-tool.tsx`/`ActivityRow` (tail slot while pending).

**Steps**:
1. One `createInterval(1000)` per visible running row, started only while `pending()` (dispose on
   settle — Solid cleanup).
2. Format shares the T5 duration formatter (extract to `format-duration.ts` in session-ui).
3. Keep the 1s tick text out of the layout-shift path: `tabular-nums`, no width jitter (F9).

**Acceptance**: running bash shows ticking seconds; on completion the ticker freezes and swaps to
the past-tense verb without layout jump.

### T7. Fold completed phases while the turn is still running — REJECTED

A turn the session is still working on never folds and shows no fold control; the fold and its
row appear only once the turn completes. `session.status` (busy/retry) and the post-idle
settle read decide "still working" — `AssistantMessage.time.completed` cannot, because a
multi-step turn completes its first assistant message while the session is still on it. The
`timelineFoldWhileRunning` setting that shipped this was removed with it.

---

## Phase 4 — File changes as artifacts (WS4)

### T8. Per-file edited rows (inside groups and patch accordions)

**Goal**: the D§3.5 anatomy: verb (`Edited`/`Created`/`Deleted`), dotted-underline basename
(`text-decoration: underline dotted 0.5px; text-underline-offset:2px`, tooltip = full path,
click opens file via `Platform.openPath`), right-aligned `DiffStatMuted`, status dot — 6px round,
blue for created (`var(--icon-info-base, currentColor)` fallback: use existing info/accent token),
red for deleted, none for modified.

**Experience gain**: file edits read as file-manager entries, not log lines (audit D1).

**Backend**: ✅ — per-file data from `metadata.filediff` (edit) and `metadata.files[]`
(apply_patch); `write` uses after-content (no diff stats — render without stats).

**Files**: registry entries in `message-part.tsx` (`:2100`, `:2206`, `:2266-2392`); new presentational
`EditedFileRow` in session-ui.

**Acceptance**: rows match anatomy; click opens the file; dot colors correct; stats hover-gated
(T0.2); rows nest dimmed inside T4 groups.

### T9. Turn file-changes card — Undo ⟲ / Review

**Goal**: replace `TimelineDiffSummaryRow` (`message-timeline.tsx:182-263`) chrome with the Codex
end-of-turn card (D§3.9): icon tile + "Edited N files" + aggregate `DiffStatMuted` + buttons
**Undo** and **Review**; body = first 3 file rows + "Show N more".

**Experience gain**: end-of-turn becomes actionable: one click to undo a whole turn's edits, one
to review them (audit D2).

**Backend**: ✅ — `POST /session/:id/revert {messageID, partID?}` + `POST /unrevert`
(git-snapshot based, `packages/opencode/src/session/revert.ts`); the app already wires revert for
user messages — reuse that path. Per-turn diffs: `User.summary.diffs` (+ `session.diff` event,
`GET /session/:id/diff?messageID=`).

**Files**: `message-timeline.tsx:182` (row component), server SDK calls already exposed via the
v2 client — find existing revert usage (grep `revert` in `packages/claxedo-app/src`) and reuse.

**Spec**:
- Card: `ActivityRow`-family chrome, `border: 0.5px solid var(--border-weak-base)`, radius =
  existing card radius (10px; inner buttons 6px — F6), padding 8px 12px.
- Undo button: ghost button, label `Undo` (toggles `Reapply` after success), `active:scale-[0.96]`
  (F-scale), disabled while pending; calls revert with the turn's user `messageID`; toast on
  success/failure (use existing toast utility — grep `toast` in claxedo-app).
- Review button: opens the existing per-file diff accordion body (current `TimelineDiffSummaryRow`
  expansion) — keep that body, cap default list at 3 files + `Show N more` toggle.
- Whole card click = toggle Review body; buttons `stopPropagation`.

**Acceptance**: undo a turn → git snapshot restores files, button flips to Reapply, toast
confirms; review shows ≤3 files then expands; works for turns whose diffs come from
`User.summary.diffs`; hidden when no changes.

### T10. Hover diff popover

**Goal**: hovering a file row (T8) for 800ms shows a floating diff preview (D§3.10).

**Experience gain**: review-at-a-glance without expanding anything (audit D3).

**Files**: new `DiffHoverCard` in session-ui (wrap row; Kobalte `Tooltip` with `delay=800`,
`skipDelayDuration≈500` for subsequent hovers); content = existing Pierre `<File mode="diff">`
(registered at `app.tsx:172`) in a bordered surface (`var(--background-stronger)`, hairline,
radius 10px, shadow = layered soft shadow — F-shadows), max-width `min(560px, 80vw)`, max-height
320px scroll.

**Acceptance**: 800ms hover → popover with highlighted diff; quick mouse-pass shows nothing;
subsequent hovers instant; Esc/leave dismisses; doesn't fight the virtualizer (popover in a
portal).

### T11. Right-click context menus

**Goal**: file rows/cards: `Open` · `Open with ▸` · `Copy path` · `Reveal in Finder`; assistant
text/user bubble: `Copy text` / `Copy markdown` (D§3.11, audit E2).

**Backend**: 🟡 — `Platform.openPath` + clipboard exist; **add `showItemInFolder`**: one Electron
IPC (`shell.showItemInFolder`) in `packages/claxedo-desktop` (mirror `main/ipc.ts:140`) + one
method on the `Platform` provider (`platform-provider.tsx:38-71`) with a web fallback (hide the
item).

**Files**: new `useFileContextMenu(path)` hook in session-ui or claxedo-app; wire on T8 rows, T9
card, message bubbles (`message-part.tsx:1173`).

**Acceptance**: right-click row → native-style menu; items work on desktop; web build hides
Reveal; menu items have 40px hit rows and icons from the sprite.

---

## Phase 5 — Subagents (WS5)

### T12. Subagent chips with deterministic identity

**Goal**: completed `task` parts render as chips (D§3.8): pill (`height:28px; rounded-full;
border:0.5px var(--border-weak-base); background: var(--surface-01, existing)`) + unique glyph +
name + status suffix (`updated`/`interrupted`/none when done); ≤3 chips + "and N other agents".

**Identity system** (deterministic, seeded by **child `sessionId`** — stable per agent, D§3.8):
- Hash: FNV-1a (`h=2166136261; h=(h*131+c)>>>0` — implement in 6 lines).
- Glyph: `hash % 10` → 1 of 10 tiny SVG shapes (new `AgentGlyph.tsx` in session-ui — simple
  geometric flower/gem paths, two-tone using existing `--task-agent-*` palette already computed
  at `message-part.tsx:367-450`).
- While the child is running: glyph gets a slow scan/pulse (CSS keyframes, reduced-motion gated).

**Experience gain**: parallel agents become legible, memorable actors instead of identical cards
(audit G1/G2).

**Backend**: ✅ (`state.metadata.sessionId`, `input.subagent_type/description`; child status via
same session APIs).

**Files**: `message-part.tsx:1925-2027` (task renderer) — keep the full card for a *single* task
in a turn; render chips when ≥2 task parts exist in one turn (group them via T3 pass with
`type:"agents"`, or simpler: consecutive task parts fold into a chip row).

**Acceptance**: 3 tasks → 3 chips with distinct glyphs/colors, stable across reloads; running chip
animates; interrupted shows suffix; overflow label works.

### T13. Chip click → child preview beside the timeline

**Goal**: clicking a chip opens the child session without losing the parent context (D§3.8:
side-panel tab). Claxedo equivalent: open the child session in a **split pane tab** using the
existing workbench (`state.layout.openSession` already navigates, `session-content.tsx:138`) —
preferred: open in a right-hand pane; fallback: current navigation.

**Experience gain**: parent thread keeps focus; reviewing a subagent is one click, one glance
(audit G3).

**Extras**: chip tooltip shows child diff stats (sum of `User.summary.diffs` across the child
session — client-side sum, 🟡 note in matrix) + status (`Running`/`Done`/`Interrupted`).

**Acceptance**: click opens child in adjacent pane (when layout supports) with parent intact;
tooltip shows `+N −N`; keyboard-focusable chip with inset focus ring.

---

## Phase 6 — Markdown upgrades (WS6)

### T14. Mermaid rendering

**Goal**: ```mermaid fences render as themed diagrams (D§3.12).

**Experience gain**: architecture/diagram answers become visual, not code (audit F1).

**Backend**: ✅ — **the app already ships `platform.renderMermaid`** (verify its signature in
`packages/claxedo-app/src/platform/*`; the web platform likely needs the mermaid lazy import —
reuse whatever exists before writing anything new).

**Spec**: lazy-load on first mermaid block; theme from claxedo CSS vars (probe `getComputedStyle`
for surface/text/border tokens at render time — same trick as Codex); `securityLevel:"strict"`;
on error → fall back to the plain code block (never mermaid's own error graphics); click →
existing image-preview dialog or a simple zoom overlay; progressive render while the fence is
still open during streaming (language prefix match).

**Files**: `packages/session-ui/src/components/markdown.tsx` code-block dispatch
(`:188-232` region) + new `mermaid-block.tsx`.

**Acceptance**: flowchart + sequence render themed in dark and light; broken source falls back to
code block; streaming partial fence doesn't crash; worker/shiki path untouched.

### T15. Inline-code pill — delete the dead fork

**Goal**: inline code gets the pill always: `padding:1px .3rem; border-radius:.25rem; box-shadow:
inset 0 0 0 0.5px var(--border-weak-base); background: var(--surface-01)` (or the values already
in `markdown.css:225-250` re-expressed on legacy tokens); `.875em`; weight 500 (D§3.12).

**Experience gain**: code references read as objects, like `.notion-page-shell` in the
screenshots (audit F2).

**Files**: `packages/session-ui/src/components/markdown.css` — move the pill rules out of the
`[data-new-layout]` gate into the base inline-code rule; delete the dead fork and the
`body[data-new-layout]` selector (also `markCodeLinks` gating in `markdown.tsx:278` — enable
unconditionally, T16 depends on it).

**Acceptance**: pill visible in app (dark+light); no visual change for plain-text inline code
color; `data-new-layout` references gone from markdown.*.

### T16. `@path` / file-link chips in assistant markdown

**Goal**: `@src/foo.ts` and `[label](relative/path)` in assistant text render as chips that open
the file (D§3.12 decorations).

**Files**: `markdown.tsx` `markCodeLinks` (`:234-261`) — enable (T15), add click →
`Platform.openPath` with cwd resolution (the markdown component already has session context —
check props; if not, pass `cwd` from `MessagePart`).

**Acceptance**: `@path` chip click opens file; broken paths render as plain code; chips use the
T15 pill + dotted underline.

---

## Phase 7 — Indicators & polish (WS8)

### T17. Shimmer running verbs
`basic-tool.tsx` + `WorkGroup` headers: wrap pending verbs in `TextShimmer` (`active={pending()}`)
— mostly wiring, component exists (`@opencode-ai/ui/text-shimmer`). Gain: running work is
findable while scrolling (audit H2).

### T18. "Thought for Ns" reasoning row
`message-part.tsx:1705` (ReasoningPartDisplay): replace all-or-nothing with a collapsed
`ActivityRow` (brain icon, `Thought for {duration}` from `time.end-start`, shimmer `Thinking…`
while live) expanding to the muted 13px markdown. Keep the `showReasoningSummaries` setting but
change default to **on** (settings pattern, Phase 3 T7 note). Gain: thinking becomes an
affordance, not a wall (audit B5).

### T19. Compaction marker upgrade
`MessageDivider` usage for compaction (`message-part.tsx:1579`, `message-timeline.data.ts:185`):
add icon + label `Context automatically compacted`; when backend lands the two optional ints
(`CompactionPart.tokensBefore/After` — add to schema `packages/schema/src/v1/session.ts`
CompactionPart + populate in `packages/opencode/src/session/compaction.ts`), show
`Context compacted · 128k → 4k`. Gain: trust in long sessions (audit C4).

### T20. Bash output scroll affordance
`message-part.css:358-406`: replace `scrollbar-width:none` with thin transparent-track scrollbars
visible on hover; add top/bottom edge fades (mask, only when scrollable — same technique as T4);
add a small `Expand` affordance (chevron) to lift the 240px cap to 480px. Gain: scrollability is
discoverable (audit H4).

### T21. Dot-wave jump-to-bottom while busy
`message-timeline.tsx:1404-1426`: when `session.status` busy and user is scrolled up, swap the
arrow for three 4px dots with staggered 1s translateY wave (D§3.6 #13); reduced-motion → static
dots. Gain: activity visible from anywhere (audit H3).

### T22. (Optional) Turn token footer
In the T5 fold row accessory slot: `12.4k tokens · $0.03` from `Assistant.tokens/cost`, muted,
`tabular-nums`. Gain: cost awareness inline (audit C3). Behind settings flag
`timelineShowTurnTokens`, default off.

### T23. (Optional) Dev-server row
When a bash call's `state.output` matches `/listening|Local:|localhost:(\d+)/`, render an
`ActivityRow` (icon `window-cursor`) `Local preview · 127.0.0.1:3000` that opens via
`Platform.openLink`. No backend change; pure client regex over retained output. Gain: the
Codex "Browser 127.0.0.1:4455" moment.

### T24. (Optional) Inline permission/question cards
Render `permission.asked` / `question.asked` at the anchored tool part (`tool.{messageID,callID}`)
instead of composer-only; keep composer docking as fallback. Data exists; wire SSE events
(`event-ingress.ts:60-78`) into a per-part lookup. Gain: prompts appear where the work is.

---

## 4. Sequencing & effort

| Phase | Items | Net effect | Suggested size |
|---|---|---|---|
| 0 | T0.1–T0.3 | primitives | S |
| 1 | T1–T2 | **visual calm everywhere** | M |
| 2 | T3–T4 | **sessions shrink 5–10×** | M |
| 3 | T5–T7 | **the signature turn fold** | M |
| 4 | T8–T11 | artifacts feel like files | M–L (T11 has the desktop IPC) |
| 5 | T12–T13 | parallel work legible | M |
| 6 | T14–T16 | prose polish | S–M |
| 7 | T17–T24 | compounding feel details | S each |

Phases 1–3 are the 80/20 and are purely client-side. Phase 4 needs the one-line desktop IPC
(T11). Phase 5 needs only client work (T13's diffstats are a client-side sum). Nothing requires
server schema changes except optional T19 (two optional ints).

## 5. Global acceptance checklist (run after each phase)

- [ ] `bun typecheck` green from `packages/claxedo-app`
- [ ] Dark + light themes both show the muted ladder correctly (token-resolved, no raw alphas)
- [ ] Long session (≥10 turns, ≥30 tool calls): folds to mostly prose + group lines; scroll
      anchoring intact; no virtualizer flicker when groups toggle (rows re-measure via
      `onSizeChange`/ResizeObserver)
- [ ] Session reload: fold states, group states, per-part open states all restored
- [ ] Running turn: shimmer verbs, ticking elapsed, every row visible and no fold control
- [ ] `prefers-reduced-motion`: no shimmer/spinner/wave animations
- [ ] No `transition: all` introduced; all new animations are opacity/transform/measured-height
- [ ] Storybook: add/update stories for `ActivityRow`, `WorkGroup`, `TurnFoldRow`, `DiffHoverCard`,
      `AgentGlyph` (storybook is the one place `data-new-layout` exists — verify new components
      don't depend on it)
