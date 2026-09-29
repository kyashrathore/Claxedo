# Claxedo Session Timeline — Audit vs the Codex Design Language

Audit of `packages/claxedo-app`'s session timeline against
[`CODEX_TIMELINE_DESIGN.md`](./CODEX_TIMELINE_DESIGN.md). Every finding cites the Codex pattern
(doc section) and the claxedo code it maps to. Severity:

- **P0** — defines the feel; users notice within seconds
- **P1** — structural; changes how much work the timeline hides
- **P2** — polish; compounds the first two

Current claxedo architecture (surveyed 2026-07-18): `session-screen.tsx` → `MessageTimeline`
(`message-timeline.tsx:276`) → flat `TimelineRow[]` (`message-timeline.data.ts:158`) → parts via
`@opencode-ai/session-ui` (`message-part.tsx`, `basic-tool.tsx`). Solid virtualization, windowing,
context-tool grouping, and turn-end diff accordion already exist.

---

## A. The muted visual language (P0)

The single biggest difference. Codex work rows whisper at 40–60% opacity and only brighten at the
pointer; claxedo rows speak at full volume.

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| A1 | Verb/trailing split: verb `#ffffff73`, detail `#ffffff4d`, hover → 100% (doc §3.3) | `BasicTool` trigger = title medium `--text-strong` + subtitle muted (`basic-tool.css`), one flat tone per row, no hover brightening ladder | Tool rows read as loud as prose. Introduce a 3-step muted ladder (verb 70% / detail 40% / hover 100%) |
| A2 | Diffstats muted at rest, green/red **only on row hover** (doc §3.5) | `DiffChanges` (`packages/ui/src/components/diff-changes.tsx:3`) renders `+N` green / `−N` red permanently | Permanent red/green shouts from every edit row. Gate color behind `group-hover`, inherit muted at rest |
| A3 | Icons always present but deeply muted (`icon-xs`, placeholder-fg color) (doc §3.3) | Tool rows are **text-only** — `BasicTool` never renders the registered `icon` prop (survey §3, gap 4) | Rows are indistinguishable by category at a glance. Render the registered icons at muted tone |
| A4 | Chevron invisible until hover/focus, mouse-gated (`@media(hover:hover)`) (doc §3.3) | Chevron hover-only too (`collapsible.css`) — this one matches; keep it | ✅ parity |
| A5 | Row height 36px (`h-9`), pill rows, 16px item gap (doc §2) | 32px rows, `gap: 12px` content stack, 24px turn gap (survey §8) | Minor density delta; fine after A1–A3 land |

## B. Collapse & grouping hierarchy (P0)

Codex compresses work at three levels (row → group → turn). Claxedo compresses at one (row, for
context tools only).

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| B1 | Consecutive `exec`/`patch`/`web-search` calls fold into one group line ("Edited files · Ran 3 commands"), collapsed by default, single calls stay standalone (doc §3.4) | Only `read`/`glob`/`grep`/`list` group (`CONTEXT_GROUP_TOOLS`, `message-part.tsx:614`); bash/edit/write sequences render as individual 32px rows | A 40-command turn costs 40 rows in claxedo vs 1–3 lines in Codex. Extend grouping to bash/edit/write/web with the same summary-segment rules |
| B2 | **Whole turn auto-collapses** the moment the final answer starts streaming → "Worked for 1h 22m 5s ›" + hairline rule; override remembered per session (doc §3.6) | Nothing collapses on completion (`message-timeline.data.ts` has no turn-fold row); tool rows stay as-is forever | The defining Codex behavior. Add a turn-fold row above the final assistant text, default-collapsed, per-turn session-scoped state |
| B3 | In-progress turns fold *completed phases* behind summaries; only the live phase is visible (doc §4, pass P) | All rows of the running turn stay expanded/visible as they were emitted | Long running turns drown the screen. Fold earlier slices once a new assistant text boundary passes |
| B4 | Group expanded body: 224px scroll, scroll-driven edge fades, nested rows dimmer + icon-less (doc §3.4) | `ContextToolGroup` expands to summary rows (`message-part.tsx:1057`); no fade mask, no second-level muting | Cheap polish once B1 exists |
| B5 | Reasoning collapses to "Thinking" shimmer; completed thinking is not rendered as prose block | Reasoning renders fully expanded when `showReasoningSummaries` is on (default **off**, `settings/provider.tsx:116`) | Add collapsed "Thought for Ns" row instead of all-or-nothing |

