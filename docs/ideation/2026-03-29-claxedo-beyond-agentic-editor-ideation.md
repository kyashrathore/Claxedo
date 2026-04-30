---
date: 2026-03-29
topic: claxedo-beyond-agentic-editor
focus: visionary steps for Claxedo to create 100x more value than an agentic code editor
---

# Ideation: Claxedo Beyond The Agentic Editor

## Codebase Context

Claxedo already extends the upstream OpenCode base into a broader execution environment. The strongest repo signals are:

- `packages/claxedo-app` contains first-class `page`, `pages-index`, and `workgraph` tabs, including global tabs that are not bound to a directory.
- `packages/claxedo-server/src/routes/pages.ts` and `pages-arena.ts` show Pages as persisted records with page-local arena orchestration.
- `packages/claxedo-app/src/utils/workgraph-api.ts` shows WorkGraph as a richer graph model with missions, tasks, synthesis nodes, runs, attempts, artifacts, events, and scratchpads.
- Arena already supports configurable multi-agent roles (`implementer`, `challenger`, `synthesizer`, etc.), but the role model is page-local rather than a reusable execution template.
- The current architecture is strong on primitives, but the product boundary is still split across Pages, WorkGraph, sessions, review panes, and terminal execution rather than unified around one durable mission object.

## Ranked Ideas

### 1. Mission OS
**Description:** Make every important initiative a durable mission object that owns its page, WorkGraph graph, linked sessions, runs, review history, artifacts, and status.
**Rationale:** This is the clearest step beyond "editor + agent." It turns Claxedo into a system of execution rather than a place where coding happens.
**Downsides:** Requires a strong unification layer across existing Pages, WorkGraph, sessions, and reviews.
**Confidence:** 91%
**Complexity:** High
**Status:** Explored

### 2. Living Spec Rooms
**Description:** Turn Pages into multiplayer execution rooms where humans and agents co-author a brief, debate tradeoffs, produce synthesis, and launch graph-backed work.
**Rationale:** Claxedo already has page persistence and arena orchestration. The missing leap is making Pages the live decision surface for software work, not just rich notes.
**Downsides:** Needs explicit collaboration UX, approvals, and stronger state transitions between discussion and execution.
**Confidence:** 88%
**Complexity:** High
**Status:** Explored

### 3. Cross-Repo WorkGraph
**Description:** Expand WorkGraph into a cross-repo execution graph covering code, docs, migrations, incidents, QA, and releases.
**Rationale:** Most agentic tools stall inside one repo. Real leverage comes from coordinating dependencies across repos and teams.
**Downsides:** Integration, trust, graph clarity, and failure handling become substantially harder.
**Confidence:** 86%
**Complexity:** High
**Status:** Explored

### 4. WorkGraph Templates With Roles
**Description:** Add reusable WorkGraph templates that define roles, lane structure, expected artifacts, approval steps, and handoff rules for recurring workflows like feature delivery, incident response, refactors, launches, and design reviews.
**Rationale:** This is the best bridge from today's Claxedo to Mission OS. Arena already has role concepts and WorkGraph already has execution state; templates would make those patterns reusable, teachable, and organization-specific.
**Downsides:** Needs careful template semantics so workflows stay flexible instead of becoming rigid bureaucracy.
**Confidence:** 90%
**Complexity:** Medium-High
**Status:** Explored

### 5. Outcome Engine
**Description:** Connect missions and graphs to measurable outcomes such as cycle time, review latency, bug escape rate, and release readiness.
**Rationale:** This would let Claxedo prove value in business terms rather than only in model capability terms.
**Downsides:** Attribution and instrumentation are hard, especially across mixed human/agent execution.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Better provider/model switching | Important hygiene, but not category-defining. |
| 2 | More polished IDE chrome | Useful, but does not create a new market position. |
| 3 | Plugin marketplace first | Premature before the core execution model is dominant. |
| 4 | Docs collaboration only | Too narrow without linkage to execution and ownership. |
| 5 | Pure autonomous coding | Keeps Claxedo trapped inside the agentic editor category. |

