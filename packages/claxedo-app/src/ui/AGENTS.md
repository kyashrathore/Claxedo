# Shared UI patterns

## Right side panels

- Build right side panels with `SidePanel`, `SidePanelHeader`, `SidePanelTab` and `SidePanelToggle` from `@/ui`. Reuse `ResizeSeparator` and the shared sizing and motion helpers; do not copy their frame, header controls, drag handling or transitions into a domain.
- Mount the panel in a full-height `SidePanelArea` that contains the shell toolbar and body. Page-owned panels register through `SidePanelSlot`; retained pages receive `SidePanelScope` from the shell's active-page state. Do not nest a second panel frame inside the page body: the panel must run from the top toolbar to the bottom, with its toggle on the same header row as workspace panels.
- Keep generic components controlled and independent of workspace, placement, session, server and connection data. Domain wrappers own selection, availability/loading notices, persistence keys, width limits, tab policy, actions and terminal resize policy.
- A details view uses one fixed Details tab and replaces its content when selection changes. Additional tabs, add-tab controls and navigators belong only to wrappers that need them.
- When migrating a caller, remove its replaced frame, controls, resize/motion helpers, unused exports and obsolete imports. Verify full-height alignment, close/maximize/resize behavior and inactive-page isolation through the real desktop and phone entrypoints.

See `README.md` for the shared UI ownership map and the Marketplace and workspace wrappers for current callers.

## Visual restraint

Never draw these; remove them on sight:
- a coloured accent border or bracket on one side of a block (a left rule before a chip, a quote-style stripe on a note);
- a tinted or bordered warning box for a routine note: routine information is one muted line of text, and warning colour is kept for something the person must act on now;
- a hover underline on a list row, or any hover effect that changes a row's text;
- a heading that repeats the page's own title, or a section title that says the same thing as the heading above it;
- an icon that carries meaning with no words beside it (a laptop or cloud mark for where an account works, a gauge for usage): say it in words, and keep a lone icon only for a universal action (close, copy) with an accessible name;
- a disabled control or a "not available yet" block for something the surface cannot offer: hide it;
- an internal id or internal term as primary text (`ws_…`, `prj_…`, placement, lease, code-host, work-source).
