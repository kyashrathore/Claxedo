# UI

The app's door to the kit, plus the few components that are the app's own.

## The kit

`packages/ui` (`@opencode-ai/ui`) is upstream OpenCode's kit at the commit in `packages/ui/UPSTREAM`, plus Claxedo's ordered patch queue in `packages/ui/patches` (owner, 2026-09-26). The app draws a kind with the kit's v2 component wherever the kit has one, and with the original-generation component otherwise:

- **v2:** `Button`, `IconButton`, `Checkbox`, `Switch`, `RadioGroup`/`RadioItem`, `SegmentedControl`, `Field`, `Textarea`, `Select`, `DropdownMenu` (menu-v2), `Keybind`, `Tooltip`, `Toast`, `Dialog` (with `DialogHeader`, `DialogTitle`, `DialogTitleGroup`, `DialogBody`, `DialogFooter`), `Accordion`, `Avatar`, `DiffChanges`, `TextShimmer`, `Tag` (badge-v2), `ProjectAvatar`. Each is exported under the concept name, so callers never name a generation.
- **Original, by exception:** `Icon`. v2's Icon draws 37 glyphs and draws "plus" for any other name, while the app uses about 70, and it has no Codex/OpenCode library switch (patch 0004). A v2 component that takes an icon name (`Button icon=`) gets a name from v2's set; anything else is the library `Icon` passed as a child.
- **Original, by exception:** `Spinner`. `loader-v2.css` sets its own muted colour, unlayered, so callers that colour the spinner (the submit button's inverse spinner, the review and files loaders) would lose it, and its spin is an infinite animation on a stateless selector, which `css-invalidation` rejects.
- **Original, no v2 exists:** `AnimatedNumber`, `Card`, `Collapsible`, `DockShell`/`DockTray`, `FileIcon`, `ImagePreview`, `useSpring`, `Popover`, `ResizeHandle`, `ScrollView`/`ScrollThumb`, `StickyAccordionHeader`, `TextReveal`, `TextStrikethrough`, and `List`, `ProviderIcon`, the dialog host (`DialogProvider`, `useDialog`), the theme and the markdown context.

## Two doors

`@opencode-ai/ui` may be imported only inside `src/ui` (`scripts/checks/v2-only.ts`). Everything else imports it through two entries, which `scripts/checks/domain-boundaries.ts` admits into `src/ui`:

- `@/ui` (`index.ts`): components, contexts and hooks;
- `@/ui/utils` (`utils.ts`): the kit's pure helpers (`checksum`, `sampledChecksum`, `Binary`, the path helpers, `readableText`, `reportUiError`, the theme's `withAlpha` and `HexColor`, the transcript's marked extensions, link helpers and `markdownEnhances`). A store or logic module takes them from here and never loads the component barrel: toast-v2 imports solid-sonner, which registers delegated events on `window.document` at import, and the app's unit tests run without a DOM.

The only kit stylesheet imports outside `src/ui` are the two Tailwind entries at the top of `shell/styles/index.css`, listed in `v2-only.ts`.

## Stylesheets

- `styles.css` declares the layer order (`theme, base, components, touch, utilities`) and loads, into `components`, the original-generation sheets of the components the app still renders, directly or through a kit module: `text-field.css` and `tooltip.css` stay because the kit's `List` renders the original `TextField` (list-search), whose copy button renders the original `Tooltip`; `icon-button.css` because the kit's `Popover`, `ImagePreview`, `List` (list-search) and that `TextField` render the original `IconButton`, and `ClaxedoIconButton` takes its styles. A sheet is dropped when its component leaves the import closure of `src`.
- **v2 sheets are unlayered.** Each v2 component imports its own sheet, and an unlayered rule outranks every layer, Tailwind's `utilities` included. A utility class (`size-8`, `z-[200]`, `text-*`) on a v2 component loses to the kit's rule; size a v2 component through its own props or modifiers (`text-input-v2--full-width`, `segmented-control-v2--fit`), inline style, or a custom property it reads (`--avatar-font-size`).
- Kobalte copies a content element's computed `z-index` onto its positioner, so menu-v2 content is raised by `app-shell.css` (`--z-modal-popover`), not by a utility on the caller.
- `touch.css` (layer `touch`, between `components` and `utilities`): at 390 px with a coarse pointer, compact controls get a 44 px hit area and rows a 44 px minimum height, and every affordance a mouse would only show on hover is revealed. Its one token is `--touch-target`.
- `reduced-motion.css`: `!important` in `base`, so it beats every later layer.

## The app's own components

- **`ClaxedoIcon`** (`controls/claxedo-icon.tsx`, names in `icons/catalog.ts`, per-library maps in `icons/codex.ts` and `icons/opencode.ts`, `icons/config.ts` re-exports the kit's icon-library preference, which `ThemeProvider` keeps in step). `ClaxedoIconV2` is the same icon on the compact size scale (`bare`).
  - Licence risk, known and accepted for now: every `codex-20-*` id addresses artwork extracted byte-identically from the proprietary ChatGPT desktop app, not from the Apache-2.0 `openai/codex` repository (see `packages/ui/src/components/codex-icons.tsx`). Choosing the `opencode` icon library (`setIconLibraryPreference`) reverts to the unencumbered upstream set. The entries marked accepted in the 2026-09-09 review stay as they are.
  - Marks the extracted sprite lacks are drawn locally: a bare dismiss X (its only X sits inside the ring `circle-x` uses as a status glyph), a plain tick (its check is a circle-based checklist glyph), the `worktree` mark (a 10-unit optical box at stroke 1.25), Marketplace, Models and Providers (the sprite would give all three one sparkle), and MCP (lobe-icons, MIT, which the sprite would draw as the `link` node graph). `close`, `mcp` and the navigation marks are byte-identical to the same names in `packages/ui/src/components/icon.tsx`, so either component draws the same mark. `codex.ts` stays in step with the kit's `codex-icon-map` (082 is the warning triangle, 083 the share arrow).
  - Harness logos (LobeHub, MIT; OpenCode's own geometry) are scaled from 24 units to about 14 and centred: dense filled marks at full size read heavier than the thin glyphs beside them. They fill with `currentColor`. The copy mark's 11-unit box is scaled up around the grid centre to match its 14-unit neighbours.
  - The custom glyph table is a `Record`, not a `Partial`: a missing `codex-custom-*` entry would fall through to a sprite id that does not exist and render an invisible icon with no error.
  - `bare` selects the compact size scale (14/16/18/20 px as attributes) and drops the `data-component`/`data-size` grammar; the default scale (16/20/24/24 px) is sized by the kit's icon.css in `@layer components`. The `ui-icon` class twins the data attribute because the stylesheets match classes, which the browser buckets more cheaply than the shared `data-slot` attribute.
  - An icon skin (`icons/skin.ts`, `IconSkinContext`) draws a name the skin covers instead of either library; the shell provides the skin of the selected theme.
- **`SemanticIcon`**: one icon per app concept (changes, files, branch, commit…), so a concept draws the same mark everywhere.
- **`ClaxedoIconButton`**: starts at full strength (an icon button that says nothing about its state is always on screen), which also lets a filled `primary` button keep its inverse foreground.
- **`ClaxedoLogo`**: the pixel C on a 32 px grid, shifted +32 px to centre it optically against its open side; tiles are 33 px so neighbours merge into a solid letter at any size.
- **`TextField`** (`controls/text-field.tsx`): the app's labelled single-line field, a `Field` holding a label, the kit's `TextInputV2` and, as suffixes, the description and the error; it keeps `label`, `hideLabel`, `description`, `error`, `invalid`, `copyable` and a string `onChange`.
- **`requestConfirm`** (`confirm.tsx`): a confirm dialog through the dialog host, resolving to the choice.
- **Portal slots** (`controls/portal-slot.ts`): one mutable mount point each, claimed by a persistent strip through `ref` and filled elsewhere through `<Portal mount={slot()}>`; a new element replaces the previous one. The review toolbar and review controls render in place when their slot is empty.
- **Delayed loading** (`controls/delayed-loading.tsx`): nothing is painted until a load outlasts 100 ms, because painting and removing a loader faster reads as flicker. An `episode` names one wait that successive fallbacks stand in for, so the delay counts from the first; the episode ends at the end of the task in which no indicator for it is mounted, because a fallback swap disposes the old indicator before mounting the next.
- **Reduced motion** (`controls/reduced-motion.ts`): the one read of `prefers-reduced-motion` for JS-driven motion (`animateHeightChanges` skips its animation); false where `matchMedia` is missing.
- **`animateHeightChanges`**: a CSS transition cannot animate `auto` height, so the box is animated from its last settled height when its content resizes; resizes of the box itself (a window resize) only update the settled height.

## Names

No `data-component` hooks outside what something reads: `scripts/checks/claxedo-names.ts` allows a value only when a stylesheet, a selector, an e2e flow or the perf harness selects it (the ClaxedoIcon and ClaxedoIconButton controls take the kit's icon and icon-button styles through `icon` and `icon-button`). Some v2 components keep original names (`switch-v2` renders `data-component="switch"`, `badge-v2` renders `data-component="tag"`, `diff-changes-v2` renders `data-component="diff-changes"`), so an original sheet for those kinds must never load beside them.

## Kit behaviour the app relies on (patches)

- **List** (0015): groups keyed by category, rows diffed by item reference, `data-active`/`data-selected` through `createSelector`. File palette "markdown": 18,458 -> 7,198 computations; command palette "settings": 29,996 -> 9,026; model picker "gpt": 75,069 -> 1,892.
- **Scroll thumb** (0016): measures only while visible; the old thumb wrote its geometry 608 times per streamed turn, each after a forced layout read.
- **Sprite shelf** (0017): every icon sprite host lives in one un-hidden `display: contents` shelf, so Kobalte's hide-outside pass writes one `aria-hidden` instead of about 500 per menu open.
- **Select** (0018, 0041, 0043): option spacing, chevron and check select by class, not under attribute-only compounds (with the sheet loaded, a 3,000 px transcript scroll restyled 11,664-14,192 elements against 5,063-5,073 without it); `triggerProps` reach the trigger button, so `for`, the accessible name and test hooks land on the element with the expanded state. The selected option draws its check (menu-v2's sheet reveals it only under `[data-checked]`, which a select option never carries).
- **Dialogs** (0051, 0052): `DialogV2` takes `aria-label` and `size="viewport"`; a `fit` dialog is as tall as its content up to its size's height (368, 480 or 600 px), or up to the container's `--dialog-v2-fit-max-height`, and scrolls past it. The list and form dialogs (`long-dialog-container`) cap at 512 px like v1's 640x512 box; the command and file palettes keep 480 px, and their container sits where v1's card did and grows downward.
- **v2 sheets** (0031, 0030, 0040, 0042, 0050, 0060, 0061): full-width text input and textarea, the fitted segmented control, menu items that grow with their content, keybind and text-shimmer sheets without their page-wide `*` rules, toasts with `role="status"`, and an accordion that clips without becoming a scroll container (sticky file headers pin to the transcript scroller).
