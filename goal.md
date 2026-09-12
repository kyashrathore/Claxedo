# Goal: One @claxedo agent, powered by context and memory

## Objective

Make @claxedo the single agent people can address from any supported surface. It selects relevant authorized context, retains useful learning at the right scope, and carries work across sessions without making users create or select named bots. Context and memory are independent capabilities; tasks preserve descriptions, subtasks, manual status and session links when work needs durable tracking.

**Current state:** product direction accepted; context/memory technical design pending. The Tasks designs and implementation plan cover two features: reusable presets and tasks/subtasks with manual status and linked sessions. Presets contain local/cloud execution, model configurations, instructions and selected cloud capabilities. They are a scoped foundation for possible named bots later; identities, agent planning documents, activity/comments and Tasks-owned runs remain excluded. Neither that foundation nor the broader learning system has been implemented or validated by this documentation work.

## Invariants

- One user-facing agent identity; many isolated conversations and concurrent invocations. Reusable named presets are settings, not separate identities, a profession roster, agent assignment or profile-owned memory. Future named-bot behavior is outside this slice.
- Personal, organization, project/resource and recurring-work context follow real ownership and access. A shared agent is not a shared unrestricted credential or global transcript.
- Retrieval checks current authority; retained learning has scope/provenance and supports correction/deletion. Teaching a personal preference does not silently publish company policy.
- Context is bounded, versioned and deduplicated. Invocation evidence records exact selected sources and effective execution settings. Later changes cannot silently rewrite admitted work.
- Existing host/runtime owners govern identity, admission, placement, tools, sessions and outcomes. Never synthesize runtime evidence or use a memory label as an access grant.
- Work can begin in conversation. Tasks and boards offer durable visibility; they are not mandatory setup for every request. Saving a task or preset does not launch work; Start task chooses a preset/configuration and explicitly creates and links an ordinary session.
- The optional Tasks library retains build exclusion across renderer/server/desktop/Worker artifacts. Shared context/memory must not become owned by that optional UI or disappear merely because the Tasks feature is excluded.
- Completion requires real learning outcomes, isolation/correction/deletion proof, automated E2E and live screenshot-driven computer use across the intended surfaces. A green task board suite alone cannot complete this goal.

## Read first, in order

1. [Repository instructions](AGENTS.md), [app instructions](packages/claxedo-app/AGENTS.md), and any nearer owner charter before editing.
2. [Accepted single-agent context/memory direction](docs/plans/2026-09-09-001-claxedo-single-agent-context-memory-direction.md): current product decision, boundaries, removed concepts and next design requirements.
3. [Tasks HLD](docs/plans/2026-09-08-004-feat-tasks-high-level-design.md) and [Tasks LLD](docs/plans/2026-09-08-005-feat-tasks-low-level-design.md): the preset/task catalogs, local/cloud execution contract and slot-based session links.
4. [Tasks implementation plan](docs/plans/2026-09-08-006-feat-tasks-implementation-plan.md): current code owners, delivery slices S1–S8 and implementation gates. It is not the complete context/memory implementation plan.
5. [Tasks acceptance journeys](docs/plans/2026-09-08-007-feat-tasks-acceptance-journeys.md): T01–T24 and the evidence protocol for presets/tasks, session linking, cloud capability isolation, model-group use and later reopening.
6. [App architecture](packages/claxedo-app/src/ARCHITECTURE.md), [vocabulary](packages/claxedo-app/src/VOCABULARY.md), [contributing guidance](packages/claxedo-app/CONTRIBUTING.md), [E2E invariants](packages/claxedo-app/e2e/INVARIANTS.md), [Playwright configuration](packages/claxedo-app/playwright.config.ts), [suite selection](packages/claxedo-app/e2e/suites.ts) and [app scripts](packages/claxedo-app/package.json).

Historical only: [Company PRD](docs/plans/2026-09-08-002-feat-company-prd-design-plan.md) and [task-work plan](docs/plans/2026-09-08-003-feat-pluggable-task-work-plan.md). Their multiple-profile architecture and delivery milestones are superseded. Implement the lightweight presets defined in the current HLD/LLD; do not inherit the historical bot identity, memory or orchestration model.

## Delegating execution

