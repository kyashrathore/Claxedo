# 10 — Feature parity matrix (living document)

Every user-visible feature → owning sub-plan → status. Seed inventory below
is from the codebase surfaces; EXPAND during Phase 0 by walking
`first-party-content-surfaces.tsx`, `feature-ports.ts`,
`secondary-feature-ports.ts`, the dialogs directory, settings panes, and the
command/keybind inventory. Anything not in this table by end of Phase 0 is a
plan bug.

| feature | sub-plan | notes |
|---|---|---|
| Session timeline + streaming | 03 | |
| Composer (modes, attachments, todo dock) | 04 | |
| Model/harness pickers (incl. detail-load fix) | 04 | |
| Harness roster (embedded/ACP/CLI; dsh candidate) | 13 | server-side; both frontends inherit |
| Terminal surfaces + restore | 05 | |
| Rail (projects/workspaces/sessions, load-more, status badges) | 06 | |
| Panes/splits/tabs, layout persistence (v5) | 06 | |
| Review workspace (500-file), diffs, comments | 07 | |
| WorkGraph surfaces | 06/08 | hosted contribution |
| Documents/pages (tiptap editor!) | OPEN | native rich-text is a major sub-project; candidate: keep webview for pages in v1 |
| Settings (all panes incl. remote access QR) | 06 | |
| Onboarding v1 | 06 | |
| Command palette + keybinds + collisions policy | 04 | |
| Dialogs (~20: settings, select-*, fork, usage, manage-models…) | 06 | walk app/dialogs |
| Themes (light/dark/system + custom) | 02 | |
| i18n (14 locales, lazy dicts) | 02/06 | fluent or ICU messages |
| Notifications (system) | 01 | |
| Mermaid/math in markdown | 03 | mermaid = open question (HTML dep) |
| Demo mode (MSW) | OPEN | web-only? decide |
| Usage dashboard | 06 | |
| Processes pane + diagnostics | 06 | |
| Remote access / machine publish | 09 | |
| Auto-update, channels | 01 | |
| Telemetry + fatal capture | 09 | |
| A11y (screen reader, focus order) | ALL | GPUI a11y status = explicit risk |
