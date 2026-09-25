# UI kit

v2's own components and tokens. Surfaces ported from today's app render with today's kit (`@opencode-ai/ui`), and today's global CSS (`src/shell/styles`) styles the kit's selectors for the whole page, so every `data-component`, `data-slot` and class name here carries the `v2-` prefix (`[data-component="v2-select"]`, `.v2-icon-button`): an unprefixed name would take the kit's rules, and a kit dialog would take these. Names stay inside this folder.

## One door to today's kit

Owner ruling: v1's look is the kit. `@opencode-ai/ui` and `@opencode-ai/session-ui` may be imported only inside `src/ui`; everything else imports them from `@/ui`, which re-exports what the app uses. v1's token names are allowed, since they are the look. The only kit stylesheet imports outside `src/ui` are the two `@import`s at the top of `shell/styles/index.css` and the two v2 sheets `src/styles.ts` loads (menu and tooltip), listed exactly in `scripts/checks/v2-only.ts`. Nothing imports `@opencode-ai/session-ui`, not even here: v2's copies of its renderers and sheets live in `src/transcript`. A sheet is loaded only for a component the app renders: the kit's `select-v2.css` (no v2 surface renders `SelectV2`) nests `> *:not([role=presentation]) + *:not([role=presentation])` under two attribute-only compounds, so under any `[data-component]` and `[data-slot]` ancestors Blink's ancestor filter cannot reject it, and every element matched below flags its parent as affected by `+` rules. The transcript's virtual list sits under both, so each row a scroll added or removed restyled the whole list: 11,664-14,192 elements restyled over a 3,000 px wheel scroll, against 5,063-5,073 without the sheet (today's app, whose timeline has no `[data-component]` ancestor: 7,052-7,105).

No `data-component` hooks outside what something reads: `scripts/checks/claxedo-names.ts` allows a value only when a stylesheet, a selector, an e2e flow or the perf harness selects it (the ClaxedoIcon and ClaxedoIconButton controls take the kit's icon and icon-button styles through `icon` and `icon-button`). v2's own components style themselves by class.

## Owned concepts

- **Tokens.** The kit's: `--v2-*` ramps and semantic tokens come from `@opencode-ai/ui/v2/styles`, the type scale, radii and shadows from the kit's theme, all loaded by `shell/styles/index.css`. The one token of v2's own is `--touch-target` (`touch.css`).
- **Global styles.** `styles.css` declares the layer order (with `touch` between `components` and `utilities`) and loads the touch rules and the reduced-motion rule (`reduced-motion.css`, `!important` in `base`, so it beats every later layer). Tailwind runs once, in `shell/styles/index.css`.
- **Icons.** Icons are today's app's `ClaxedoIcon` (below) and the kit's `Icon`, `IconV2` and `ProviderIcon`, all through `@/ui`.
- **Scroll thumb.** `createScrollThumb` (`scroll-view-thumb.ts`) derives the thumb's geometry only while the thumb is visible (hovered, scrolled by input, or dragged): becoming visible measures the viewport once, a resize of the viewport or its first child re-reads the extent, and a scroll moves the thumb from that extent and `scrollTop`. While it is hidden it reads and writes nothing, so a transcript growing under a streaming reply costs it nothing; the kit's thumb wrote its geometry 608 times per streamed turn, each write after a forced layout read.
- **Dialogs.** `Dialog`, `DialogProvider` and `useDialog()` are the kit's (`@opencode-ai/ui/dialog`, `@opencode-ai/ui/context/dialog`), so dialogs look and stack as they do today.

## Controls from today's app (`controls/`, `icons/`)

These are today's app's own controls, moved here unchanged, and every surface ported from today's app draws its icons through them.

- **`ClaxedoIcon`** (`controls/claxedo-icon.tsx`, names in `icons/catalog.ts`, per-theme maps in `icons/codex.ts` and `icons/opencode.ts`, `icons/config.ts` re-exports the kit's icon-library preference, one process-local signal that `ThemeProvider` keeps in step).
  - Licence risk, known and accepted for now: every `codex-20-*` id addresses artwork extracted byte-identically from the proprietary ChatGPT desktop app, not from the Apache-2.0 `openai/codex` repository (see `packages/ui/src/components/codex-icons.tsx`). Choosing the `opencode` icon library (`setIconLibraryPreference`) reverts to the unencumbered upstream set. The entries marked accepted in the 2026-09-09 review stay as they are.
  - Marks the extracted sprite lacks are drawn locally: a bare dismiss X (its only X sits inside the ring `circle-x` uses as a status glyph), a plain tick (its check is a circle-based checklist glyph), the `worktree` mark (a 10-unit optical box at stroke 1.25), Marketplace, Models and Providers (the sprite would give all three one sparkle), and MCP (lobe-icons, MIT, which the sprite would draw as the `link` node graph). `close`, `mcp` and the navigation marks are byte-identical to the same names in `packages/ui/src/components/icon.tsx`, so either component draws the same mark. `codex.ts` stays in step with the kit's `codex-icon-map` (082 is the warning triangle, 083 the share arrow).
  - Harness logos (LobeHub, MIT; OpenCode's own geometry) are scaled from 24 units to about 14 and centred: dense filled marks at full size read heavier than the thin glyphs beside them. They fill with `currentColor`. The copy mark's 11-unit box is scaled up around the grid centre to match its 14-unit neighbours.
  - The custom glyph table is a `Record`, not a `Partial`: a missing `codex-custom-*` entry would fall through to a sprite id that does not exist and render an invisible icon with no error.
  - `bare` selects the compact size scale (14/16/18/20 px as attributes) and drops the `data-component`/`data-size` grammar; the default scale (16/20/24/24 px) is sized by the kit's icon.css in `@layer components`. The `ui-icon` class twins the data attribute because the stylesheets match classes, which the browser buckets more cheaply than the shared `data-slot` attribute.
  - The sprite lives in `document.body` and records its markup length, so a hot reload that changes the glyphs rebuilds it.
- **`ClaxedoIconButton`**: starts at full strength (an icon button that says nothing about its state is always on screen), which also lets a filled `primary` button keep its inverse foreground.
- **`ClaxedoLogo`**: the pixel C on a 32 px grid, shifted +32 px to centre it optically against its open side; tiles are 33 px so neighbours merge into a solid letter at any size.
- **Portal slots** (`controls/portal-slot.ts`): one mutable mount point each, claimed by a persistent strip through `ref` and filled elsewhere through `<Portal mount={slot()}>`; a new element replaces the previous one. The review toolbar and review controls render in place when their slot is empty.
- **Delayed loading** (`controls/delayed-loading.tsx`): nothing is painted until a load outlasts 100 ms, because painting and removing a loader faster reads as flicker. An `episode` names one wait that successive fallbacks stand in for, so the delay counts from the first; the episode ends at the end of the task in which no indicator for it is mounted, because a fallback swap disposes the old indicator before mounting the next.
- **Reduced motion** (`controls/reduced-motion.ts`): the one read of `prefers-reduced-motion` for JS-driven motion (`animateHeightChanges` skips its animation); false where `matchMedia` is missing.
- **`animateHeightChanges`**: a CSS transition cannot animate `auto` height, so the box is animated from its last settled height when its content resizes; resizes of the box itself (a window resize) only update the settled height.

## Phone

Every component works at 390 px with a coarse pointer: `touch.css` gives compact controls a 44 px hit area and rows a 44 px minimum height, and reveals every affordance that a mouse would only show on hover.

## Origin

Upstream's v2 library (anomalyco/opencode `packages/ui/src/v2` at 1d6c3c0e29) is the source of `Field` and `SegmentedControl`. `ScrollThumb` and `ScrollView` are Claxedo's own; `ScrollView` keeps the kit's markup and look. Everything else a surface draws is today's kit (`@opencode-ai/ui`), re-exported through `@/ui`.

## Components

| Component | Props (one line) |
| --- | --- |
| `Button` (the kit's, from `@opencode-ai/ui/button`, so buttons look as they do today) | Kobalte button props, `size?: small \| normal \| large`, `variant?: primary \| secondary \| ghost`, `icon?: kit icon name` |
| `Dialog` (the kit's) | `title?`, `description?`, `action?`, `size?: normal \| large \| x-large \| viewport`, `fit?`, `flush?`, `scrim?: strong`, `class?`; the body is its children |
| `DialogProvider`, `useDialog()` (the kit's) | `useDialog()` returns `{ active, show(element, onClose?), push(element, onClose?), close() }` |
| `Field` (`.Label`) | div props; `Label` takes `for`, the id its control carries, so a click on the label focuses the control (the kit's `Select` takes it through `triggerProps`) |
| `ScrollThumb` | `scroller`, `hoverTarget?`, `visibility?: hover \| scroll`; draws v2's thin overlay thumb over an element that scrolls itself. The thumb stays mounted and is `hidden` while nothing overflows: it sits after the scroller, so mounting it flips the scroller's `:last-child`, and the markdown `> *:last-child` rules then restyle the scroller's whole subtree (the Review: 651 elements on every Collapse all) |
| `ScrollView` | div props, `viewportRef?`; a region that scrolls its children with the kit's markup (`.scroll-view`, the focusable `.scroll-view__viewport` region named "scrollable content", page and arrow keys) and the kit's thumb look (`.scroll-view__thumb`), drawn by `ScrollThumb`'s machinery |
| `SegmentedControl`, `SegmentedControlItem` | `value?`, `defaultValue?`, `onChange?(value \| null)`, `allowDeselect?`, `disabled?`; item: `value`, `children`. Width is 232 px with equal segments; the class `segmented-control--full-width` fills the container, and `segmented-control--fit` sizes each segment to its label |
| `Select` (the kit's, from `@opencode-ai/ui/select`) | `options`, `current?`, `value?(item)`, `label?(item)`, `groupBy?(item)`, `onSelect?(item \| undefined)`, `onHighlight?`, plus the kit button's `variant`/`size`, `triggerVariant?: settings`, `triggerStyle?` |
| `Switch` (the kit's, from `@opencode-ai/ui/switch`) | Kobalte switch props, `children` as label, `hideLabel?`, `description?` |
| `Tag` (the kit's, from `@opencode-ai/ui/tag`) | span props, `size?: normal \| large` |
| `Toast`, `showToast`, `toaster` (the kit's, from `@opencode-ai/ui/toast`, so toasts look as they do today) | `showToast(options \| string)`: `title?`, `description?`, `icon?: kit icon name`, `variant?: default \| success \| error \| loading`, `duration?`, `persistent?`, `actions?: { label, onClick }[]`; mount one `Toast.Region` |
| `Tooltip` (the kit's, from `@opencode-ai/ui/tooltip`, so tooltips look as they do today) | Kobalte tooltip props, `value: JSX.Element`, `class?`, `contentClass?`, `contentStyle?`, `inactive?`, `forceOpen?` |
