# Surface

The native renderer for declarative UI: A2UI v0.9 messages over the Claxedo catalog (`@claxedo/plugin-api/surface`), drawn with the app's own kit components. One renderer serves both producers: an agent's `ui_show` reply in the transcript (`src/transcript/surface-reply.tsx`) and app plugins.

## Owned concepts

- **Surface** (`store.ts` `createSurface`): one surface id, its lifecycle, its component registry and its data model, all plain Solid state, so it can be created outside a component. `apply(message)` takes one A2UI message: it parses it against `surfaceMessageSchema` and throws `SurfaceMessageError` for a malformed message, a message addressed to another surface, an update before `createSurface`, or a second `createSurface`. The public type carries only `surfaceId` and `apply`; the view reads the state through the module's `surfaceState` symbol.
- **Lifecycle** (`model.ts` `surfaceLifecycle`): `waiting` → `live` on `createSurface`; `live` → `deleted` on `deleteSurface`, which also empties the registry and the data model; `deleted` → `live` on a new `createSurface`.
- **Component registry** (`component-registry.ts`): one store keyed by component id. `updateComponents` upserts each definition with `reconcile(..., { merge: true })`, so a definition keeps its proxy, an untouched component re-runs nothing, a changed prop re-runs only its readers, and a prop the new definition leaves out is dropped.
- **Data model** (`data-model.ts`): one store per surface. A write at a JSON Pointer (`data-path.ts`) sets exactly that path: `/` (or no path) replaces the whole model, which must be an object; a missing intermediate is created as an object; a write with no value deletes the key, or removes the list element and closes the gap. Objects and lists are written with `reconcile` so only the leaves that changed notify. `snapshot` returns a detached plain copy.
- **Bindings** (`binding.ts`): a prop is a literal or `{ path }`. Each binding reads exactly one path with property access, so a patch to `/items/3/title` re-runs only the readers of that path. An absolute path starts at the root; a relative path resolves inside the template item's scope. Input fields bound to a path write back into the data model locally, with no message per keystroke; a literal value is the field's initial value, kept in the field.
- **Templates** (`view/surface-children.tsx`): `children: { componentId, path }` iterates the list at `path` with `<Index>`, one stable child per index, whose scope is that item's path.
- **Actions** (`action.ts`): a Button's `action.event` resolves its `context` when it fires (a literal, or a path's current value, copied) and reaches `SurfaceView`'s `onAction` as a `SurfaceActionEvent`. Without `onAction`, or with `actionsDisabled`, buttons are disabled.
- **Catalog views** (`view/component-views.ts`): one view per catalog component, each a kit component through `@/ui` where one fits: Text, Markdown and Code (the transcript's `Markdown`), Icon (`icon-names.ts` maps the A2UI icon names onto kit icons), Badge (`Tag`), Link (http and https only, opened like a transcript link), Row, Column, List, Grid, Card, Tabs, Collapsible, Divider, Button, TextField and Textarea, CheckBox, Switch, ChoicePicker (radio group, select, segmented control, checkboxes or chips), Slider and DateTimeInput (native inputs), Progress, Spinner, Table, DiffStat (`DiffChanges`), EmptyState, and the page and summary primitives: Header and Section (`view/page-views.tsx`), Stat, Callout and KeyValue (`view/summary-views.tsx`) and ListItem (`view/list-item-view.tsx`). `weight` on a direct child of Row or Column is its flex-grow. A TextField's `validationRegexp` must match the whole value; a pattern that does not compile validates nothing and is logged.
- **Display rules** (pure, tested): `grid-columns.ts` turns a Grid's `columns` into its `data-columns` hook (default 2, clamped to 1–6); `key-value.ts` keeps the labelled rows of a KeyValue's literal or bound list; `table-alignment.ts` right-aligns a Table column whose present values are all numbers; `tones.ts` maps Badge tones onto the kit `Tag` (success, warning and danger restyle a neutral tag) and gives each Callout tone its icon.

## Design defaults

Every surface looks consistent by construction; authors choose structure, never spacing or colour. All colours are v2 tokens, so light and dark both hold. The stylesheets split by concern: `surface.css` (the frame, source mark and text scale), `surface-layout.css` (flex, Grid, Card, Section, Header, groups), `surface-fields.css` (buttons and inputs) and `surface-display.css` (badges, Stat, Callout, KeyValue, ListItem, Table, Progress, EmptyState).

- Spacing on a 4/8 px scale: Column gap 12, Row gap 8, Section gap 12, Grid gap 8/12/16 (`small`/`medium`/`large`), Card and Section padding 16.
- Text scale: h1 22/600, h2 18/600, h3 15/600, h4 13/600, h5 12/600 uppercase muted, body 13/400, caption 12 muted. Header titles are 18/600, Section titles 14/600.
- Buttons keep their intrinsic width in a stretching Column or a Grid cell unless they carry `weight`. Primary is the kit's contrast button, default its neutral button, borderless a ghost button in the accent colour with a hover background. A Button's `icon` draws before its label.
- Every field label (TextField, Textarea, ChoicePicker, Slider, DateTimeInput, a radio group) is 12 px medium muted, 4 px above a control that fills its column; CheckBox and Switch are toggle rows with the control before a 13 px label.
- Card and `card` Section: 1 px muted border, 10 px radius, a layer-01 background; a card, Stat or card Section inside one drops back to the base background.
- Grid columns collapse inside the Grid's own container: 5–6 become 3 under 720 px and 2 under 480 px, 4 become 2 under 560 px, 2–3 become 1 under 480 px.
- Tables: 12 px muted headers, 13 px rows with dividers, cells on one line inside a horizontal scroller, numeric columns right-aligned.
- A Column or List of ListItems drops its gap; rows are divided by a 1 px rule and a selected row has an accent tint and bar.

## Invariants

- Nothing draws until the surface is live and a component with id `root` exists. A child id with no component draws nothing until it arrives.
- Every surface draws inside `[data-component="surface"]`, which carries its source (`data-source`, agent or plugin) and shows the source's label, small and faint, in every theme. No catalog component draws an overlay, a dialog or a toast, and none looks like a permission or question request.
- Markdown and Code use the transcript's markdown pipeline, so a surface needs `TranscriptKitProviders` above it.
