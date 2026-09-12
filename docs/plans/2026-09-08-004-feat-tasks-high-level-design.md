---
title: "Tasks and Presets — High-Level Design"
type: feat
status: scoped-design
created: 2026-09-08
updated: 2026-09-12
scope: presets-tasks-subtasks-and-linked-sessions
---

# Tasks and Presets — High-Level Design

## 1. Product decision

Build two user-facing features: **preset creation** and **task creation**. A preset describes how and where an agent should work. A task describes the work and preserves links to the ordinary sessions where it happens.

A preset is the scoped foundation for possible named bots later. Its name identifies reusable settings today; it does not provision an agent identity, memory namespace, credentials, inbox, schedule or standing responsibility. The user still addresses one @claxedo. Future bots can compose these settings without changing what a task means.

This revision adds presets to the previous minimal Tasks scope. Agent planning documents/acceptance, activity/comments and Tasks-owned Run orchestration remain excluded. A planning model configuration is supported; a planning workflow engine is not included.

Read the [LLD](2026-09-08-005-feat-tasks-low-level-design.md), [implementation plan](2026-09-08-006-feat-tasks-implementation-plan.md), [acceptance journeys](2026-09-08-007-feat-tasks-acceptance-journeys.md) and [goal.md](../../goal.md). Shared context/memory remains a separate workstream.

## 2. Preset creation

A user creates a named preset, chooses Local or Cloud, selects a primary harness/model/effort, and optionally writes instructions. Advanced settings allow additional configurations for Planning, Implementation and Review. These labels describe intended use, not separate bots or scheduled stages. The user chooses a configuration when starting a session; the primary configuration is the default.

Instructions may explain when and how to use the configurations together. The host supplies the resolved configuration names/settings through its session instruction mechanism. Actual delegation requires a supported tool and validated configuration; a model name in prose cannot switch harnesses, transfer context or grant capabilities. There is no automatic Plan→Execute transition. Existing session delegation may be used where the runtime supports the selected settings and inherited access; otherwise the user starts the appropriate linked session explicitly.

| Field | Behavior |
|---|---|
| Name | User-facing reusable settings name; not an execution identity |
| Execution | Local or Cloud; no automatic cross-placement fallback |
| Primary configuration | Harness, provider/model and optional effort |
| Additional configurations | Optional Planning, Implementation and Review harness/model/effort choices |
| Instructions | Optional guidance, including how to use the model group; does not override host authority |
| Local skills/plugins | Use current local configuration; no selected-only guarantee in this slice |
| Cloud skills/plugins | Explicit selected set in an isolated execution environment; empty means none of these optional capabilities |

Presets are personal to their authenticated owner in this slice. They are reusable across that owner's authorized projects. Shared catalogs, bot identities and preset-owned credentials are deferred. Saving a preset launches nothing and installs/connects nothing. Plugin installation and connection setup remain in existing settings; a missing capability is shown before Start.

Model/effort selectors use current configured provider and harness capabilities. The harness agent, OpenCode's behavioral profile, is not a preset field; the host resolves it by harness default at start, exactly as the composer does when no agent is chosen. Saved settings are revalidated for the actual task target. Never silently replace an unavailable model, effort, harness, plugin or skill. Preset edits affect future starts; existing sessions retain the settings resolved when created. Current authorization is still checked on every protected operation.

## 3. Task creation and start

1. Create a task with title, optional description and project; status defaults to To do. Add one level of subtasks for visibility. Saving launches nothing and does not require a preset.
2. Click **Start task** or **Start subtask**. A preset is required. Choose one and, when it has a group, a configuration. The dialog previews placement, model/effort, instructions and capability behavior. The app ships with no presets and has no hidden default; when none exist, the dialog creates one inline without discarding the task/start draft.
3. Local resolves the task's authorized local workspace. Cloud creates an isolated workspace/runtime through existing host infrastructure, using the task's project source and the preset's selected capabilities. A local checkout's uncommitted work is not automatically copied to cloud; the source/ref must be visible and validated before Start.
4. The host creates an ordinary session, saves its canonical reference and supplies preset instructions plus task title/description through their respective instruction/message paths. The session opens for conversation, permissions, stopping and recovery.
5. Return later and open the saved session. Task statuses remain manual regardless of session outcomes.

Each task/configuration slot, Primary, Planning, Implementation and Review, has at most one live root session at a time. Only configured slots appear as start choices. Whether a slot is occupied is derived from the canonical session owner at read time, never stored by Tasks. While the linked session is live, the slot opens it, concurrent starts converge on that one session, and conflicting preset/settings choices are rejected. When the session owner reports the linked session archived, deleted or unavailable, the slot offers **Start again**; that creates a new session under the next attempt and keeps the earlier link as history. Changing a preset never replaces a live session. Restarting a slot whose session is still live, and attaching an existing session to a task, are outside this slice; starting a fresh session from any state is the intended later extension.

