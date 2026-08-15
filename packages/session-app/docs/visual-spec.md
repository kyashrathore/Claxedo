# Claxedo session surface — visual spec

Blueprint for reproducing the main app's session UI (oc-2 dark, the default
theme) in `packages/session-app`. Everything here was read out of the real
components and stylesheets; file references are given so claims can be
re-verified, but the spec is complete enough to implement without opening them.

All CSS custom properties referenced below are defined in
`packages/session-app/src/web/tokens.css` (a faithful extraction of the main
app's `:root`). Key literal values for oc-2 dark are repeated inline where they
are load-bearing.

Sources of truth:

- Screen skeleton: `packages/claxedo-app/src/features/session/ui/session-screen.tsx`
- Timeline: `.../ui/message-timeline.tsx`, `.../ui/message-timeline-turn-rows.tsx`
- Message/tool markup: `packages/session-ui/src/components/message-part.tsx`,
  `basic-tool.tsx` + their `.css`, `markdown.css`, `session-turn.css`
- Composer: `.../session/composer/composer.tsx`, `composer/ui/frame.tsx`,
  `toolbar-controls.tsx`, `add-menu.tsx`, `permission-control.tsx`,
  `harness-model-picker.tsx`, `submit-control.tsx`, `toolbar-motion.ts`
- Composer region/docks: `.../session/ui/composer/session-composer-region.tsx`
- Shared chrome: `packages/ui/src/components/dock-surface.css`, `button.css`,
  `packages/ui/src/v2/components/menu-v2.css`,
  `packages/claxedo-app/src/app/styles/index.css` (composer menus, container
  queries), `ui-overrides.css`
- Type utilities: `packages/ui/src/styles/utilities.css`

Conventions: the app is Tailwind-based; this spec spells Tailwind utilities out
as CSS where the value matters. `data-component` / `data-slot` / `data-action`
attributes are the app's own styling and test hooks — keep them verbatim, they
are the contract this spec is written against.

---

## 0. Foundations

### 0.1 Page surfaces (oc-2 dark values)

| Role | Token | Value |
|---|---|---|
| App/page background (behind header) | `--background-base` | `#121212` |
| Session pane + timeline background | `--background-stronger` | `#151515` |
| Composer card background | `--v2-background-bg-base` (= `--v2-grey-1100`) | `#161616` |
| Composer shell/ring color | `--shell-surface-composer` | `#232323` |
| User bubble / raised layer | `--v2-background-bg-layer-02` (= `--v2-grey-900`) | `#2e2e2e` |
| Overlay menus | `--overlay-surface` | `#191919` |
| Menu (MenuV2 default) surface | `--v2-background-bg-layer-01` (= `--v2-grey-1000`) | `#242424` |
| Primary body text | `--v2-text-text-base` (= `--v2-grey-100`) | `#fafafa` |
| Muted text | `--v2-text-text-muted` (= `--v2-grey-500`) | `#aeaeae` |
| Faint text (placeholder) | `--v2-text-text-faint` (= `--v2-grey-600`) | `#808080` |
| v1 body text (meta rows) | `--text-base` | `#A0A0A0` |
| v1 strong text | `--text-strong` | `#EDEDED` |
| v1 weak text | `--text-weak` | `#707070` |
| Hairline border | `--border-weak-base` | `#282828` |
| v2 border | `--v2-border-border-base` | `#ffffff1a` (alpha-light-10) |
| Hover overlay | `--v2-overlay-simple-overlay-hover` | `#ffffff0f` (alpha-light-6) |
| Accent (links, focus) | `--v2-text-text-accent` = `--v2-blue-400` | `#a2bcff` |
| Focus border | `--v2-border-border-focus` = `--v2-blue-500` | `#7698fd` |
| Success/Warning/Danger fg | `--v2-state-fg-{success,warning,danger}` | `#6bd586` / `#f2cf76` / `#f17471` |
| Send button fill | `--v2-background-bg-inverse` (= `--v2-grey-50`) | `#ffffff` |
| Send button glyph | `--v2-icon-icon-inverse` (= `--v2-grey-1100`) | `#161616` |

### 0.2 Type utilities

The app uses named text utilities (`packages/ui/src/styles/utilities.css`).
Every one is `font-family: var(--font-family-sans)`, `letter-spacing: 0`
unless noted:

| Class | size | weight | line-height |
|---|---|---|---|
| `text-11-regular` / `text-11-medium` | 11px | 400 / 500 | 16px |
| `text-12-regular` / `text-12-medium` | 12px | 400 / 500 | 150% |
| `text-13-regular` / `text-13-medium` | 13px | 400 / 500 | 20px |
| `text-14-regular` | 14px | 400 | 180% |
| `text-14-medium` | 14px | 500 | 150% |
| `text-16-regular` | 16px | 400 | 24px, letter-spacing −0.16px |
| Tailwind `text-compact font-body leading-4` | 13px | 400 | 16px |

Fonts: `--font-family-sans: ui-sans-serif, system-ui, -apple-system,
BlinkMacSystemFont, "Segoe UI", sans-serif`; mono is `ui-monospace,
SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New",
monospace`.

### 0.3 Content column

Timeline rows and the composer share one centered column:

- full width, `max-width: 48rem (768px)` from `md:` breakpoint, `880px` from
  `2xl:`, `margin-inline: auto` (`md:max-w-192 md:mx-auto 2xl:max-w-[880px]`).
- Timeline rows pad `px-4 md:px-5` (16px/20px) inside the column; the composer
  wrapper pads `px-3` (12px).

---

## 1. Session screen skeleton

```
<div class="session-page-root">                      relative, size-full, overflow-hidden,
                                                     flex flex-col, bg: --background-base
  <SessionHeader/>                                   (portals into app titlebar — §3)
  <div class="flex-1 min-h-0 flex flex-col">
    <div class="pane">                               @container; relative flex-1 flex flex-col
                                                     min-h-0 h-full; bg: --background-stronger;
                                                     padding-top: 8px (12px from md:)
      <div class="flex-1 min-h-0 overflow-hidden">   ← timeline lives here (§4)
      <SessionComposerRegion/>                       ← composer dock (§5)
```

So: the whole conversation area (timeline + composer) sits on `#151515`; only
the window titlebar row sits on `#121212`.

---

## 2. (reserved)

---

## 3. Session header

Two pieces:

### 3.1 App titlebar portals (`components/session-header.tsx`)

`SessionHeader` renders nothing in-flow; it portals into titlebar slots:

- **Center slot** — a file-search pseudo-input (hidden below `md:`):
  ghost Button, `w-[240px]`, `justify-between`, `gap-2`, `rounded-md`,
  `border 1px --border-weak-base`, `bg: --surface-base` (`#1C1C1C`), no shadow.
  Left: `text-12-regular --text-weak` truncated placeholder
  ("Search files in {project}…"). Right: keybind hint, borderless,
  `--text-weaker` (`#505050`).
- **Right slot** — `flex items-center gap-2`:
  1. *(≥ xl, desktop only)* "Open in app" split control: `h-[24px] rounded-md
     border --border-weak-base bg --surface-base overflow-hidden` containing a
     ghost button with the editor's 20px app icon (`px-0.5`) and a 20px-wide
     chevron-down IconButton; opens a bottom-end DropdownMenu of editors +
     "Copy path". Non-desktop fallback: same container with a copy icon +
     `text-12-regular --text-strong` "Copy path" label.
  2. `flex items-center gap-1`: status popover trigger, terminal toggle,
     review toggle, file-tree toggle — each a ghost Button `w-8 h-6 p-0`
     (class `titlebar-icon`), small (14px) icon, `--icon-weak-base` when idle,
     `--icon-base`/active variant when panel open; `aria-expanded` reflects
     panel state; expanded paints `--surface-base-active` (`#282727`).

### 3.2 In-timeline session title row (`message-timeline.tsx`)

Sticky inside the timeline scroll (only when a header is shown, i.e. an
existing session):

```
<div data-session-title
     class="sticky top-0 z-30 w-full pb-4 pl-2 pr-3 md:pl-4 md:pr-3
            [column width rules §0.3]"
     style: background: linear-gradient(to bottom, var(--background-stronger) 48px, transparent)>
  <div data-component="session-progress">            (optional, while working)
    absolute inset: 0 0 auto; height 2px; overflow hidden
    <div data-component="session-progress-bar">      full-size; border-radius: --radius-pill;
                                                     background: agent tint or --icon-interactive-base;
                                                     animation: session-progress-whip (clip-path wipe)
  <div class="h-12 w-full flex items-center justify-between gap-2">
    <div class="flex items-center gap-1 min-w-0 flex-1 pr-3">
      [parent title button]   text-14-medium --text-weak, hover --text-base,
                              truncate, max-w-[40%]          (only for child sessions)
      [separator "/"]         text-14-medium --text-weak px-2
      [spinner slot]          16px Spinner tinted by agent color while working
      [session title]         text-14-medium --text-strong truncate
                              (becomes an InlineInput when renaming)
    <div class="shrink-0 flex items-center gap-3">
      [overflow menu trigger] IconButton size-6 rounded-md,
                              data-[expanded]:bg-surface-base-active
```

The sticky offset for accordion headers below it is 48px
(`--sticky-accordion-top`).

---

## 4. Message timeline

### 4.1 Scroll container

```
<ScrollView data-slot="session-timeline-scroll" class="relative min-w-0 w-full h-full">
  [sticky title row §3.2]
  [virtualized rows]
  [bottom padding / anchor]
</ScrollView>
```

- "Jump to latest" pill: absolutely positioned `left-1/2 -translate-x-1/2
  bottom-6 z-[60]`; button `h-8 w-8 rounded-full border --border-weaker-base
  (#232323) bg --surface-raised-stronger-non-alpha (#191919) text --text-base`,
  hover border `--border-weak-base`.
- Left gutter message-nav arrows sit in `data-slot="message-nav-gutter"`
  (absolute inset-0 z-[45], pointer-events only on the control).

### 4.2 Row frame

Every row renders as:

```
<div data-message-id=… data-timeline-row=<Tag>
     class="min-w-0 w-full max-w-full [+ column rules §0.3]
            [pt-3 when following another assistant part]">
  <div data-component="session-turn" class="min-w-0 w-full relative">
    <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
      …row content…
```

`session-turn-message-container` is a column flex, `gap: 0`,
`overflow-anchor: none` (`session-turn.css`). Consecutive turns are separated
by a `TurnGap` row: `<div class="h-6"/>` (24px).

Assistant content wrapper: `data-slot="session-turn-assistant-content"` —
column flex, `gap: 12px`.

### 4.3 User message bubble

DOM (`message-part.tsx` `UserMessageDisplay` + `message-part.css`):

```
<div data-slot="session-turn-message-content">        (plain width:100% wrapper)
  <div data-component="user-message">                 flex column, align-items:flex-end,
                                                      width 100%, font 14px/150% sans,
                                                      color --v2-text-text-base
    [attachments]  <div data-slot="user-message-attachments">
                     flex wrap justify-end gap-8px; width fit-content;
                     max-width min(82%, 64ch); margin-left auto
                     — image chip: 58×46px, rounded --radius-md, cover img,
                       0.5px inset hairline ring (--v2-border-border-base)
                     — file chip: min(220px,100%)×48px, padding 0 10px,
                       bg --v2-background-bg-layer-02, 0.5px border
                       --v2-border-border-base (hover -strong), 20px FileIcon +
                       truncated name (12px, --v2-text-text-muted)
    <div data-slot="user-message-body" [data-markdown]>
        width fit-content; max-width min(82%, 64ch); margin-left auto;
        flex column align-end
        — when rendered as markdown: width & max-width min(92%, 900px),
          align-items stretch
      <div data-slot="user-message-text" [data-markdown] [data-comments]>
          THE BUBBLE: display inline-block; white-space pre-wrap;
          word-break break-word; overflow hidden;
          background: --v2-background-bg-layer-02 (#2e2e2e);
          border: none; padding: 8px 12px; border-radius: --radius-xl (10px);
          max-width 100%
          — inline @file spans: [data-highlight="file"] → color --syntax-property
          — inline agent spans: [data-highlight="agent"] → color --syntax-type
          — markdown mode: display block, width 100%, white-space normal;
            tables get th background --v2-background-bg-layer-03
    <div data-slot="user-message-copy-wrapper">
        min-height 24px; margin-top 4px; row flex justify-end gap-10px;
        width 100%; opacity 0 → 1 on bubble :hover/:focus-within (0.15s)
      <span data-slot="user-message-meta…">  "Agent · Model" + " · " + "HH:MM"
                                             text-12-regular --text-weak
      [revert button]                        icon action button (reset icon)
```

### 4.4 Assistant markdown (text part)

```
<div data-slot="session-turn-assistant-content">
  <div data-component="tool-part-wrapper"?>           (only tools use this)
  <div data-component="text-part" data-timeline-part-id=…>
    <div data-slot="text-part-body">
      <div data-component="markdown"> …rendered markdown… </div>
    <div data-slot="text-part-copy-wrapper">           (only on last text part;
                                                       reveal like user copy row)
      [copy button] [meta: "Agent · Model · 12s (· Interrupted)"
                     text-12-regular --text-weak]
```

`[data-component="markdown"]` core rules (`markdown.css`; all colors as
variables):

- Base: 14px `--font-family-sans`, `line-height: 1.6`,
  color `--v2-text-text-base`; first/last child margins stripped.
- `h1` 17px/600, margins 28/12; `h2` 15px/600, 24/10; `h3` 13px/500, 20/8;
  `h4–h6` 13px/500, color `--v2-text-text-muted`. All `line-height: 150%`.
- `strong` → 500 weight, base color (not brighter).
- `p` margin-bottom 12px. `a` → `--text-interactive-base` (`#c0d4fb`), no
  underline, underline on hover (offset 2px).
- `ul/ol`: margin 8px 0 12px; padding-left 32px (`ol` 2.25rem); `li`
  margin-bottom 8px; first `p` inside `li` renders inline.
- `blockquote`: margin 1rem 0, padding-left 0.5rem, color
  `--v2-text-text-muted`.
- `hr`: invisible — no border, just 32px vertical margin.
- Code blocks: `<div data-component="markdown-code">` (relative) wrapping a
  shiki `<pre class="shiki">`:
  `background: --background-stronger (#151515)`, `color: --text-base`,
  13px, `padding: 12px`, `border-radius: --radius-md (6px)`,
  `border: 0.5px solid --v2-border-border-base`. `pre` margin 12px 0 24px,
  scrollbars hidden. Shell-language blocks swap to
  `background --v2-background-bg-layer-02`, border `--v2-border-border-muted`,
  plain (single-color) text.
  Copy button: absolute top/right 4px, opacity 0 → 1 on hover.
- Inline code (`:not(pre) > code`): mono, `--v2-text-text-base`, weight 500,
  `padding: 1px 0.3rem`, radius `--radius-sm`,
  `box-shadow: inset 0 0 0 0.5px var(--border-weak-base)`,
  `background: color-mix(in oklch, var(--v2-text-text-base) 8%, transparent)`,
  `font-size: 0.85em`.
- Syntax colors come from `--syntax-*`; note the oc-2 body-level overrides in
  tokens.css (string `#00ceb9`, keyword `#edb2f1`, property `#fab283`, type
  `#fcd53a`, primitive `#8cb0ff`, comment `#8f8f8f`).

### 4.5 Tool cards (`BasicTool`)

Tools do NOT render as bordered cards — the resting state is a one-line
text-toned trigger row; only the expanded content gets an inset surface.

```
<div data-component="tool-part-wrapper">              width 100%
  <div data-component="reasoning-part"|…>             (per part type)
    Collapsible (class "tool-collapsible", ghost variant)
      <div data-component="tool-trigger" [data-clickable]>
          row flex, width 100%, content-visibility auto
        <div data-slot="basic-tool-tool-trigger-content">   row flex gap-8px,
                                                            max-width calc(100% − 24px)
          <span data-slot="basic-tool-tool-leading-icon">   14×14 icon, color: inherit
          <div data-slot="basic-tool-tool-info">            14px
            <div data-slot="basic-tool-tool-info-structured">  inline-flex gap-8px
              <div data-slot="basic-tool-tool-info-main">      baseline flex gap-8px
                <span data-slot="basic-tool-tool-title">       14px/150% weight-500,
                                                               color --v2-text-text-base;
                                                               TextShimmer while running
                <span data-slot="basic-tool-tool-subtitle">    14px/150% regular,
                                                               color --v2-text-text-muted,
                                                               truncates
                <span data-slot="basic-tool-tool-arg">*        same tone as subtitle
        [chevron / collapsible arrow, 16px, right of content]
      <Collapsible.Content>  … tool output (bash output, diff, markdown …)
```

Status is communicated by the shimmering title while
`pending/running` (plus a live "for Xs" elapsed), not by a colored dot.
Reasoning parts use icon `brain`, title "Thought for 4s"/"Thinking…" and put
the markdown body in `data-component="reasoning-content"`.

Errors render `ToolErrorCard` instead (rounded card, danger-toned title row,
collapsible raw error).

**Context tool group** (reads/greps/globs merged): a Collapsible whose trigger
line is `data-component="context-tool-group-trigger"` — title
"Gathered context" (`text-14-medium --text-strong`) + animated summary
("12 reads · 3 searches", `font-normal --text-base`) + arrow; expanded list
`data-component="context-tool-group-list"` shows one compact row per tool.

**Edit/write file cards** use a sticky accordion header with
`data-slot="message-part-title-area"`: FileIcon + filename
(`--text-strong`, 500) + dimmed directory, actions right; diff body sits on
`--surface-inset-base` (`#202020`).

### 4.6 Turn chrome rows

- **Thinking row** (`data-slot="session-turn-thinking"`): row flex gap-8px,
  margin-top 12px, `--text-weak`, 14px/500, 20px line-height; TextShimmer
  "Thinking…" + optional faint reasoning heading reveal.
- **Turn fold** (`data-component="turn-fold"`): full-width button, `h-8`,
  row flex gap-1.5, `text-14-medium tabular-nums`, `--text-weak` (hover
  `--text-strong`); label "Worked for 34s" (present tense while running);
  chevron rotates 0→90°; optional right-aligned `text-12-regular
  --text-weaker` "12.3k tokens · $0.42". Below it a 1px divider
  `bg --border-weak-base`.
- **Turn divider / interruption / compaction**
  (`data-component="compaction-part"`): centered hairline —
  `<span data-slot="compaction-part-line"/>` on both sides of a
  `text-12-regular --text-weak` label (optional 14px icon).
- **Diff summary** (`data-slot="session-turn-diffs"`): sticky header row
  (44px tall, gap-8px, background `--background-stronger`, `padding: 4px 0
  12px`): label "3 changed files" (`14px/500 --text-strong`, tabular-nums) +
  `DiffChanges` (+N green `--text-diff-add-base`, −N red
  `--text-diff-delete-base`) + hover-reveal "Undo"
  (`text-12-medium --text-weak`) and "Show all" (`--text-interactive-base`).
  Body: accordion of file rows — path (dimmed rtl-truncated directory
  `--text-base` + filename `--text-strong` 500, 12px), right meta with
  DiffChanges and a chevron (−90° when closed); expanded diff panel on
  `--surface-inset-base`. An 800ms hover on a row floats a diff preview card:
  `rounded-xl border-[0.5px] --border-weak-base bg --background-stronger
  shadow-xl`, max 560px/80vw wide.
- **Error row**: `Card variant="error" class="error-card"` — pre-wrap,
  max-height 240px, scrollable, color `--text-base`.

---

## 5. Composer

### 5.1 Region wrapper (`session-composer-region.tsx`)

```
<div data-component="session-prompt-dock"
     class="w-full flex flex-col justify-center items-center pointer-events-none
            shrink-0 pb-3 bg-background-stronger">          (docked placement)
  <div class="w-full px-3 pointer-events-auto
              [md:max-w-192 md:mx-auto 2xl:max-w-[880px] when centered]">
    [question dock]      (active question request replaces normal input focus)
    [permission dock]
    [todo dock]          (collapsible card that slides 36px under the composer)
    [revert dock]
    [beforeInput: SessionHealthPeek, SessionConnectionLine]
    [followup dock]
    <PromptInput/>       ← §5.2
```

The dock stack overlaps the composer (`margin-top: -36px * progress`) so cards
appear to slide out from behind it.

### 5.2 Composer card (`frame.tsx`)

```
<div data-component="composer-frame"                  container-name: prompt-composer;
     class="relative size-full flex flex-col gap-0">  container-type: inline-size
  [PromptPopover]                                     (@ / slash autocomplete, above)
  [notice row]                                        ComposerNoticeRow — harness failures;
                                                      when present the card overlaps it (-mt-2)
  <form data-component="session-composer"             (or "session-new-composer")
        data-dock-surface="shell"
        data-surface="composer"
        data-dock-border-underlay="v2"
        class="group/prompt-input min-h-[96px] w-full rounded-xl
               bg-v2-background-bg-base">
    …
```

Card chrome (from `dock-surface.css` + `ui-overrides.css`):

- `border-radius: 10px`. Two rules compete: the utility `rounded-xl`
  (`--radius-xl` = 0.625rem — the project overrides Tailwind's default scale
  in `packages/ui/src/styles/tailwind/index.css`) and
  `[data-dock-surface="shell"] { border-radius: var(--radius-2xl) }` (12px)
  from `dock-surface.css`. Utilities are imported at `layer(utilities)` and
  dock-surface at `layer(components)`, so the utility wins → **10px**.
  `overflow: clip` from the shell rule still applies.
- `background: --v2-background-bg-base` (`#161616`); the `data-dock-surface`
  base paint (`--surface-raised-stronger-non-alpha`, `#191919`) is overridden
  by the utility.
- `box-shadow: var(--v2-elevation-raised), 0 0 0 0.5px var(--shell-surface-composer)`
  — i.e. `[data-dock-border-underlay="v2"]` sets
  `--dock-shell-visual-shadow: --v2-elevation-raised` and a 0.5px ring in
  `--shell-surface-composer` (`#232323`). oc-2 dark
  `--v2-elevation-raised: 0 2px 4px #0000004d, 0 1px 2px #0000004d,
  0 0 0 0.5px #ffffff29, 0 -0.5px 0 #ffffff0f`.
- `position: relative; z-index: 10`.
- Drag-over state adds `border-icon-info-active border-dashed`.
- min-height 96px total.

Inside the form, top to bottom:

1. **Drag overlay** (`PromptDragOverlay`) — covers card during image/@ drag.
2. **Context items row** (`PromptContextItems`) — chips for attached
   files/comments (only when present).
3. **Image attachments row** (`PromptImageAttachments`).
4. **Editor block**:

```
<div class="relative min-h-[52px]">                    (mousedown → focus editor)
  <div class="relative max-h-[180px] overflow-y-auto no-scrollbar">  scroll area
    <div data-component="prompt-input"
         contenteditable role=textbox aria-multiline
         class="select-text min-h-[52px] w-full px-4 pt-4 pb-2
                focus:outline-none whitespace-pre-wrap leading-5
                text-compact font-body text-v2-text-text-base
                [font-family:var(--font-family-sans)]">
        — 13px/20px sans, color #fafafa
        — [data-type=file] spans → --syntax-property; [data-type=agent] → --syntax-type
        — shell mode switches to font-mono
    <div data-component="session-composer-text"        PLACEHOLDER overlay
         class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none
                whitespace-nowrap truncate leading-5 text-compact font-body
                text-v2-text-text-faint …">            hidden once dirty
```

5. **Toolbar row** — §5.3.

### 5.3 Toolbar row (chips row)

```
<div data-slot="composer-toolbar" class="flex h-11 items-center gap-1 px-2">
  <div data-slot="composer-controls"
       class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
    [1] + add menu trigger
    [2] permission-mode chip
    <div data-slot="composer-selection-controls"
         class="ml-auto flex min-w-0 items-center gap-1">
      [3] harness/model/effort picker chip
      [3b] "Connecting" readiness indicator (while harness polls)
      [4] PromptModelControl (ONLY when a Connect action is required)
  [5] SessionStatusStage (escalation pill; hidden unless pending/long/failed)
  [6] submit button
```

Order on screen: `+`, permission chip … (flex gap) … harness-model chip,
send. Row height 44px (`h-11`), horizontal padding 8px, 4px gaps.

All left-cluster controls receive an animated inline style bag
(`toolbar-motion.ts`): shell mode fades the cluster out
(opacity/scale 0.98→1/blur 2px→0, pointer-events off); the harness/model
controls additionally sit at fixed `height: 28px` and dim to 0.45 opacity
while the harness is polling.

**[1] Add menu trigger**

```
<button data-action="prompt-add" aria-label="Add"
        class="flex size-7 shrink-0 items-center justify-center rounded-md
               p-[6px] text-v2-icon-icon-muted transition-colors duration-150
               hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base
               disabled:pointer-events-none disabled:opacity-50
               data-[expanded]:bg-v2-overlay-simple-overlay-hover
               data-[expanded]:text-v2-icon-icon-base">
  <Icon name="plus" size="small"/>          (14px glyph)
```

28×28px; idle glyph `--v2-icon-icon-muted` (`#808080`), hover/expanded glyph
`--v2-icon-icon-base` (`#dbdbdb`) on `#ffffff0f`.

Its menu (MenuV2, `placement="top-start"`, gutter 8): group label "Add", items
"Images and files ⌘U", "Commands /", "Context @", "Shell command !", then a
separator + "Plan mode" checkbox (or an Agent radio group when custom agents
exist). `data-action` per item: `prompt-attach`, `prompt-commands`,
`prompt-context`, `prompt-shell-mode`, `prompt-plan-mode` / `prompt-agent`.

**[2] Permission-mode chip** (`permission-control.tsx`)

```
<button data-action="prompt-permission-mode" data-mode=<id>
        class="flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2.5
               text-compact font-body leading-4 transition-colors duration-150
               hover:bg-v2-overlay-simple-overlay-hover
               disabled:pointer-events-none disabled:opacity-50
               data-[expanded]:bg-v2-overlay-simple-overlay-hover
               + (active)   text-v2-text-text-base
               + (inactive) text-v2-text-text-faint hover:text-v2-text-text-muted">
  <Icon name="shield" size="small"          class: text-v2-icon-icon-base (active)
                                                   / text-v2-icon-icon-muted (inactive)>
  <span data-slot="composer-control-label" class="truncate">{mode name | "Permissions"}</span>
```

28px tall, 10px horizontal padding, 6px icon-label gap, 13px/16px text.
Label = current mode's harness-native name ("Accept edits", "Auto", …);
falls back to "Permissions" when unresolved. Tooltip = mode description.
Hidden entirely when permissions are unsupported (`enabled` false).

Menu (MenuV2 top-start, gutter 8, class `claxedo-composer-menu`, max-height
min(420px, available)): either Claxedo's own rows or one group labeled by the
harness ("Claude", …) of `ModeRow`s. Each row: shield/hand 14px icon
(`icon-base` when selected, `icon-muted` otherwise), name
(13px/16px `--v2-text-text-base`), 2-line-clamped description (11–12px
`--v2-text-text-faint`), optional warning caveat in `--v2-state-fg-warning`,
and an always-mounted trailing check slot
(`data-slot="menu-v2-item-indicator"`, visible when `data-checked`).
A harness with no modes renders a padded prose paragraph instead of rows.

**[3] Harness/model/effort chip** (`harness-model-picker.tsx`)

Trigger is a ghost Button (`size="normal"` → height 28px, padding 0 6px,
radius `--radius-md`, transparent; hover `--surface-base-hover`
(`#FFFFFF0D`), active `--surface-base-active`; text `--text-strong`):

```
<button data-action="prompt-harness-model"
        data-harness=… data-model=… data-provider=… data-readiness=…
        data-ready-for-submit=…
        class="composer-harness-model group min-w-0 max-w-[260px]
               max-md:max-w-[132px] text-13-regular"
        style="height: 28px [+ motion bag]">
  <span class="flex shrink-0 items-center"><HarnessIcon/></span>   14px brand mark
                                                                   (claude/openai/cursor/
                                                                    opencode/pi)
  <span data-slot="composer-control-label" class="truncate">{model name}</span>
  <span class="shrink-0 text-v2-text-text-faint">{effort}</span>   only when the model
                                                                   has >1 thought level
  <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted"/>
```

Label examples: "Claude Sonnet 4.5", "Loading models", "Select model",
"No Pi models available". Disabled look = 0.45 opacity via the style bag.

Popover (`placement="top-end"`, gutter 4, classes `claxedo-composer-menu
claxedo-composer-menu-picker harness-picker-surface`, `data-component=
"harness-model-picker"`): width `min(304px, 100vw − 24px)`, padding 6px,
background `--overlay-surface`, shadow `--v2-elevation-floating`, radius 8px
(`--surface-overlay-radius` default). It is an accordion of three
`SectionHeader`s — **Harness**, **Model**, **Effort** — one open at a time;
fixed height `26rem` when Model is open, `20rem` for the others. Harness
section groups options under uppercase 11px/500 letterspaced
(`--letter-spacing-label`) `--text-weaker` headings: "ACP", "Native SDK",
"Direct". Model section hosts the searchable model list (sticky group labels
per provider) and a "Manage models" footer for opencode/pi.

**[3b] Connecting indicator**

```
<span class="text-11-regular text-text-weak px-1.5 flex items-center">
  <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1"/>
  Connecting
```

**[4] `PromptModelControl`** — only rendered when the server demands a
provider connection ("Connect" call to action); otherwise the merged picker
owns model + effort.

**[5] SessionStatusStage** — escalation pill left of the send button; hidden
unless the dispatch is `pending`/`long`/`failed` (spinner + copy + Cancel /
Retry).

**[6] Submit button** (`submit-control.tsx`)

```
<IconButton data-action="prompt-submit" type="submit" variant="primary"
            icon={busy ? "stop" : shell ? "arrow-undo-down" : "send"}
            class="size-8 rounded-full bg-v2-background-bg-inverse p-[7px]
                   text-v2-icon-icon-inverse shadow-none transition-opacity
                   duration-150 hover:opacity-90 disabled:opacity-35"/>
```

32×32 white circle, dark glyph, no shadow; 50% opacity when a click would
open a remedy (choose model / connect); while booting the glyph fades out and
a 14px Spinner (`text-v2-icon-icon-inverse`) overlays the center. Tooltip:
"Send ⏎" / "Stop esc" / block reason with an inline bordered action button
(`rounded border --border-base px-1.5 py-0.5 text-11-medium --text-base`,
hover `bg --surface-raised-base`).

### 5.4 Responsive collapse (`@container prompt-composer (max-width: 560px)`)

- toolbar gap drops to 2px;
- the permission chip collapses to a 28px icon-only square (label hidden,
  `padding-inline: 6px`, centered);
- the harness-model chip KEEPS its label but caps at `max-width: 148px`,
  `padding-inline: 6px`, gap 4px, and drops its chevron;
- `.composer-compact-only` marks flip to `display: inline-flex` inside the
  legacy model/variant controls.

### 5.5 Composer dropdown surfaces (shared spec)

Class `claxedo-composer-menu` (applied to every menu hanging off the dock):

- `width: min(360px, 100vw − 24px)` (compact variant 180px, harness 210px,
  merged picker 304px); `padding: 4px` (picker 6px);
- `border: 0`, `border-radius: var(--surface-overlay-radius, 8px)`,
  `box-shadow: var(--v2-elevation-floating)` (carries its own 0.5px ring),
  `background: var(--overlay-surface)` (`#191919`);
- rows (`menu-v2-item`, select items, list items): min-height 28px,
  padding 0 10px, gap 8px, radius `--radius-sm`, 13px/400;
- two-line picker rows (`data-slot="context-chip-row"`): label 13px + detail
  11px `--v2-text-text-faint`, line-height 16px, ~44px total;
- group headers: height 24px, padding 0 10px, 11px/500,
  letter-spacing 0.05px, color `--v2-text-text-faint`; sticky list headers
  get an opaque `--overlay-surface` background.

MenuV2 defaults that still apply inside: hover row paint
`--v2-overlay-simple-overlay-hover`, foreground tokens
`--v2-text-text-base`/`-faint`, check indicator via
`[data-slot="menu-v2-item-indicator"]`.

### 5.6 New-session variant (context row above composer)

On the new-session screen the composer (`variant="new-session"`, inline
placement: `max-w-[720px] px-0`) sits under a context row that reads as the
lip of a card stacked behind it:

```
<div data-component="session-context-row"
     class="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-t-xl
            border border-b-0 border-v2-border-border-muted
            bg-v2-background-bg-deep px-1.5 pt-1 pb-3">
  [project chip]      data-slot="context-chip-project"    avatar (project color) + name
  [environment chip]  data-slot="context-chip-environment" cloud/laptop icon + "Cloud"/"Local"
  [worktree chip]     data-slot="context-chip-worktree"    isolation icon + branch/workspace
  — or, self-hosted:  pinned non-interactive chip: green 6px dot +
                      name (13px --v2-text-text-base) + faint detail
```

Each chip trigger: `flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md
px-2 text-compact font-body leading-4 text-v2-text-text-muted`, hover/expanded
`bg --v2-overlay-simple-overlay-hover` + `text-v2-text-text-base`; leading
16px icon slot in `--v2-icon-icon-muted`. The composer card overlaps this row
by 8px (`-mt-2` context in the new-session layout), leaving a 4px visible lip
of `--v2-background-bg-deep` (`#080808`) under a `--v2-border-border-muted`
hairline.

The docked (existing-session) composer has NO project/environment chips — that
context lives in the header and environment card instead.

---

## 6. Implementation checklist for pixel parity

1. Paint the pane `#151515`, not `#121212`; only the titlebar row is
   `#121212`.
2. User bubble: `#2e2e2e`, radius 10px, padding 8×12, no border, right-aligned
   at `max-width: min(82%, 64ch)`.
3. Assistant text is NOT in a card — plain markdown at 14px/1.6 on the pane
   background, 12px gaps between assistant blocks.
4. Tool rows are text-toned trigger lines (500-weight title + muted subtitle,
   14px), not boxed cards.
5. Composer: 10px-radius `#161616` card with the v2 raised elevation +
   0.5px `#232323` ring, ≥96px tall; 13px/20px editor text with `#808080`
   placeholder; 44px toolbar with 28px chips; white 32px circular send.
6. Chips never use borders — hover/expanded is `#ffffff0f` fill.
7. All dropdowns: `#191919` surface, floating elevation, 28px rows, 4–6px
   container padding.
