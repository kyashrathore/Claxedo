# UI kit

The one kit of the Claxedo app: v2 components and v2 tokens, nothing from `packages/ui` or `packages/session-ui`. App code imports from `@/ui` only; `data-slot` and `ui-*` classes stay inside this folder.

## Owned concepts

- **Tokens.** `tokens/colors.css` holds the primitive ramps (`--v2-grey-*`, `--v2-blue-*`, `--v2-alpha-*`, …). `tokens/theme.css` holds the semantic tokens (`--v2-background-*`, `--v2-text-*`, `--v2-icon-*`, `--v2-border-*`, `--v2-overlay-*`, `--v2-state-*`, `--v2-elevation-*`) for the light set (`:root`, `[data-color-scheme="light"]`) and the dark set (`[data-color-scheme="dark"]`). `tokens/type.css` holds fonts, the type scale, radii and the few shadows components compose from.
- **Global styles.** `styles.css` is the app's one stylesheet entry (imported once by `src/main.tsx`): layer order, Tailwind (`@theme` maps every utility to a token), the base reset (`base.css`) and the touch rules (`touch.css`).
- **Color scheme and themes.** `theme/` owns the color-scheme preference (`light`, `dark`, `system`; `system` follows `prefers-color-scheme` live), the active theme id (`claxedo` by default) and the registry a plugin theme joins through `registerTheme`. It paints `data-theme`, `data-color-scheme`, `color-scheme` and the `theme-color` meta on `<html>`. `public/claxedo-theme-preload.js` repeats that paint before the first frame from `localStorage` (`claxedo-theme`, `claxedo-color-scheme`, `claxedo-theme-css-<mode>`), so nothing flashes.
- **Icons.** One icon library. `icon.tsx` renders a glyph from `icon/*-glyphs.ts` through one inline sprite; `file-icon.tsx`, `provider-icon.tsx` and `app-icon.tsx` render the file-type, provider and editor artwork from lazily loaded sprites and images. The Codex skin is not here; it becomes a plugin.
- **Dialog host.** `dialog-host.tsx` owns the dialog stack: `DialogProvider` renders it, `useDialog()` shows, pushes and closes.

## Phone

Every component works at 390 px with a coarse pointer: `touch.css` gives compact controls a 44 px hit area and rows a 44 px minimum height, and reveals every affordance that a mouse would only show on hover.

## Origin

Upstream's v2 library (anomalyco/opencode `packages/ui/src/v2` at 1d6c3c0e29) is the source of `Accordion`, `Avatar`, `Button`, `Checkbox`, `Dialog`, `DiffChanges`, `Divider`, `Field`, the file-tree styles, `Icon`, `IconButton`, `InlineInput`, `Keybind`, `LineComment` and `LineCommentEditor`, `Loader`, `Menu`, `ProgressCircle`, `ProjectAvatar`, `RadioGroup`, `SegmentedControl`, `Select`, `SplitButton`, `Switch`, `TabStateIndicator`, `Tabs`, `Tag` (upstream's `Badge`), `TextInput`, `TextShimmer`, `Textarea`, `Toast`, `Tooltip`, `Wordmark`, the tokens and the base styles. Upstream has no twin for the rest, so it is Claxedo's own, restyled onto the v2 tokens: `AppIcon`, `Card`, `Collapsible`, `DialogProvider` with `useDialog`, `DockShell` and `DockTray`, `FileIcon`, `ImagePreview`, `List` with `useFilteredList`, `Popover`, `ProviderIcon`, `ResizeHandle`, `ScrollView`, and the color-scheme and theme runtime in `theme/`. Upstream has no prompt-input frame in this library; the composer builds its own from `Textarea` and `DockShell`.

## Components

