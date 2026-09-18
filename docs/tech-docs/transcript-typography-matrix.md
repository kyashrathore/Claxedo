# Transcript typography matrix

Every text-bearing element of a session transcript, the `--transcript-*`
variable that sets each of its properties, and the value the stylesheet falls
back to when no pairing or theme names that knob. The catalogue of knobs, with
ranges and shipped fallbacks, is `TRANSCRIPT_NUMBERS` / `TRANSCRIPT_COLORS` in
`@opencode-ai/ui/theme/transcript-typography.ts`; a pairing is a set of knob
values, a theme names a pairing (and may override knobs) in its `transcript`
block, and the rail's dev panel picks a pairing. Nothing in the transcript is
pinned: a cell that names a knob moves with the theme.

The app runs the legacy branch (`body:not([data-new-layout])`), so where
`markdown.css` and `message-part.css` fork on that attribute the legacy rule is
the one listed. Values are the fallbacks; the `Cursor` and `Codex` columns are
what those pairings set. **Default is Cursor's measurements**, so a theme that
names no pairing (every theme but Codex) reads as Cursor; the Codex theme
reads as Codex.

## 0. Legend

| Token | Value | Token | Value |
|---|---|---|---|
| `--font-size-small` | 12px | `--line-height-normal` | 130% |
| `--font-size-compact` | 13px | `--line-height-large` | 150% (21px @14) |
| `--font-size-base` | 14px | `--line-height-relaxed` | 1.6 (22.4px @14) |
| `--font-size-title-small` | 17px | `--line-height-20` | 20px |
| `--font-weight-regular` | 400 | `--font-weight-medium` | 500 |
| `--font-weight-semibold` | 600 | `--letter-spacing-normal` | 0 |
| `--font-family-sans` | theme sans (`ui-sans-serif, system-ui, …`; Codex theme: `-apple-system, "SF Pro Text", …`) | `--font-family-mono` | `ui-monospace, SFMono-Regular, Menlo, …` |
| `--text-strong` (Codex theme) | #1a1c1f light / #f2f2f2 dark | `--text-base` / `--text-weak` | #696a6c (both, light) — the tool-row grey |

Knobs (`--transcript-*`, written on the timeline root by
`transcriptTypographyStyle`): `font-size`, `line-height`, `letter-spacing`,
`body-weight`, `bold-weight`, `prose-color`, `font-family-body`
(+ rescoped `--font-family-sans`), `font-family-heading`, `--font-family-mono`,
`h1..h3-{size,weight,top,bottom,tracking}`, `heading-line-height`,
`paragraph-gap`, `block-gap`, `list-gap`, `list-indent`, `inline-code-{size,
family,weight,padding,ring,bg}`, `code-font-size`, `hr-{height,margin}`,
`measure`.

Pairing values used below — Cursor: 14px, 22/14 leading, 400, soft colour,
p 16, block 16, list gap 8, indent 28, inline code .9em tint, code 13, hr 1px,
headings 17/17/16 @590. Codex: 14px, 1.625, **430**, soft colour, p 14,
block 14, list gap **0**, indent 23, code 13, hr 1px, headings
21/17.5/15.75 @600.

## 1. Markdown elements (`.ui-markdown`, `session-ui/src/components/markdown.css`)

