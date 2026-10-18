# Example app plugins: A2UI surface pages

Ten app plugins whose whole UI is an A2UI v0.9 surface page. The plugin's code only sends data messages, and the Claxedo app draws them with its own components (`packages/claxedo-app/src/surface/`). On the web the plugin's code stays in the sandboxed plugin frame and only data reaches the page. On the desktop it still runs in the app, like every app plugin today.

| Plugin | What it shows | App data it uses |
|---|---|---|
| `sprint-board` | Kanban with WIP limits, owner filter, burndown, add/move/delete tasks | current project |
| `feature-flags` | Flags per environment with staged edits, review and apply, audit log, kill switch | — |
| `budget-split` | Trip expenses split to the cent, balances, greedy settle-up, budgets per category, export | — |
| `agent-launcher` | Prompt templates with variables; launches 1–5 agent sessions and follows their status | projects, sessions |
| `workbench-monitor` | Live list of open workbench tabs with status stats, filters, sorting and tab actions | workbench tabs |
| `prompt-library` | 15 templates in categories, favourites, variable forms, preview, send to a new session | projects, sessions |
| `release-train` | Staged release checklist with gating, version bump, changelog, announcement session | projects, sessions |
| `incident-commander` | Declared incident with live clock, status timeline, runbooks, stakeholder updates, postmortem session | projects, sessions |
| `retro-board` | Three-column retro with votes, merging, actions, timer, export, follow-up session | projects, sessions |
| `focus-timer` | Pomodoro state machine with tasks, daily goal, session log and settings | — |

## Trying one on the desktop app

1. Open this repository, or a project you copied the folder into, as a project in Claxedo.
2. In a local session there, ask: *Run app_plugin_add on examples/app-plugins/sprint-board.*
3. Turn the plugin on when the app asks, then open it from the sidebar or the command palette.

## Layout

Each folder has `package.json` (the `claxedo` manifest), `src/app.ts` (the sidebar item, the surface page and its commands), `src/model.ts` (pure logic, tested in `src/model.test.ts` with `bun test src`), and a view file that builds the component tree and the data model. `src/bun-test.d.ts` declares `bun:test`, because the plugin check typechecks every `.ts` file without ambient types.

## What the A2UI v0.9 catalog asks of a plugin

- Only a Button sends an action. A field, switch, slider or chip writes into the surface's data model in the app; the plugin learns the values from the `context` of the next button press, so every button that depends on inputs binds them in its context.
- Rows repeat through a template (`children: { componentId, path }`); a button inside a row names its row through a relative binding such as `{ "path": "id" }`.
- The plugin changes the UI by patching exact data paths (`/remaining`, `/columns/2/tasks`) and sends `updateComponents` only when the structure changes.