| Component | Props (one line) |
| --- | --- |
| `Accordion` (`.Item`, `.Header`, `.Trigger`, `.Content`) | Kobalte accordion props; `Trigger` adds `hideChevron?` |
| `AppIcon` | `id: AppIconName`, img props |
| `Avatar` | `fallback: string`, `src?`, `background?`, `foreground?`, `size?: small \| normal \| large`, `kind?: user \| org` |
| `Button` | Kobalte button props, `size?: small \| normal \| large`, `variant?: neutral \| danger \| warning \| outline \| contrast \| ghost \| ghost-muted \| loading`, `icon?: IconName` |
| `Card` (`.Title`, `.Description`, `.Actions`) | `variant?: normal \| error \| warning \| success \| info`, `accent?` (paints the rail), div props; `Title` adds `variant?`, `icon?: IconName \| false \| null` |
| `Checkbox` | Kobalte checkbox props, `label: JSX.Element`, `description?`, `hideLabel?` |
| `Collapsible` (`.Trigger`, `.Content`, `.Arrow`) | Kobalte collapsible props, `variant?: normal \| ghost`, `class?` |
| `Dialog`, `DialogHeader`, `DialogTitle`, `DialogTitleGroup`, `DialogBody`, `DialogFooter` | `Dialog`: `size?: normal \| large \| x-large`, `variant?: default \| settings`, `fit?`, `class?`, `containerClass?`; `DialogHeader`: `closeLabel?`, `hideClose?`; `DialogTitleGroup`: `title?`, `description` |
| `DialogProvider`, `useDialog()` | `useDialog()` returns `{ active, show(element, onClose?), push(element, onClose?), close() }` |
| `DiffChanges` | `changes: { additions, deletions } \| { additions, deletions }[]`, `class?` |
| `Divider` | div props |
| `DockShell`, `DockShellForm`, `DockTray` | div (or form) props; `DockTray` adds `attach?: none \| top` |
| `Field` (`.Label`, `.Prefix`, `.Suffix`, `.Control`) | `invalid?`; `Label` adds `tooltip?: string` |
| `FileIcon` | `node: { path, type: file \| directory }`, `expanded?`, `mono?`, svg props; `chooseFileIcon(node, expanded?)` gives the sprite name |
| `Icon` | `name: IconName`, `size?: small(14) \| normal(16) \| medium(18) \| large(20)`, svg props; `iconNames`, `isIconName(value)` |
| `IconButton` | Kobalte button props, `icon: IconName`, `iconSize?: IconSize`, `size?: small \| normal \| large`, `variant?: neutral \| contrast \| ghost \| ghost-muted`, `state?` |
| `ImagePreview` | `src`, `alt?`, `closeLabel?`; shown through `useDialog().show` |
| `InlineInput` | input props, `prefix: JSX.Element`, `labelWidth?`, `showCopyButton?`, `copyLabel?`, `onCopyClick?`, `numeric?`, `invalid?`, `appearance?: base \| large` |
| `Keybind` | `keys: string[]`, `variant?: neutral \| ghost`, div props |
| `LineComment`, `LineCommentEditor`, `LineCommentOverflowIcon` | `LineComment`: `comment`, `selection`, `actions?`; `LineCommentEditor`: `value`, `onInput`, `onCancel`, `onSubmit`, `selection`, `heading?`, `placeholder?`, `rows?`, `cancelLabel?`, `submitLabel?`, `autofocus?`, `mention?: { items(query) }` |
| `List<T>` | `useFilteredList` props plus `children(item)`, `search?: boolean \| { placeholder?, autofocus?, hideIcon?, clearLabel?, class?, action? }`, `filter?`, `onFilter?`, `onKeyEvent?`, `onMove?`, `activeIcon?`, `itemWrapper?`, `divider?`, `add?: { render, class? }`, `groupHeader?`, `emptyMessage?`, `loadingMessage?`, `ref?(ListRef)` |
| `Loader` | svg props (`width`, `height` default 16) |
| `Menu` (`.Trigger`, `.Portal`, `.Content`, `.Item`, `.CheckboxItem`, `.RadioGroup`, `.RadioItem`, `.Group`, `.GroupLabel`, `.Separator`, `.Sub`, `.SubTrigger`, `.SubContent`, `.Context`) | Kobalte dropdown-menu props; items add `shortcut?`, `badge?`; `Menu.Context` is the context-menu root with `.Trigger`, `.Portal`, `.Content` |
| `Popover` | Kobalte popover props, `trigger?`, `triggerAs?`, `triggerProps?`, `title?`, `description?`, `closeLabel?`, `portal?` (default true), `class?`, `style?`; closes on Escape, outside pointer and outside focus, adopting layers it opened |
| `ProgressCircle` | `percentage: number`, `size?` (14), `strokeWidth?` (1.5) |
| `ProjectAvatar` | `fallback: string`, `src?`, `variant?: ProjectAvatarStyle` (`PROJECT_AVATAR_VARIANTS` or `outline`), `unread?` |
| `ProviderIcon` | `id: string` (unknown ids draw `synthetic`), svg props; `providerIconNames` |
| `RadioGroup`, `RadioItem` | Kobalte radio-group props, `label?`, `description?`, `hideLabel?`; item: `value`, `label`, `description?`, `hideLabel?` |
| `ResizeHandle` | `direction: horizontal \| vertical`, `edge?: start \| end`, `size`, `min`, `max`, `onResize(size)`, `onCollapse?`, `onCollapseChange?(collapsed)`, `collapseThreshold?`; pointer events, so it drags by touch |
| `ScrollView` | div props, `viewportRef?`, `label?`, `thumbVisibility?: hover \| scroll`, `thumbContainer?`, `thumbHoverTarget?`; `scrollKey`, `canScrollKey`, `scrollKeyOwner`, `isScrollKeyTarget` are the keyboard rules |
| `SegmentedControl`, `SegmentedControlItem` | `value?`, `defaultValue?`, `onChange?(value \| null)`, `allowDeselect?`, `disabled?`; item: `value`, `children` |
| `Select<T>` | `options: T[]`, `current?: T`, `value?(item)`, `label?(item)`, `groupBy?(item)`, `onSelect?(item \| null)`, `onHighlight?(item)`, `placeholder?`, `appearance?: base \| large \| inline`, `invalid?`, `numeric?`, `children?(item)`, `valueClass?`, Kobalte placement props |
| `SplitButton`, `SplitButtonAction`, `SplitButtonMenuTrigger` | div props; the two parts are button props |
| `Switch` | Kobalte switch props, `children` as label, `hideLabel?` |
| `TabStateIndicator` | svg props |
| `Tabs` (`.List`, `.Trigger`, `.CloseButton`, `.Content`, `.SectionTitle`) | Kobalte tabs props, `variant?: normal \| pill \| settings`, `orientation?`; `Trigger` adds `onMiddleClick?`, `subtext?` |
| `Tag` | `variant?: neutral \| accent`, span props |
| `TextInput` | input props, `leadingIcon?`, `showCopyButton?`, `showClearButton?`, `copyLabel?`, `clearLabel?`, `onCopyClick?`, `onClearClick?`, `numeric?`, `invalid?`, `appearance?: base \| large` |
| `TextShimmer` | `text: string`, `class?`, `as?`, `active?`, `offset?` |
| `Textarea` | textarea props, `invalid?` |
| `ThemeProvider`, `useTheme()` | `useTheme()` returns `{ colorScheme(), mode(), themeId(), themes(), setColorScheme(scheme), setTheme(id), registerTheme(record), unregisterTheme(id) }` |
| `Toast` (`.Region`, `.Icon`, `.Content`, `.Title`, `.Description`, `.Actions`, `.CloseButton`), `showToast`, `toaster` | `showToast(options \| string)`: `title?`, `description?`, `icon?`, `duration?`, `persistent?`, `actions?: { label, variant?, onClick }[]`; mount one `Toast.Region` |
| `Tooltip` | Kobalte tooltip props, `value: JSX.Element`, `class?`, `contentClass?`, `contentStyle?`, `inactive?`, `forceOpen?` |
| `Wordmark` | `class?`; the Claxedo pixel wordmark |
| `useFilteredList<T>(props)` | `items`, `key`, `filterKeys?`, `current?`, `groupBy?`, `sortBy?`, `sortGroupsBy?`, `skipFilter?`, `onSelect?`, `noInitialSelection?` → `{ grouped, filter, flat, reset, refetch, clear, onKeyDown, onInput, active, setActive }` |