| Element | Family | Size | Weight | Line-height | Colour | Spacing around | Knob | Cursor | Codex |
|---|---|---|---|---|---|---|---|---|---|
| Prose root / `p` text | body face → `--font-family-sans` | 14 | 400 (inherits root) | 1.6 | `--text-strong` | — | size, line-height, tracking, body-weight, prose-color, body face | 22/14 lh, soft | 430, 1.625, soft |
| `p` | | | | | | mb `paragraph-gap` 6; first/last child 0 | paragraph-gap | 16 | 14 |
| `h1` | heading face → inherit | 14 (flat) | 500 | 150% | prose colour | mt 28 / mb 12 | h1-* (scale) | 17/590, 20.5/4, lh 1.25 | 21/600, 0/7 |
| `h2` | inherit | 14 | 500 | 150% | prose colour | mt 24 / mb 10 | h2-* | 17/590, 20.5/4 | 17.5/600, 14/3.5 |
| `h3` | inherit | 14 | 500 | 150% | prose colour | mt 20 / mb 8 | h3-* | 16/590, 20.5/4 | 15.75/600, 14/3.5 |
| `h4`–`h6` | inherit | 14 (legacy override of 13) | 500 | 150% | prose colour | mt 20 / mb 8 | h4-* (scale, 4th level) | 16/590 | 14/600 |
| `strong`, `b` | | | `bold-weight` 600 | | prose colour | — | bold-weight, prose-color | | |
| `em` | | | | | | — | browser italic, **fixed** | | |
| `a` | | | inherit | | `link-color` \| `--text-interactive-base`; `link-decoration` none, hover `link-hover-decoration` underline | — | linkColor, links | | |
| inline `code` (pill) | `inline-code-family` → mono face | `inline-code-size` .8em (11.2px) | 500 | inherits | prose colour | padding 1px .3rem, radius sm, ring inset .5px `--border-weak-base`, bg `--text-base` @ 8% | inline-code variant, inline-code-size, mono face | .9em, tint (no ring, 400) | pill |
| inline `code` variants | tint = no ring, 400 · quiet = + no bg/padding · plain = + inherit family/weight | | | | | | inlineCode knob | | |
| `code[data-inline-code-kind="path"]` | as above | | | | hover: dotted .5px underline, `--text-strong` | cursor pointer | **fixed** | | |
| `a.external-link > code` (url) | as above | | | | underline coloured `--border-weak-base` | no bg, no ring | **fixed** | | |
| `ul`, `ol` | | | | | | mt `block-gap`\|8 · mb `block-gap`\|12 · padding-left `list-indent` 32 (ol +4) · outside markers | block-gap, list-indent | 16 / 28 | 14 / 23 |
| `li` | | | | | | mb `list-gap` 8; `li > p:first` inline; `li > p + p` mt `paragraph-gap` \| 8 | list-gap, paragraph-gap | 8 | **0** |
| `li::marker` | | | | | `marker-color` \| `--text-weak` | | markerColor | | |
| nested `li > ul/ol` | | | | | | mt/mb .25rem · padding-left `nested-list-indent` 16 (ol +12) | nestedListIndent | 28 | 23 |
| task-list `li` + checkbox | | | | | | no marker; checkbox absolute top 4 / left −20 | **fixed** | | |
| `blockquote` | | | | | `--text-weak`, normal style | border-left `quote-border` 2 `--border-weak-base` · margin `block-gap`\|1rem 0 · padding-left `quote-indent` 8 | block-gap, quoteBorder, quoteIndent | 16 | 14 |
| `hr` | | | | | bg `--border-weak-base` | height `hr-height` **0** · margin `hr-margin` 32 | rules knob | 1px / 24 | 1px / 24 |
| `pre` | | | | | | mt `block-gap`\|12 · mb `block-gap`\|24 · own scrollbar hidden | block-gap | 16/16 | 14/14 |
| `.shiki` code block | `--font-family-mono` → mono face | `code-font-size` 13 | 400 | inherits prose ratio (1.6 → 20.8px @13) | `--text-base` on `--background-stronger` | padding `code-padding` 12 · radius md · border .5px `--border-weak-base` · line-height `code-line-height` \| inherit | code-font-size, codePadding, codeLineHeight, mono face | 13 | 13 |
| shell code block (`data-code-kind="shell"`) | as `.shiki` | | | | `--markdown-shell-code-*` (layer-02 bg, muted border, tokens `currentColor`) | | **fixed** colours | | |
| `table` | | `font-size` 14 | | | | wrapper margin `block-gap`\|16 0 · width max-content | size, block-gap | 16 | 14 |
| `th` | | | `table-head-weight` 500 | | `--text-strong`, bg layer-01 | padding `table-cell-padding` 12 · border-bottom 1px `--border-weak-base` | tableHeadWeight, tableCellPadding | | |
| `td` | | | | | | padding `table-cell-padding` 12 · border-bottom 1px `--border-weaker-base` | tableCellPadding | | |
| images | — | — | — | — | — | 80×80 tile, radius sm, .5px border, margin .25rem | **fixed** | | |
| rich block rail (`[data-markdown-rich]`) | | | | | .5px rule `--v2-border-border-muted` | padding-top 24 | **fixed** | | |

