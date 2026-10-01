# Shared UI patterns

## Right side panels

- Build right side panels with `SidePanel`, `SidePanelHeader`, `SidePanelTab` and `SidePanelToggle` from `@/ui`. Reuse `ResizeSeparator` and the shared sizing and motion helpers; do not copy their frame, header controls, drag handling or transitions into a domain.
- Mount the panel in a full-height `SidePanelArea` that contains the shell toolbar and body. Page-owned panels register through `SidePanelSlot`; retained pages receive `SidePanelScope` from the shell's active-page state. Do not nest a second panel frame inside the page body: the panel must run from the top toolbar to the bottom, with its toggle on the same header row as workspace panels.
- Keep generic components controlled and independent of workspace, placement, session, server and connection data. Domain wrappers own selection, availability/loading notices, persistence keys, width limits, tab policy, actions and terminal resize policy.
- A details view uses one fixed Details tab and replaces its content when selection changes. Additional tabs, add-tab controls and navigators belong only to wrappers that need them.
- When migrating a caller, remove its replaced frame, controls, resize/motion helpers, unused exports and obsolete imports. Verify full-height alignment, close/maximize/resize behavior and inactive-page isolation through the real desktop and phone entrypoints.

See `README.md` for the shared UI ownership map and the Marketplace and workspace wrappers for current callers.
