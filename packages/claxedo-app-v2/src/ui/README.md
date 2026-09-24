# UI kit

v2's own components and tokens. Surfaces ported from today's app render with today's kit (`@opencode-ai/ui`), and today's global CSS (`src/shell/styles`) styles the kit's selectors for the whole page, so every `data-component`, `data-slot` and class name here carries the `v2-` prefix (`[data-component="v2-select"]`, `.v2-icon-button`): an unprefixed name would take the kit's rules, and a kit dialog would take these. Names stay inside this folder.

## Owned concepts

- **Tokens.** `tokens/colors.css` holds the primitive ramps (`--v2-grey-*`, `--v2-blue-*`, `--v2-alpha-*`, …). `tokens/theme.css` holds the semantic tokens (`--v2-background-*`, `--v2-text-*`, `--v2-icon-*`, `--v2-border-*`, `--v2-overlay-*`, `--v2-state-*`, `--v2-elevation-*`) for the light set (`:root`, `[data-color-scheme="light"]`) and the dark set (`[data-color-scheme="dark"]`). `tokens/type.css` holds fonts, the type scale, radii and the few shadows components compose from.
- **Global styles.** `styles.css` is the app's one stylesheet entry (imported once by `src/main.tsx`): layer order, Tailwind (`@theme` maps every utility to a token), the base reset (`base.css`) and the touch rules (`touch.css`).
- **Icons.** One icon library. `icon.tsx` renders a glyph from `icon/*-glyphs.ts` through one inline sprite. Provider artwork is the kit's `ProviderIcon`.
- **Dialogs.** `Dialog`, `DialogProvider` and `useDialog()` are the kit's (`@opencode-ai/ui/dialog`, `@opencode-ai/ui/context/dialog`), so dialogs look and stack as they do today.

## Phone

Every component works at 390 px with a coarse pointer: `touch.css` gives compact controls a 44 px hit area and rows a 44 px minimum height, and reveals every affordance that a mouse would only show on hover.

## Origin

Upstream's v2 library (anomalyco/opencode `packages/ui/src/v2` at 1d6c3c0e29) is the source of `Field`, `Icon`, `SegmentedControl`, `Select` (with the menu styles its listbox uses), `TextInput`, the tokens and the base styles. `ScrollView` is Claxedo's own, restyled onto the v2 tokens. Everything else a surface draws is today's kit (`@opencode-ai/ui`), imported directly.

## Components

| Component | Props (one line) |
| --- | --- |
| `Button` (the kit's, from `@opencode-ai/ui/button`, so buttons look as they do today) | Kobalte button props, `size?: small \| normal \| large`, `variant?: primary \| secondary \| ghost`, `icon?: kit icon name` |
| `Dialog` (the kit's) | `title?`, `description?`, `action?`, `size?: normal \| large \| x-large \| viewport`, `fit?`, `flush?`, `scrim?: strong`, `class?`; the body is its children |
| `DialogProvider`, `useDialog()` (the kit's) | `useDialog()` returns `{ active, show(element, onClose?), push(element, onClose?), close() }` |
| `Field` (`.Label`, `.Prefix`, `.Suffix`, `.Control`) | `invalid?`; `Label` adds `tooltip?: string` |
| `Icon` | `name: IconName`, `size?: small(14) \| normal(16) \| medium(18) \| large(20)`, svg props; `iconNames`, `isIconName(value)` |
| `ScrollView` | div props, `viewportRef?`, `label?`, `thumbVisibility?: hover \| scroll`, `thumbContainer?`, `thumbHoverTarget?`; `scrollKey`, `canScrollKey`, `scrollKeyOwner`, `isScrollKeyTarget` are the keyboard rules |
| `SegmentedControl`, `SegmentedControlItem` | `value?`, `defaultValue?`, `onChange?(value \| null)`, `allowDeselect?`, `disabled?`; item: `value`, `children`. Width is 232 px with equal segments; the class `segmented-control--full-width` fills the container, and `segmented-control--fit` sizes each segment to its label |
| `Select<T>` | `options: T[]`, `current?: T`, `value?(item)`, `label?(item)`, `groupBy?(item)`, `onSelect?(item \| null)`, `onHighlight?(item)`, `placeholder?`, `appearance?: base \| large \| inline`, `invalid?`, `numeric?`, `children?(item)`, `valueClass?`, Kobalte placement props |
| `Switch` (the kit's, from `@opencode-ai/ui/switch`) | Kobalte switch props, `children` as label, `hideLabel?`, `description?` |
| `Tag` (the kit's, from `@opencode-ai/ui/tag`) | span props, `size?: normal \| large` |
| `TextInput` | input props, `leadingIcon?`, `showCopyButton?`, `showClearButton?`, `copyLabel?`, `clearLabel?`, `onCopyClick?`, `onClearClick?`, `numeric?`, `invalid?`, `appearance?: base \| large` |
| `Toast`, `showToast`, `toaster` (the kit's, from `@opencode-ai/ui/toast`, so toasts look as they do today) | `showToast(options \| string)`: `title?`, `description?`, `icon?: kit icon name`, `variant?: default \| success \| error \| loading`, `duration?`, `persistent?`, `actions?: { label, onClick }[]`; mount one `Toast.Region` |
| `Tooltip` (the kit's, from `@opencode-ai/ui/tooltip`, so tooltips look as they do today) | Kobalte tooltip props, `value: JSX.Element`, `class?`, `contentClass?`, `contentStyle?`, `inactive?`, `forceOpen?` |
