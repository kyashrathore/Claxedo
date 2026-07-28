# WS-E — Surfaces: Task Composer, per-project WorkGraph, autonomy/budget UI

**Parent:** `2026-07-28-004` · implements A12 (+ UI halves of A1/A5/A8/A11 from `2026-07-28-003`). Depends on WS-A (names), C1/C2/C4 (flags/commands it renders). Parallel-safe with WS-B/D.
**Standing gate:** every task here ends with **vision-reviewed screenshots (both themes)** — green DOM assertions are claims.

## Non-goals
- No new navigation paradigm: flat UI, existing content-surface system, Needs-you card unchanged in role.
- No tanstack migration for workgraph data (it uses `createResource` + hand-rolled client — keep).
- No prose-parsing of charters in the client; the client renders compiled values it received.

## E1. Placement decision (hard constraint, decided)

The Task Composer lives at the **app layer**, NOT in `features/workgraph`: `src/features/workgraph/AGENTS.md:9` `mustNotImport: ["@/features/session/*"]` is mechanically enforced (`src/architecture/agents-md.guard.test.ts`), and the composer needs session pieces. Precedent to copy exactly: `src/app/workbench/terminal/terminal-new-view.tsx:1-52` — wraps `NewSessionDesignView` from `features/session`, swaps the payload. New file: `src/app/workbench/workgraph/task-composer-view.tsx` (+ siblings).

## E2. Routes + creators

**Grounding.** Route union `src/platform/identity/route.ts:4-14` has only global `{kind:"workgraph"}` (`/workgraph`, parser `:94-138`). Header creators: `workspace-toolbar.tsx:56-118` (`WorkspaceScopeButtons` — New Session `:62-71`, New Terminal `:73-90`, dropdown `:92-115`); action factory `rail-header-actions.ts:22-42`; wired at `workbench-shell-header.tsx:136-144`. WorkGraph surface mounts via `first-party-content-surfaces.tsx:352-357`.

**Tasks:**
1. Routes: add `{kind:"workspaceWorkGraph", workspaceId}` → `/w/:workspaceId/workgraph` and `{kind:"newTask", workspaceId?}` → `/w/:workspaceId/task/new` (+ global `/task/new` that asks-where, mirroring the terminal creator's "asks before it starts anything" pattern). Builders + parser + `surface-route.ts`/`route-intent.ts` bridges.
2. Header: third creator button "New task" in `WorkspaceScopeButtons` + `createRailHeaderActions.createTask` (draft variant = the asks-where flavor, like `createTerminalDraft` `:33-42`). Keep the global `/workgraph` route working as the cross-project home (it is the pulse; per-project pages are additive).

## E3. Task Composer (two tabs)

**Grounding.** Composer bones: `session-new-design-view.tsx:62-343` (chip row: project `:206-233`, environment `:236-249`, worktree `:250-270`; slot at `:334-336`); prompt: `features/session/composer/composer.tsx` (`PromptInput`); pickers: `agent-harness-selector.tsx:123` + `select-model` `:587-620`; tab primitive: `PanelTab` (`features/workgraph/content-chrome.tsx:12` — the visual match) or `packages/ui` Tabs. Submit precedent: `submit-create-session.ts:150-168`.

**Tasks:**
1. **Compose tab:** `NewSessionDesignView` bones + intent textarea; **profile picker replaces** the raw model/harness pair — options = the target stream's compiled `execution_defaults.agents` (names + briefs; fallback "Default" = today's harness/model pickers rendered inside a disclosure when no profiles exist — never a dead end); placement chip (shared/worktree/sandbox, from WS-D enum); optional target-stream select (streams of the current project); **Draft toggle** (C2). Submit → `create_work_item` (with `draft`, `parentTaskId` absent, profile assignment override if picked) via `features/workgraph/api.ts`'s client — a thin `createTask` addition mirroring `createOutcome:305`.
2. **Streams tab:** render this project's streams — reuse `WorkGraphProjectGroups` fed a pre-filtered array (it degrades to one `ProjectSection` — grounding §6) or export `StreamCard` from `workgraph-overview.tsx:158` (prefer the export; one-line index change). Row click = file-into-stream (switches Compose tab's target-stream) or open stream.
3. **Project identity mapping (the one real design task):** the app project (from `queryOptions.projects()`, keyed `.worktree` directory) vs workgraph's derived `streamProject()` key (`workgraph-overview.tsx:19-36`: `local:${directory}` / `hosted:${repositoryUrl}`). v0 rule: match on `local:${project.worktree}` for local, and thread the mapping through ONE exported helper (`features/workgraph/project-key.ts`) so both the composer filter and E4's page share it. Server-side filter is optional-later: `GET /snapshot` query schema is `strictObject` (`http/contracts.ts:70-74`) — client-side filtering is fine at current volumes; add `directory` param only if measured (`execution-capabilities`' `directory` param at `:56-64` is the copy-pattern when needed).

## E4. Per-project WorkGraph pane

1. New surface `surface.content.workgraph.workspace` rendering `WorkGraphContent` with a `projectKey` prop → filtered `sortedStreams()` before `WorkGraphProjectGroups` (`workgraph-content.tsx:680-695`); stat strip recomputed over the filtered set; Needs-you card **unchanged** (global attention, per prior owner rule — it shows everything, labeled).
2. Stream page additions (render-only; data from C/D): charter text + compiled chips (`autonomy · width · placement · budget · verify`), spend-per-profile line (C4 `spend` + usage split), `parent › child` chips (D4), auto-admitted badge on runs/tasks (C1's `auto_admitted`), subtask one-level indent in `work-item-rows.tsx` (existing `WorkItemLeaf` `:180` + parent grouping), Draft state pill + Arm action, budget-exhausted and promotion-confirm dialogs (C1/D4 confirmation commands).

## E5. Copy pass (v0 authorship)

"Attempt" → "Run" in the renamed components (WS-A did files/identifiers; this verifies user-visible strings: `run-detail-view.tsx`, `item-dialogs.tsx:221` label fn, `waiting-source.ts` row kinds). "Staged" stays (it's the approval-gate label, unchanged). No version-archaeology strings anywhere (grep gate: `previously|legacy|renamed` in `features/workgraph` + new app files = 0).

## DoD
- E2E (extends `core-workgraph.spec.ts` patterns): create a task from the composer into an existing stream; draft→arm→launch; per-project page shows only that project's streams while `/workgraph` shows all; profile picker round-trips into launch params (assert via harness-captured session create).
- The AGENTS.md guard test stays green (composer imports both features from `app/` only).
- Vision-reviewed screenshots, both themes: composer both tabs, per-project page, stream page with compiled chips + spend, draft pill, autonomy-confirm dialog.