## C. Turn metadata & time (P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| C1 | Durable per-turn divider: "Worked for 1h 22m 5s", ticking "Working for …" while live, "You stopped after …" (doc §3.6) | Duration appears only as tiny meta `Agent · Model · 12s` under the **last text part** (`message-part.tsx:1615`); turns ending in a tool call show nothing (survey gap 17) | Move duration to the turn-fold row (B2) — one canonical place, always present |
| C2 | Live elapsed on running tool rows ("Running command for 5s") (doc §3.3) | Static shimmer only; no ticking anywhere in rows | 1s interval on the running row subtitle |
| C3 | Token/context meter exists per turn (`token_count` events; not shown in timeline either) | Tokens only in separate context tab (`session-context-tab.tsx:237`) | Parity — optional per-turn token footer, P2 |
| C4 | Compaction row: icon + "Context automatically compacted", breaks groups (doc §3.7) | `MessageDivider` "Compacted" line (`message-part.tsx:1579`) | Near-parity; add icon + token delta, P2 |

## D. File changes & diffs (P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| D1 | "Edited files" group with per-file rows: dotted-underline basename, `+N −N` tabular-nums, blue dot for created, red for deleted (doc §3.5) | Edit/write rows show filename + `DiffChanges`; `apply_patch` multi-file shows per-file accordions (`message-part.tsx:2310`) | Restyle per-file rows to the Codex anatomy (verb + dotted link + right-aligned muted stats + status dot) |
| D2 | End-of-turn **file-changes card**: icon tile, "Edited N files", **Undo ⟲ / Review** buttons, 3-file cap + "Show more" (doc §3.9) | `TimelineDiffSummaryRow` (`message-timeline.tsx:182`): sticky "N changed files" + accordion (max 10) — good bones, no actions | Add Undo/Reapply (server already has revert capability? verify) and Review → side diff view; cap at 3 files + expander |
| D3 | **800ms hover diff popover** on file rows, highlight cache primed on first hover (doc §3.10) | Hover shows nothing; expanding mounts the full Pierre diff inline | Add hover preview popover; keep inline expand for click |
| D4 | Expanded diff: 100px short / 240px full, header bar with copy-unified-diff, editor-background body (doc §3.5) | Pierre `<File mode="diff">` in accordion — visually heavier, no height tiers | Tier the heights; add copy-diff button |
| D5 | Diff viewer 12px mono, 21.6px line-height, rolling-digit stats (doc §6) | Pierre defaults | P2 polish |

## E. Cards, links & context menus (P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| E1 | **Document/website resource cards** at end of turn: icon tile, title, type subtitle that swaps on hover, "Open in ⌄" app menu, drag-out (doc §3.9) | No resource cards anywhere; attachments render only as message chips | Detect file-producing turns (write/create) and emit resource cards with an Open-in menu |
| E2 | Right-click menus on file rows/cards: Open / Open with ▸ / Copy path / Copy contents / Reveal in Finder (doc §3.11) | **Zero context menus in the timeline** (survey gap 9) | Add one `onContextMenu` builder for file rows + user/assistant messages (copy text, copy markdown) |
| E3 | Link rendering: underlined text links; website preview cards from local HTML; `@path` chips; `#rrggbb` swatches (doc §3.12) | Plain external links (`marked.tsx:526`); no previews; `@file` highlights exist in user messages only | Add `@path`/file chips in assistant markdown; website card is P2 |
| E4 | Localhost URLs surface in Browser section with favicon + `host:port` (doc §3.14) | No treatment (survey gap 8); `lib/url.ts` normalization is server-identity only | When a bash call starts a dev server, surface a "127.0.0.1:port" row/card that opens the preview |
| E5 | Double-click user bubble → edit & re-send (doc §3.1) | Hover copy/revert on hover meta (`message-part.tsx:1296`) | Near-parity; keep |