This replaces the earlier one-session-per-task restriction. A parent and each subtask have their own slots. Root sessions are listed as links, not a Run history. Runtime child sessions remain accessible through ordinary session navigation; creating a child never creates a task or subtask implicitly.

A new root session receives task text and preset instructions. Nothing from another session is copied unless the user chooses it. The start dialog accepts explicit handoff text. When a slot is started again and its previous session's transcript is still readable, the dialog also offers **Continue from previous session**: the host reuses the runtime's existing handoff transaction, which renders that session's turns and tool output into the new session's instructions within its existing size caps. A deleted or unreadable previous session starts from task text alone. No fabricated memory continuity is promised.

## 4. Task rules and UI

Tasks contain title, description, project, optional local workspace preference, manual status and optional parent. A Claxedo code project is an execution target, not a Linear-style deliverable grouping. The selected local/cloud destination is resolved for each session and retained in its canonical reference.

Use manual statuses `todo`, `doing`, `needs_you`, `done`. One-level children stay in the same project. Parent Done requires all nonarchived children Done; reopening/adding a child requires an open parent. Completion of all children does not complete the parent automatically. Archive retains links and performs no session operation; archive children first. Project changes are refused after linking a session or while children remain attached.

Use the supplied Circle screenshots for a dense list/board and title-first task detail, composed from current Solid UI and theme tokens. Collection includes Active, Backlog, All tasks, project/status filters and child visibility. Preserve accessible menu alternatives to board drag, drafts on errors, focus and Back position.

Provide a Presets entry/editor alongside Tasks. Start is a small dialog, not a permanent settings panel on every task. Detail shows the task text, children, properties and linked sessions with configuration labels and attempt history. Open a live slot directly; offer Start for configured slots without a live session, including those whose earlier session is archived, deleted or unavailable. Do not show Plan, Activity, Runs or agent-assignment tabs.

## 5. Local and cloud execution

Local execution reuses the selected host's current skill/plugin configuration. The UI says **Use local skills and plugins**. It must not show a misleading enforced allowlist or change local/global plugin settings to apply a task preset.

Cloud selected-only support requires an isolated runtime/configuration root, filesystem and brokered credential set for each root start. For this slice, separate tasks and separate root slots receive separate cloud workspaces. Child sessions belonging to a root may share its environment and capability set. A stopped workspace is restored with that root's retained configuration. Sharing an environment between different capability sets is deferred.

Isolation is implemented by workspace/session infrastructure, not by a Tasks worker. Hosting the control plane on Cloudflare does not itself provide isolation; existing sandbox infrastructure executes agents. Provisioning, suspend/resume and cleanup stay with that owner. Archive/preset edits do not destroy a workspace or alter active sessions. Storage/checkpoint retention must preserve the advertised reopen behavior.

For cloud, selected plugins contribute their declared tools and bundled skills; separately selected skills add guidance. Deduplicate shared skills by source identity/revision. Per-tool editing and excluding individual skills inside an enabled plugin are deferred. Required platform tools are separately identified in the preview; selecting no plugins does not remove basic session tools.

Selected-only means Claxedo exposes/materializes only the chosen optional capabilities and supplies no unselected plugin credentials. It does not claim that ordinary file/shell/network access prevents equivalent user-written actions. A skill found inside the task's own repository remains repository content. Stronger workload sandbox policy is a separate host responsibility.

## 6. Library and host ownership

Keep one optional `@claxedo/tasks` package in `packages/claxedo-tasks` for preset/task records, rules, finite API/client and Solid UI. Separate preset and task modules/public contracts within it. A later bot feature can reuse the preset contract; this slice introduces no second package or general plugin framework.

Hosts supply SQLite/D1 storage, verified authority, capability catalogs, workspace preparation and canonical session creation/navigation. Local/Node metadata uses host SQLite; hosted metadata uses control-plane D1 and is available while workspaces are stopped. The package stores no credentials, transcript, model result or execution lifecycle.

The session/workspace layer owns resolved configuration, immutable instruction/plugin references, start replay, capability enforcement and environment lifecycle. Preset references are provenance, not a live pointer that reconfigures sessions. There is no Tasks Run, lease, observer, autonomous retry or outcome→task-status mapping.

`CLAXEDO_BUILD_TASKS` selects both features for this delivery. Off artifacts exclude preset/task implementation, styles, routes and migrations. Retained data and existing ordinary sessions remain usable through their normal owners. Generic session capability contracts must not import the optional package or require it to resume an existing session. Independent feature flags can be introduced later only when another actual consumer needs them.

## 7. Delivery and proof

Deliver optional composition, both catalogs, existing UI composition, local start, isolated cloud capabilities, qualified model-group behavior and final acceptance. The implementation plan defines S1–S8 and explicit gates.

Tests must prove preset persistence/validation, task/subtask rules, slot idempotency, Start again after the linked session is archived or deleted, continue-from-previous handoff, durable links, instructions and effective settings, two cloud tasks with different capability sets, no mutation of local configuration, restart/resume, current authorization and feature exclusion. Automated E2E and live computer use are separate requirements. These are proposed designs, not completed behavior.