## Session Log

- 2026-03-29: Initial ideation — grounded in `claxedo-app`, `claxedo-server`, `pages`, `pages-arena`, and `workgraph`; 6 major directions considered, 5 survived.
- 2026-03-29: Refined focus — user prioritized Mission OS, Living Spec Rooms, Cross-Repo WorkGraph, and replaced the memory-graph direction with WorkGraph Templates With Roles.
- 2026-03-29: Second-pass re-evaluation — removed ideas that merely renamed existing primitives; reframed ideation around making current Pages, WorkGraph, Arena, statuses, scratchpads, artifacts, and triggers materially more powerful.

## Refinement: Make Existing Primitives Powerful

### 1. Workflow Semantics Engine
**Description:** Turn existing statuses, roles, templates, and transitions into executable policy instead of passive metadata. Page statuses should launch concrete behavior; trigger templates should actually expand into reusable run blueprints; role presets should define handoff and review obligations, not just labels.
**Rationale:** The repo already has page status transitions in `pages.ts`, trigger `template_id` in `workgraph/src/triggers/types.ts`, and role-aware arena config in `pages-arena.ts`, but those systems are only lightly connected. This is the highest-leverage way to make current features feel dramatically more powerful without inventing new nouns.
**Downsides:** Requires careful workflow DSL design so teams gain leverage without getting boxed into rigid ceremony.
**Confidence:** 94%
**Complexity:** High
**Status:** Explored

### 2. Scratchpad Review And Promotion Loop
**Description:** Make scratchpads first-class operational signals with a shared inbox, promotion rules, dismissal reasons, dependency-aware promotion, and artifact synthesis. The goal is that every important observation made during execution can become reviewed structure, not orphaned notes.
**Rationale:** WorkGraph already stores `needsReview`, `promotedToItemId`, and `dismissedAt`, and the UI already reads scratchpads and artifacts. There is also a separate in-memory orchestrator scratchpad service. That means the raw system exists, but the compounding loop is still weak and somewhat split.
**Downsides:** Easy to create noise if review queues and promotion heuristics are not tuned tightly.
**Confidence:** 91%
**Complexity:** Medium-High
**Status:** Explored

### 3. Execution Control Tower
**Description:** Upgrade WorkGraph from a graph viewer into an operations cockpit that proactively spots stalled runs, repeated permission waits, missing synthesis, aging blockers, unhealthy retries, and SLA breaches, then suggests or triggers the next action.
**Rationale:** The repo already has run attempts, trace events, session status, permission state, triggers, and polling views. Today these mostly support inspection. Turning them into active diagnosis and escalation would make the same primitives feel far more intelligent.
**Downsides:** Risk of alert fatigue if it overfires or explains obvious things noisily.
**Confidence:** 90%
**Complexity:** Medium-High
**Status:** Explored

### 4. Triggered Recurring Workflows
**Description:** Fully realize the trigger system so recurring work can spawn templated, role-aware graph runs for release checks, incident drills, docs freshness, dependency audits, migration readiness, and operational hygiene.
**Rationale:** `RecurringTrigger` already exists, including `template_id`, scheduler polling, and trigger-spawned runs. The scheduler even notes that templates would expand run goals in production, which means this is an explicit unfinished leverage point rather than a speculative feature.
**Downsides:** Needs strong guardrails, visibility, and idempotency to avoid background-work chaos.
**Confidence:** 89%
**Complexity:** Medium
**Status:** Explored

### 5. Closed-Loop Spec Execution
**Description:** Strengthen the existing page-to-spec-to-workgraph path into a self-healing loop where page state, arena synthesis, workgraph planning, execution artifacts, and review outcomes continuously reconcile each other.
**Rationale:** The plumbing already exists, but it still feels like adjacent tools connected by API calls instead of one loop. Making that loop explicit would raise the power of Pages and WorkGraph without changing their names.
**Downsides:** Can feel magical and confusing if the state machine is not visible to the user.
**Confidence:** 87%
**Complexity:** High
**Status:** Explored