Line-length: `--transcript-measure` caps the column (shipped 48rem, 880px from
2xl); no pairing pins it.

## 2. Your messages (`.ui-user-message`, `message-part.css`)

| Element | Family | Size | Weight | Line-height | Colour | Spacing / box | Knob |
|---|---|---|---|---|---|---|---|
| Message text (`.ui-user-message-text`) | `--font-family-sans` (rescoped by body face) | `font-size`\|14 | `body-weight`\|400 | `line-height`\|150% | prose colour \| `--text-strong` | bubble: bg layer-02 (Codex theme: `--surface-user-message`), padding 8px 12px, radius xl, max-width min(82%, 64ch) | size, leading, tracking, weight, colour, face |
| Message rendered as markdown (`[data-markdown]`) | inherits `.ui-markdown` table above | | | | | width min(92%, 900px) | as §1 |
| `[data-highlight="file"]` / `"agent"` spans | | | | | `--syntax-property` / `--syntax-type` | | **fixed** |
| Attachment name | | `meta-size` 12 | | `meta-line-height` 150% | `--v2-text-text-muted` | chip: radius md, bg layer-02, .5px border; image 58×46, file 220×48 | metaSize, metaLineHeight |
| Meta line (time · model) | | 12 (`text-12-regular`) | 400 | 18px | `--text-weak` | mt 4, gap 10, shown on hover | **fixed** |
| Queued message | same as message text at 60% opacity | | | | | | as above |

## 3. Turn structure and spacing (`session-turn.css`, `message-timeline.tsx`)

| Element | Value | Knob |
|---|---|---|
| Between turns (`TurnGap` row) | `turn-gap` 24 | turnGap |
| Between consecutive assistant parts | `part-gap` 12 (row padding-top and `session-turn-assistant-content` gap) | partGap |
| Text part (`.ui-text-part`) | margin-top `text-part-top` 24 (body 0); copy row mt 4, min-height 24, hover-only | textPartTop |
| Thinking row (`session-turn-thinking`) | sans 14 / 500 / 20px, `--text-weak`; heading text `--text-weaker` 400; mt 12, gap 8, spinner 16 | toolSize, toolWeight, toolColor, toolGap, partGap (mt) |
| Reasoning part (`.ui-reasoning-part`) | `--v2-text-text-muted`, lh 130%; inner `.ui-markdown` **13px** compact, mt 16, `strong` muted, `p:has(strong)` mt 24; inline code opacity .6 in dark | compactSize, reasoningLineHeight, reasoningColor (does not follow prose size) |
| Compaction divider | 1px `--v2-border-border-base`, padding 10px 0, label gap 6 | **fixed** |
| Background subagents heading | 12 / 500 `--text-weak`, pb 2 | **fixed** |
| Column | `--transcript-measure` \| 48rem / 880px @2xl; px-4 (md: px-5) | measure |

## 4. Tool calls, groups and cards (`basic-tool.css`, `activity-row.css`, `work-group.css`, `message-part.css`, `claxedo-tool.css`)

Names in quotes are what the screenshot shows.