## F. Markdown, code, mermaid (P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| F1 | **Mermaid first-class**: lazy mermaid 11, theme vars probed from app CSS, progressive render while streaming, strict security, plaintext fallback, click-to-zoom (doc §3.12) | Mermaid = plain code block (`markdown-inline-code-kind.ts:706` lists the token only) | Add lazy mermaid renderer themed from claxedo CSS vars, with plaintext fallback |
| F2 | Inline code = dark pill (`inset ring + alpha-10 bg`, .875em, weight 500) (doc §3.12) | Legacy layout styles inline code as colored text, no pill; pill exists only under `data-new-layout` which **the app never sets** (`markdown.css:225-250`, survey gap 8) | Dead styling path. Either ship the pill unconditionally or port it to legacy tokens |
| F3 | Code block: bordered card + ghost copy top-right, no header (doc §3.12) | Same shape already (`markdown.tsx:188`, hover copy, no header) | ✅ parity |
| F4 | Streaming markdown smoothing (SmoothedMarkdown/ClipText) | `PacedMarkdown` chunked reveal + morphdom block cache (`markdown.tsx:322-355`) | ✅ parity (claxedo's is arguably stronger) |
| F5 | Syntax highlight: Prism, 25 languages | Shiki in a web worker ("OpenCode" theme) | ✅ parity |

## G. Subagents (P1)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| G1 | Timeline **chips**: gem glyph + name + status suffix ("updated"), 3 + "and # other subagents", entrance animation (doc §3.8) | One agent-tinted card per `task` part (`message-part.tsx:1925`, `--task-agent-*` palette) | Convert completed task parts into chips when several spawn in one turn |
| G2 | **Deterministic identity**: hash(conversationId) → 1 of 10 gradient glyphs + 1 of 5 colors; pixel identicon with scan animation while active (doc §3.8) | Per-agent color hash exists (`:367-450`) but no glyph/identicon system | Add the two-layer identity (glyph for chips, identicon for panel/tab) |
| G3 | Chip click → **side-panel tab** showing the child agent's thread, hydrated on demand (doc §3.8) | Click navigates away to the child session pane (`directory-scope.tsx:64`) | Add a right side-panel (or pane tab) preview so the parent timeline keeps focus |
| G4 | Side panel "Subagents" section: avatar group + "48 done", per-agent DiffStats, auto-collapse (doc §3.8) | Environment card (`SessionEnvironmentCardMount`) has no subagents section | Add section with counts + per-agent diffstats |
| G5 | Turn refuses to auto-collapse while any subagent runs (doc §3.6) | n/a (no turn collapse yet) | Bake into B2 |

## H. Working indicators & scroll (P2)

| # | Codex pattern | Claxedo today | Gap |
|---|---|---|---|
| H1 | Spinner: two-arc ring, randomized negative delay (doc §3.13) | Header spinner + 2px progress whip (`message-timeline.tsx:1458`) | Near-parity; desync multiple spinners |
| H2 | Text shimmer for running verbs, 2s steps(48) | `TextShimmer` "Thinking…" exists (`message-timeline.tsx:169`) | Extend shimmer to running tool verbs |
| H3 | Jump-to-bottom FAB swaps to 3 waving dots while busy (doc §3.6) | Static jump button (`message-timeline.tsx:1404`) | Add the dot-wave state |
| H4 | Scroll-driven edge fades on scrollable regions (`animation-timeline: scroll(self)`) | Hidden scrollbars in bash output (`scrollbar-width: none`), no fades, 240px cap with no expand affordance (survey gap 12) | Show scroll affordance: edge fades + visible-on-hover thin scrollbar + expand control |
| H5 | Follow pinning with 24px threshold + response spacer (doc §4) | `createAutoScroll` + gesture boundaries + settle loop | ✅ parity (claxedo's is more elaborate) |
| H6 | Virtualized turns with height placeholders | `@tanstack/solid-virtual` rows + measurement cache + history windowing | ✅ parity |

## I. Structural debt that blocks the above

| # | Issue | Where | Why it matters |
|---|---|---|---|
| I1 | **Dual token systems** (legacy `--text-*` vs `--v2-*`) with `data-new-layout` forks that the app never activates | `basic-tool.css:302`, `markdown.css:310`; dead path `markdown.tsx:278` | Every styling change must be made twice or lands in a dead branch. Pick one (recommend: activate v2 tokens or delete the forks) before A1–A5 |
| I2 | v2 component set unused (`session-ui/src/v2/*`) | `session-ui/src/v2/` | Either adopt or remove; don't build new rows on the legacy `BasicTool` if v2 is the future |
| I3 | Grouping logic duplicated | `message-timeline.data.ts:388-429` and `message-part.tsx:670-712` | B1 must consolidate to one grouping pass that emits render units (like Codex's `w/P/D/E` pipeline) |
| I4 | Todos fully hidden (`HIDDEN_TOOLS`) | `message-part.tsx:615` | Codex renders plan/todo as a document card; consider a collapsed "Plan" row instead of hiding |
| I5 | Permission/question prompts dock at composer, not inline | survey gap 14 | Inline prompt cards at the point of occurrence (Codex renders question cards in-flow) |

---

## What claxedo already does well (keep)

1. Virtualization + history windowing + prepend anchoring — stronger than needed, keep.
2. Context-tool grouping with animated counts — exactly the Codex group pattern; extend it.
3. Collapsed-by-default tools with per-part persistence across remounts.
4. Turn-end diff accordion (sticky header, per-file Pierre diffs) — good bones for D2.
5. Worker-based streaming markdown with block reuse and paced reveal.
6. Agent-color tinting infrastructure (`--task-agent-*`, `agent-color.ts`) — the seed for G2.

## Recommended workstreams (priority order)

| WS | Scope | Touches | Unlocks |
|---|---|---|---|
| **WS1 — Muted row language** | A1–A3, I1: one token system, verb/detail ladder, hover brighten, muted icons, hover-gated diffstat colors | `basic-tool.tsx/.css`, `diff-changes.tsx`, `collapsible.css`, theme tokens | Instant visual calm; the "Codex feel" |
| **WS2 — Grouping pass** | B1, I3: single unit pipeline grouping bash/edit/write/web; summary segments ("Edited files · Ran 3 commands"); lone calls stay standalone | `message-timeline.data.ts`, new `timeline-units.ts`, `ContextToolGroup` generalization | Sessions shrink 5–10× |
| **WS3 — Turn fold + worked-for** | B2, B3, C1, C2, G5: turn-collapse state machine, ticking divider, live elapsed | `message-timeline.data.ts`, `message-timeline.tsx`, new `TurnFoldRow` | The signature behavior |
| **WS4 — File-change card + rows** | D1–D4, E2: per-file row anatomy, Undo/Review actions, 3-cap expander, hover diff popover, context menus | `message-part.tsx` (edit/write/patch), `message-timeline.tsx:182`, new `FileChangeCard`, `DiffHoverCard`, `useFileContextMenu` | Artifacts feel like files |
| **WS5 — Subagent chips + panel** | G1–G4: chips, deterministic glyph/identicon, side-panel tab, subagents section | `message-part.tsx:1925`, new `SubagentChip`, `Identicon.tsx`, environment card | Parallel work becomes legible |
| **WS6 — Markdown upgrades** | F1, F2, E3: mermaid renderer, inline-code pill (kill `data-new-layout` fork), `@path` chips | `markdown.tsx/.css`, new `mermaid.tsx` | Prose polish |
| **WS7 — Resource cards + localhost** | E1, E4: end-of-turn resource cards, Open-in menu, dev-server preview row | new `ResourceCard`, bash output parser for listening ports | OS-like artifact handling |
| **WS8 — Indicator polish** | H2–H4: shimmer verbs, dot-wave FAB, edge fades + scroll affordance | `message-timeline.tsx`, `basic-tool.css` | Feel details |

WS1–WS3 are the 80/20: they change how every session reads. WS4–WS5 change how artifacts and
parallelism read. WS6–WS8 are compounding polish.
