---
title: "Claxedo — One Agent, Scoped Context and Memory"
type: decision
status: accepted-direction-technical-design-pending
date: 2026-09-09
supersedes: docs/plans/2026-09-08-002-feat-company-prd-design-plan.md
---

# Claxedo — One Agent, Scoped Context and Memory

## 1. Product decision

The user addresses one agent, **@claxedo**, from any supported surface. Useful specialization comes from the current request, authorized context, skills, execution environment and accumulated memory. Users do not create or select named bots, profession profiles or a roster of employees.

This replaces the multiple-profile direction. Do not rename profiles to personas, assistants or context bundles and retain the same mandatory setup. There is no profile catalog, profile assignment, profile-owned memory, profile credential or profile-specific execution identity to implement.

One agent identity can serve many independent sessions and concurrent invocations. It does not mean one global conversation, one mutable memory blob, one process or shared unrestricted credentials. Harness/model selection remains an existing execution setting; changing it does not create another agent identity.

## 2. The user experience

A user asks @claxedo in the app, a coding session or an integrated conversation. The originating surface supplies its verified actor and conversation context. Relevant authorized knowledge is selected without asking the user which bot owns it. An ambiguous target or missing authority is surfaced rather than guessed.

Work can begin in a conversation. Durable tasks provide objectives, plans, subtasks and activity when work needs tracking across sessions. A board is a view of that work, not a prerequisite for asking the agent a question. The existing task-first Code surface remains a useful entrypoint alongside conversational work.

A user can teach a correction, inspect what was retained, change it or ask that it be forgotten. The system explains the scope and source of a memory. Users should not need to recreate an agent or move knowledge between employees to correct its behavior.

A recurring responsibility later combines a standing instruction, trigger, authorized resources and relevant memory. Its name describes the job. It does not provision an independent bot or require a private copy of all company knowledge.

## 3. Ownership boundaries

| Concept | Owns | Does not own |
|---|---|---|
| Agent identity | The consistent @claxedo entrypoint | A global transcript or all users' permissions |
| Conversation/session | Current discussion and its participants | Automatic publication of everything learned |
| Task | Durable objective, plan, progress and activity | General company knowledge or a required agent assignment |
| Invocation | Exact admitted input, effective execution settings and result evidence | A permanently evolving identity |
| Context assembly | Selection of authorized instructions, sources, memory and tools for this invocation | Grants that bypass the underlying resource authority |
| Memory | Durable, attributable, correctable knowledge with explicit scope | Transient task status or a dump of all conversations |
| Host authority | Who may read, teach, share and act on which resources | Decisions inferred from a bot name |

Memory scope follows actual ownership and relevance: personal, organization, project/resource and, where useful, recurring responsibility. These are access and retrieval boundaries, not separate agents. A named reference may help users select context later, but names must not establish access or create a profile implicitly.

## 4. Requirements for the context and memory design

1. **Select before assembling.** Resolve actor, conversation, target and effective access before retrieving knowledge. Filter unauthorized candidates before ranking and output; include derived summaries and cached results in the access model.
2. **Record provenance.** Retained knowledge identifies its source, scope, revision and author or extraction process. A personal correction must not silently become company policy.
3. **Separate observation from accepted knowledge.** A model's inference or one successful execution is not automatically a general rule. Define promotion, conflict resolution and expiry policies before automatic learning ships.
4. **Make correction effective.** Updating, revoking or deleting knowledge must invalidate future retrieval and caches. Define retained audit history and already admitted invocation behavior explicitly; do not promise that deletion reverses a completed disclosure.
5. **Bound and deduplicate context.** Assemble by stable source/revision identity, maintain one owner for each instruction/tool definition, and fetch larger sections explicitly. Avoid repeated profile-style prefixes and indiscriminate conversation accumulation.
6. **Freeze invocation evidence.** Record selected references, versions, effective settings and input hash so a result can be explained. New knowledge affects subsequent invocations, not the input of a previously admitted one.
7. **Measure useful learning.** Verify that an appropriate correction changes later relevant work, stays out of unrelated work and is removed after revocation. Memory writes and search hit counts alone are insufficient.
8. **Keep admission independent.** Duplicate requests, continuation, reply destination and trigger authority still require canonical handling. Every surface reaches the same agent through an authenticated invocation; none invents an alternate unrestricted route.

These are accepted design requirements, not a claim that the memory engine or all channel integrations are built. The next technical design must trace current context/knowledge, credential, session and channel owners before selecting schemas or introducing a package. No memory vendor or new storage service is chosen by this decision.

## 5. Effect on the existing Tasks work

Keep the reusable Tasks package, current host ports, build exclusion, durable commands, plans, subtasks, activity and exact invocation recovery. Remove the Profile record/table, profile APIs/editor/filter, assignment commands and Assign & start flow. Start uses the existing host's effective execution defaults with optional advanced controls and a frozen per-run snapshot. There is no named preset store in Tasks.

The Tasks HLD/LLD and implementation plan now describe that reduced foundation. Their U5 is host context/configuration resolution, not a memory service hidden inside Tasks. Task input assembly contributes task/plan evidence to the eventual shared context system; it must not become a competing personal/company memory owner.

The earlier project-required rule remains specific to the initial Code Tasks slice. It is not a rule for every @claxedo interaction: analytics, research or support work may have other authorized targets. Generalizing durable tasks across those targets needs an explicit contract extension, not a fake code project.

The 42 existing Tasks journeys remain a foundation checklist; revised J13/J14 test direct invocation and stable settings instead of profile CRUD. They do not establish cross-session learning or availability from every surface. The context/memory technical design must add its own journeys for personal/shared isolation, corrections, contradictory knowledge, deduplication, deletion, retrieval failure and cross-surface continuity before the overall product goal can be complete.

## 6. Documents and next work

- [goal.md](../../goal.md) is the current product objective and execution entrypoint.
- [Tasks HLD](2026-09-08-004-feat-tasks-high-level-design.md) and [Tasks LLD](2026-09-08-005-feat-tasks-low-level-design.md) define the retained work-tracking foundation.
- [Tasks implementation plan](2026-09-08-006-feat-tasks-implementation-plan.md) and [Tasks acceptance journeys](2026-09-08-007-feat-tasks-acceptance-journeys.md) remain scoped to that foundation.
- The [earlier Company PRD](2026-09-08-002-feat-company-prd-design-plan.md) and [task-work plan](2026-09-08-003-feat-pluggable-task-work-plan.md) are historical. Their profile architecture and milestones must not be executed.

Next design work: map existing context/memory producers and consumers, define the scoped learning lifecycle and invocation context contract, then write the incremental implementation and acceptance plan. The architectural decision is settled: one agent, with context and memory as independent capabilities.