Delegate a slice to an Opus subagent or to `devin --model swe-2-max --permission-mode yolo` when all three hold: the slice is well scoped to a named owner and file set, its feedback/verification loop is tight (a test, typecheck, build or ratchet the agent runs itself after every change), and its exit criterion is explicit and checkable. Such slices do not need the strongest model. Keep tracing, design, cross-owner contract changes and any work judged by reading rather than running with the orchestrator. Read every delegated diff and rerun its checks before accepting it; a delegated "done" is a claim.

## Priority workstream: scoped context and memory

- [ ] M1 — Trace current context/instruction/tool assembly, knowledge storage/retrieval, session identity, authorization and channel admission owners. Distinguish existing behavior from missing contracts.
- [ ] M2 — Write the technical design: source identity/scope/provenance, learning promotion, correction/conflict/deletion, authorized retrieval, context budgets/deduplication, cache invalidation, frozen invocation evidence and retrieval-failure behavior. Place ownership using current code; do not assume a new package or vendor.
- [ ] M3 — Write an incremental implementation plan and acceptance journeys for later relevant learning, unrelated-context exclusion, personal/shared isolation, correction/deletion, contradictory knowledge, duplicate-source suppression and cross-surface continuity. Pressure-test it against the real entrypoints.
- [ ] M4 — Implement and qualify the approved context/memory slices, including live user journeys. Link the technical design, implementation plan and evidence here as they are created.

The user has settled the single-agent direction. The pending work concerns technical design and verification, not another decision about whether profiles are necessary. This document does not claim that this design work has already happened.

## Scoped delivery: Presets and Tasks

- [ ] S1 — Optional package with separate preset/task modules and artifact selection.
- [ ] S2 — Personal presets, tasks/subtasks, slot links, real SQLite/D1 stores and authorized API.
- [ ] S3 — Preset editor, task list/board/detail and side-effect-free Start preview.
- [ ] S4 — Canonical resolved session settings, local Start, safe replay and durable links.
- [ ] S5 — Isolated cloud workspace allocation, source/ref, lifecycle and recovery.
- [ ] S6 — Exact cloud skill/plugin projection, credential scope and isolation proof.
- [ ] S7 — Explicit model-group selection and qualified native delegation with effort/context/capability inheritance.
- [ ] S8 — Final artifact checks, T01–T24 and independent live computer-use proof.

Presets describe how/where to work; tasks describe the work. Start joins them through existing session/workspace owners. Presets have no project, credentials, memory or standing responsibility. Tasks has no planning/activity/Run system. Root sessions may occupy Primary/Planning/Implementation/Review slots; labels do not create an automatic phase workflow. Local inherits its current skills/plugins; Cloud selected-only support requires an isolated root environment and verified runtime projection.

The code-project requirement is specific to this first Code slice. The shared learning system remains independent. General @claxedo research/analytics requests do not require a task or fake code project.

## Evidence and completion

Preserve unrelated work. Use owning-package checks and required architecture ratchets for changed production imports. Keep active designs, schemas, APIs, UI and tests aligned; keep lightweight preset settings while excluding bot identities, planning documents, activity/comments and Run orchestration from this slice.

Use the [acceptance evidence format](docs/plans/2026-09-08-007-feat-tasks-acceptance-journeys.md#5-evidence-and-completion) for exact commands/results, artifact identities, screenshots actually inspected and separate computer-use verification. Create real evidence indexes during implementation and link them here. Record memory-specific outcomes in the additional journeys from M3.

**Context/memory design and evidence:** pending; no implementation proof.

**Tasks evidence index:** not created; all acceptance journeys remain NOT RUN.

**Tasks/presets engineering gates:** G1 atomic stores and distinct authority; G2 canonical session settings/origin/replay; G3 isolated cloud allocation and lifecycle; G4 exact skill/plugin selection and credential enforcement; G5 qualified model-group delegation; G6 real artifact/E2E/computer-use evidence. See the [implementation plan](docs/plans/2026-09-08-006-feat-tasks-implementation-plan.md#5-remaining-implementation-gates). These do not substitute for context/memory gates from M2/M3.

Do not declare the product complete while required learning or surface journeys remain unverified. Report the unmet criterion, evidence, blocker, owner and concrete follow-up. No deployment or publication is implied by this documentation update.
