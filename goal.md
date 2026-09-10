# Goal: One @claxedo agent, powered by context and memory

## Objective

Make @claxedo the single agent people can address from any supported surface. It selects relevant authorized context, retains useful learning at the right scope, and carries work across sessions without making users create or select named bots. Context and memory are independent capabilities; tasks preserve objectives, plans, progress and activity when work needs durable tracking.

**Current state:** product direction accepted; context/memory technical design pending. The existing Tasks foundation designs and plan have been revised to remove profiles. Neither that foundation nor the broader learning system has been implemented or validated by this documentation work.

## Invariants

- One user-facing agent identity; many isolated conversations and concurrent invocations. No multiple-profile catalog, profession roster, agent assignment or profile-owned memory.
- Personal, organization, project/resource and recurring-work context follow real ownership and access. A shared agent is not a shared unrestricted credential or global transcript.
- Retrieval checks current authority; retained learning has scope/provenance and supports correction/deletion. Teaching a personal preference does not silently publish company policy.
- Context is bounded, versioned and deduplicated. Invocation evidence records exact selected sources and effective execution settings. Later changes cannot silently rewrite admitted work.
- Existing host/runtime owners govern identity, admission, placement, tools, sessions and outcomes. Never synthesize runtime evidence or use a memory label as an access grant.
- Work can begin in conversation. Tasks and boards offer durable visibility; they are not mandatory setup for every request. Saving a task or accepting a breakdown does not launch work.
- The optional Tasks library retains build exclusion across renderer/server/desktop/Worker artifacts. Shared context/memory must not become owned by that optional UI or disappear merely because the Tasks feature is excluded.
- Completion requires real learning outcomes, isolation/correction/deletion proof, automated E2E and live screenshot-driven computer use across the intended surfaces. A green task board suite alone cannot complete this goal.

## Read first, in order

1. [Repository instructions](AGENTS.md), [app instructions](packages/claxedo-app/AGENTS.md), and any nearer owner charter before editing.
2. [Accepted single-agent context/memory direction](docs/plans/2026-09-09-001-claxedo-single-agent-context-memory-direction.md): current product decision, boundaries, removed concepts and next design requirements.
3. [Tasks HLD](docs/plans/2026-09-08-004-feat-tasks-high-level-design.md) and [Tasks LLD](docs/plans/2026-09-08-005-feat-tasks-low-level-design.md): retained work-tracking foundation, now without profiles.
4. [Tasks implementation plan](docs/plans/2026-09-08-006-feat-tasks-implementation-plan.md): current code owners, delivery units U1–U10 and execution gates. It is not the complete context/memory implementation plan.
5. [Tasks acceptance journeys](docs/plans/2026-09-08-007-feat-tasks-acceptance-journeys.md): J01–J42 and evidence protocol. J13/J14 now test direct invocation and stable configuration instead of profiles.
6. [App architecture](packages/claxedo-app/src/ARCHITECTURE.md), [vocabulary](packages/claxedo-app/src/VOCABULARY.md), [contributing guidance](packages/claxedo-app/CONTRIBUTING.md), [E2E invariants](packages/claxedo-app/e2e/INVARIANTS.md), [Playwright configuration](packages/claxedo-app/playwright.config.ts), [suite selection](packages/claxedo-app/e2e/suites.ts) and [app scripts](packages/claxedo-app/package.json).

Historical only: [Company PRD](docs/plans/2026-09-08-002-feat-company-prd-design-plan.md) and [task-work plan](docs/plans/2026-09-08-003-feat-pluggable-task-work-plan.md). Their multiple-profile architecture and delivery milestones are superseded. Do not implement them or replace the deleted profile concept with a differently named equivalent.

## Priority workstream: scoped context and memory

- [ ] M1 — Trace current context/instruction/tool assembly, knowledge storage/retrieval, session identity, authorization and channel admission owners. Distinguish existing behavior from missing contracts.
- [ ] M2 — Write the technical design: source identity/scope/provenance, learning promotion, correction/conflict/deletion, authorized retrieval, context budgets/deduplication, cache invalidation, frozen invocation evidence and retrieval-failure behavior. Place ownership using current code; do not assume a new package or vendor.
- [ ] M3 — Write an incremental implementation plan and acceptance journeys for later relevant learning, unrelated-context exclusion, personal/shared isolation, correction/deletion, contradictory knowledge, duplicate-source suppression and cross-surface continuity. Pressure-test it against the real entrypoints.
- [ ] M4 — Implement and qualify the approved context/memory slices, including live user journeys. Link the technical design, implementation plan and evidence here as they are created.

The user has settled the single-agent direction. The pending work concerns technical design and verification, not another decision about whether profiles are necessary. This document does not claim that this design work has already happened.

## Retained foundation: Tasks

- [ ] U1 — Optional package and artifact selection.
- [ ] U2 — Task domain, atomic activity/receipts and SQLite/D1 stores.
- [ ] U3 — Authorized HTTP/client and current host compositions.
- [ ] U4 — Usable persisted task surface and visual catalog acceptance.
- [ ] U5 — Resolve authorized task context and existing host execution defaults for @claxedo.
- [ ] U6 — Qualify canonical invocation/configuration/recovery contracts.
- [ ] U7 — Explicit task execution, observation and recovery.
- [ ] U8 — Subtasks and guarded completion.
- [ ] U9 — Planning, constrained tools and atomic breakdown acceptance.
- [ ] U10 — Final artifacts, all Tasks acceptance journeys and live computer-use proof.

Tasks owns work records and contributes task/plan context; it does not own the shared learning system. Its existing code-project requirement is scoped to the first Code slice. General research/analytics requests to @claxedo do not require fake projects. Generalizing persisted task targets needs its own contract change.

## Evidence and completion

Preserve unrelated work. Use owning-package checks and required architecture ratchets for changed production imports. Keep active designs, schemas, APIs, UI and tests aligned; no residual profile field, endpoint, table, editor, assignment action or named-agent requirement should remain in the scoped feature.

Use the [acceptance evidence format](docs/plans/2026-09-08-007-feat-tasks-acceptance-journeys.md#6-evidence-ledger-and-release-decision) for exact commands/results, artifact identities, screenshots actually inspected and separate computer-use verification. Create real evidence indexes during implementation and link them here. Record memory-specific outcomes in the additional journeys from M3.

**Context/memory design and evidence:** pending; no implementation proof.

**Tasks evidence index:** not created; all acceptance journeys remain NOT RUN.

**Tasks engineering gates:** G1 D1 transaction/bounds, G2 exact admission/configuration, G3 outcome/cancellation, G4 agent invocation binding, G5 selected hosted artifact/deployment, G6 computer-use environment. See the [Tasks plan](docs/plans/2026-09-08-006-feat-tasks-implementation-plan.md#remaining-execution-gates-owners-and-failure-action) for owners and failure actions. These do not substitute for context/memory gates established by M2/M3.

Do not declare the product complete while required learning or surface journeys remain unverified. Report the unmet criterion, evidence, blocker, owner and concrete follow-up. No deployment or publication is implied by this documentation update.