| Element | Family | Size | Weight | Line-height | Colour | Spacing / box | Knob |
|---|---|---|---|---|---|---|---|
| Tool row ("Read a-codex-theme.png", "Running ls …") — `[data-component="tool-trigger"]` | `--font-family-sans` (rescoped by body face) | 14 | title 500 / subtitle & arg 400 | 150% | title & row `--text-weak` (legacy); subtitle `--v2-text-text-muted`; hover/focus → `--text-strong` | row min-height 32 (activity row), gap 8; leading icon 14, spinner/indicator 16; exit `--text-weak`; elapsed `--text-weaker` tabular, ml auto, pl 8 | face only |
| Fold row ("Worked for 5m 40s", `[data-component="turn-fold"]`, `turn-fold.css`) | sans | `tool-size` 14 | `tool-weight` 500 | `tool-line-height` 150% | `tool-color` → hover `tool-hover-color`; footer `meta-color` `--text-weaker` | height `tool-row-height` 32, gap 6, 1px rule below | toolSize, toolWeight, toolLineHeight, toolColor, toolHoverColor, toolRowHeight, metaSize, metaColor |
| Activity row (`.activity-row`, verb + tail) | sans | 14 | verb 500 / tail 400 | 150% | `--text-weak` → hover strong; nested tail `--text-weaker` | height 32, gap 8, nested pl 8, chevron 16 fades in on hover | face only |
| File chip under a read ("a-codex-theme.png 205 KB", `.ui-tool-loaded-file`) | sans | 12 | 400 | 150% | `--text-weak` | gap 8, padding 4px 0 4px 28px | metaSize, metaLineHeight, metaColor |
| Tool group ("Ran 5 commands", `work-group-trigger` / `.ui-work-group-summary`) | sans | 14 | 500 | 150% | `--text-weak` → hover strong; arrow `--icon-weaker` | min-height 32, gap 8, icon 14 | face only |
| Group body (`.ui-work-group-list`, the nested "Ran …" rows) | rows as "Tool row" | | | | member titles `--text-weak` | padding-left 8, gap 4, **max-height 224** scroll with edge fades | face only |
| Context tool group list | as above | | | | | padding-left 12, gap 4 | face only |
| Edit / write trigger (`message-part-title`) | sans | 14 | 500; filename & path 400 | 150% | `--v2-text-text-muted`; text `--v2-text-text-base`; filename dotted .5px underline | gap 12/8; content border-top .5px muted | face only |
| Expanded command output card (`.ui-bash-output`, the `$ sed …` block) | `--font-family-mono` (rescoped by mono face) | **13** (`--font-size-compact`) | 400 | 150% | inherits | border .5px `--v2-border-border-base`, radius md, transparent bg; `pre` padding 12; copy button hover-only | mono face only — **not** `code-font-size` |
| Tool output card (`[data-component="tool-output"]`, first-party tools) | inner `.ui-markdown` (§1) | | | | | padding 8px 10px, mb 24, border .5px, radius md; inner `pre` margin/padding 0, transparent | as §1 |
| Capped output (`.ui-scrollable-output`) | | | | | | max-height 240 (revealed: none); own 8px scrollbar | outputCap, scrollbarSize, scrollbarThumb |
| "Show more" toggle (`.ui-scrollable-output-toggle`) | sans | 14 | 400 | 150% | `--text-weak` → strong | padding 4 0 0 | toolSize, toolLineHeight, toolColor, toolHoverColor |
| Diagnostics strip (`.ui-diagnostics`) | mono | 12 | | | `--v2-state-fg-danger` on `--v2-state-bg-danger` | padding 8px 12px, gap 4, border-top .5px | metaSize (mono), metaLineHeight |
| Todos (`.ui-todos`) | | | | 130% | completed: line-through `--v2-text-text-faint` | padding 10 0 24, gap 8 | **fixed** |
| Local preview row | sans / url mono | 14 | verb 500 | | `--text-weak` → strong | height 32, mt 4, gap 8 | face only |
| Exa/web tool output | sans | 14 | | 150% | `--v2-text-text-muted`; links `--v2-text-text-accent` underlined | links gap 4 | toolSize, toolLineHeight |
| Permission dock | sans | title 14/500, hint 14/400, patterns `code` 14 | | 150% | title base, hint muted | body padding 12 12 0, gap 16; patterns mt 8 mb 16; footer 32 8 8 (mt −24) | toolSize, toolLineHeight |
| Question dock | sans | title 14/500, preview 13/400, question 14/500, hint 13/400, option 14/500, description 14/400, input 14/400 | | 150% | base / muted | body padding 8 8 0, gap 16; header padding 0 10 | toolSize, compactSize, toolLineHeight |
| Question card | sans | title 13/500, count 12 | | | | | compactSize, metaSize |
| Subagent chip | sans | summary 12, status 12, overflow 13 | | | | | metaSize, compactSize |
| Session diffs (changed files) | sans | label 14/500 strong; toggle 14/400 interactive (hover-only); more 12 weak; path 12, filename 500 strong | | 150% | | header 44px sticky, padding 4 0 12; more mt 12 | toolSize, toolWeight, toolLineHeight, linkColor (toggle), metaSize (more, path) |
| Tool error card | `.ui-card[data-kind="tool-error-card"]` | | | | | | **fixed** |

