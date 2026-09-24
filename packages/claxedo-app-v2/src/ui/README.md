# UI kit

v2's own components and tokens. Surfaces ported from today's app render with today's kit (`@opencode-ai/ui`), and today's global CSS (`src/shell/styles`) styles the kit's selectors for the whole page, so every `data-component`, `data-slot` and class name here carries the `v2-` prefix (`[data-component="v2-select"]`, `.v2-icon-button`): an unprefixed name would take the kit's rules, and a kit dialog would take these. Names stay inside this folder.

## One door to today's kit

Owner ruling: v1's look is the kit. `@opencode-ai/ui` and `@opencode-ai/session-ui` may be imported only inside `src/ui`; everything else imports them from `@/ui`, which re-exports what the app uses. v1's token names are allowed, since they are the look. The only kit stylesheet imports outside `src/ui` are the three `@import`s at the top of `shell/styles/index.css` and the three v2 sheets `src/styles.ts` loads, listed exactly in `scripts/checks/v2-only.ts`.

## Owned concepts

- **Tokens.** `tokens/colors.css` holds the primitive ramps (`--v2-grey-*`, `--v2-blue-*`, `--v2-alpha-*`, …). `tokens/theme.css` holds the semantic tokens (`--v2-background-*`, `--v2-text-*`, `--v2-icon-*`, `--v2-border-*`, `--v2-overlay-*`, `--v2-state-*`, `--v2-elevation-*`) for the light set (`:root`, `[data-color-scheme="light"]`) and the dark set (`[data-color-scheme="dark"]`). `tokens/type.css` holds fonts, the type scale, radii and the few shadows components compose from.
- **Global styles.** `styles.css` is the app's one stylesheet entry (imported once by `src/main.tsx`): layer order, Tailwind (`@theme` maps every utility to a token), the base reset (`base.css`) and the touch rules (`touch.css`).
- **Icons.** One icon library. `icon.tsx` renders a glyph from `icon/*-glyphs.ts` through one inline sprite. Provider artwork is the kit's `ProviderIcon`.
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

Upstream's v2 library (anomalyco/opencode `packages/ui/src/v2` at 1d6c3c0e29) is the source of `Field`, `Icon`, `SegmentedControl`, `Select` (with the menu styles its listbox uses), `TextInput`, the tokens and the base styles. `ScrollThumb` is Claxedo's own, restyled onto the v2 tokens. Everything else a surface draws is today's kit (`@opencode-ai/ui`), imported directly.

## Components

| Component | Props (one line) |
| --- | --- |
| `Button` (the kit's, from `@opencode-ai/ui/button`, so buttons look as they do today) | Kobalte button props, `size?: small \| normal \| large`, `variant?: primary \| secondary \| ghost`, `icon?: kit icon name` |
| `Dialog` (the kit's) | `title?`, `description?`, `action?`, `size?: normal \| large \| x-large \| viewport`, `fit?`, `flush?`, `scrim?: strong`, `class?`; the body is its children |
| `DialogProvider`, `useDialog()` (the kit's) | `useDialog()` returns `{ active, show(element, onClose?), push(element, onClose?), close() }` |
| `Field` (`.Label`, `.Prefix`, `.Suffix`, `.Control`) | `invalid?`; `Label` adds `tooltip?: string` |
| `Icon` | `name: IconName`, `size?: small(14) \| normal(16) \| medium(18) \| large(20)`, svg props; `iconNames`, `isIconName(value)` |
| `ScrollThumb` | `scroller`, `hoverTarget?`, `visibility?: hover \| scroll`; draws v2's thin overlay thumb over an element that scrolls itself (the kit's `ScrollView` draws its own) |
| `SegmentedControl`, `SegmentedControlItem` | `value?`, `defaultValue?`, `onChange?(value \| null)`, `allowDeselect?`, `disabled?`; item: `value`, `children`. Width is 232 px with equal segments; the class `segmented-control--full-width` fills the container, and `segmented-control--fit` sizes each segment to its label |
| `Select<T>` | `options: T[]`, `current?: T`, `value?(item)`, `label?(item)`, `groupBy?(item)`, `onSelect?(item \| null)`, `onHighlight?(item)`, `placeholder?`, `appearance?: base \| large \| inline`, `invalid?`, `numeric?`, `children?(item)`, `valueClass?`, Kobalte placement props |
| `Switch` (the kit's, from `@opencode-ai/ui/switch`) | Kobalte switch props, `children` as label, `hideLabel?`, `description?` |
| `Tag` (the kit's, from `@opencode-ai/ui/tag`) | span props, `size?: normal \| large` |
| `TextInput` | input props, `leadingIcon?`, `showCopyButton?`, `showClearButton?`, `copyLabel?`, `clearLabel?`, `onCopyClick?`, `onClearClick?`, `numeric?`, `invalid?`, `appearance?: base \| large` |
| `Toast`, `showToast`, `toaster` (the kit's, from `@opencode-ai/ui/toast`, so toasts look as they do today) | `showToast(options \| string)`: `title?`, `description?`, `icon?: kit icon name`, `variant?: default \| success \| error \| loading`, `duration?`, `persistent?`, `actions?: { label, onClick }[]`; mount one `Toast.Region` |
| `Tooltip` (the kit's, from `@opencode-ai/ui/tooltip`, so tooltips look as they do today) | Kobalte tooltip props, `value: JSX.Element`, `class?`, `contentClass?`, `contentStyle?`, `inactive?`, `forceOpen?` |

## At the swap

Things to change once the kit components v2 uses move into the app. `packages/ui` stays untouched until then, because today's app renders it.

- **ScrollView thumb:** the kit's `ScrollView` (`packages/ui/src/components/scroll-view.tsx`, `updateThumb`) already coalesces to one update per animation frame. Each frame it still reads `scrollTop`, `scrollHeight` and `clientHeight` on the viewport and `clientHeight` on the track. Those reads force the layout the timeline's virtualizer has just dirtied. The bench measured about 0.8 ms of forced layout per wheel event: 48.9 ms of 350 ms busy over 60 wheel events on an 8 MiB session. The fix:
  - cache `scrollHeight`, `clientHeight` and the track height from the ResizeObserver entries the component already registers (the viewport, its content and the thumb mount);
  - in the frame, read only `scrollTop`;
  - measure with the bench's `scrollprof.ts`.