## 5. Scrollbars

| Region | Rule | Where |
|---|---|---|
| Everything without `[data-scrollable]` | hidden: `scrollbar-width: none !important`, webkit `display: none` | `app/styles/ui-overrides.css` |
| Timeline scroll region (`session-turn-content`, list root) | hidden (falls under the rule above) | `session-turn.css`, `ui-overrides.css` |
| `[data-scrollable-pane]` (pane containers) | thin, 6px, thumb `--border-weak-base` radius-3, transparent track | `ui-overrides.css` |
| Capped tool output (`.ui-scrollable-output`) and group body (`.ui-work-group-list`) | `scrollbar-width: auto`, gutter stable; webkit 8×8px, thumb `--text-weaker`, radius sm, 2px transparent inset, transparent track | `message-part.css` |
| Diff view (`session-turn-diff-view`, `data-scrollable`) | `scrollbar-width: none` | `session-turn.css` |
| Command output (`.ui-bash-scroll`) | is a `ScrollableOutput` (`data-scrollable`, `.ui-scrollable-output`): 240px cap, the 8px `--text-weaker` thumb above | `message-part.tsx:2227`, `message-part.css` |
| Markdown `pre`, table scroll wrapper | hidden | `markdown.css` |
| Rail sidebar | `scrollbar-width: thin`, colour `--scrollbar-thumb` rgb(128 128 128 / 30%) | `rail-sidebar.tsx` |
| Markdown viewer (documents) | `scrollbar-gutter: stable` | `markdown-viewer.css` |

## 6. Reach

Every row above names its knob. What a pairing sets today:

- **Prose**: family, size, leading, tracking, body/bold weight, colour, h1–h4
  ladder, paragraph/block/list/nested-list spacing, quote indent and rule, table
  cell padding and head weight, inline-code treatment and size, code-block
  size/padding/leading, `hr`, links (colour, underline policy), marker colour,
  line length.
- **Your messages**: size, leading, tracking, weight, colour, face.
- **Structure**: turn gap, part gap, text-part top.
- **Tool rows, groups, the fold row, thinking row, diff rows, docks**: size,
  leading, weight, colour, hover colour, row height, gap, icon size; group
  indent, gap and cap.
- **Command output**: size (the code-size knob), leading, padding, cap.
- **Reasoning**: size (compact), leading, colour.
- **Meta text** (file chips, attachment names, diff paths, footers): size,
  leading, colour.
- **Scrollbars** on capped outputs and group bodies: size, thumb colour.

Still stylesheet-only (no knob, by choice): card radius/border colour, the
user bubble's padding and radius and its hover meta line, image tiles, the
shell code block's colours, the task-list checkbox offset, `em`, the path/url
inline-code affordances, the compaction divider, todos, the tool error card,
and the global scrollbar-hiding rule.

Cursor's and Codex's tool rows, cards and outputs are **not measured yet**:
both pairings leave those knobs at the stylesheet values. Measuring them is the
next step for "Codex looks exactly like Codex".
