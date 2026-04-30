# WorkGraph And Pages Future Model

Proposal for how WorkGraph, Pages, Artifacts, and Scratchpads should fit together as the future execution and context model inside Claxedo.

This document describes the target product model. It does **not** describe the current implementation in this repo.

## 1. Core Thesis

Claxedo should not treat AI work as isolated chats, loose tickets, or detached docs.

It should treat work as a durable graph with four cooperating layers:

- `WorkGraph` for execution structure and state
- `Pages` for human-facing intent and synthesis
- `Artifacts` for durable outputs
- `Scratchpads` for temporary decision memory between scheduled work

Short version:

> WorkGraph is the execution graph. Pages and artifacts make it a context graph.

## 2. Why This Matters

The current generation of AI tools is too stateless.

They lose:

- what work already happened
- what outputs were produced
- what changed after those outputs
- what the next planner or executor should trust
- what context is durable versus temporary

Claxedo should solve that by making the system reason from accumulated context, not only from the latest prompt.

## 3. Product Objects

### WorkGraph

WorkGraph is the durable execution layer.

It should own:

- sources of work
- missions
- task nodes
- synthesis nodes
- dependency edges
- runs
- attempts
- execution state
- linked sessions and runtimes
- recurring triggers

WorkGraph answers:

- what should happen
- what is happening
- what is blocked
- what already ran
- what can run next

### Pages

Pages are the durable human-facing context layer.

Pages should own:

- briefs
- requirements
- plans
- decisions
- syntheses
- reviews
- mission narratives

Pages answer:

- what this work is for
- what constraints matter
- what the current understanding is
- what humans should read first

Pages should not be passive notes. They should be living context surfaces linked to WorkGraph execution.

### Artifacts

Artifacts are durable outputs of work.

Examples:

- plans
- reports
- design docs
- summaries
- diffs
- generated files
- release notes
- migration checklists
- exports
- transcripts

Artifacts answer:

- what was produced
- what output is reusable
- what output is canonical
- what output may now be stale

Not every artifact needs to be a doc, but important artifacts should be legible and reviewable by humans and AI.

### Scratchpads

Scratchpads are temporary operational memory.

They should exist for:

- blockers
- handoff notes
- local findings
- edge cases
- scope changes
- short-lived decisions that the next scheduled work must consider

Scratchpads answer:

- what the next node should know right now

Scratchpads should not be the long-term memory layer. They should expire, be dismissed, or be promoted into durable structure.

Short definition:

> Scratchpads are for the next decision. Pages and artifacts are for durable context.

## 4. Target Relationship Between The Four Layers

The target relationship should be:

```text
Source of work
  -> Page brief / mission page
    -> WorkGraph planning
      -> Task execution
        -> Scratchpads and artifacts
          -> Page synthesis / artifact refresh
            -> Next planning cycle
```

That means:

- Pages should launch or refine WorkGraph work
- WorkGraph runs should produce artifacts and scratchpads
- Artifacts should update what Pages can confidently say
- Scratchpads should influence the next scheduled work
- The planner should reason over all of it together

## 5. Work Intake

WorkGraph should ingest work from anywhere work appears.

The long-term source model should include:

- specs
- docs
- external issue trackers
- recurring triggers
- streamed work queues
- support or ops queues
- Slack
- Discord
- Telegram
- human-created pages
- AI-created follow-on work

Short version:

> Anything that looks like work should be ingestible as a source.

Some sources are structured from the start. Others arrive as noisy streams and need normalization before graph planning.

## 6. Work Beyond Software

The abstraction should not stop at software delivery.

The same model can support:

- engineering work
- research work
- design work
- operations work
- support work
- growth work
- founder workflows
- internal system maintenance

The current wedge may remain strongest in software-adjacent workflows, but the future product should treat WorkGraph as a general orchestration graph for AI work.

## 7. Planner Input Model

For new planning, the planner should not start from a blank prompt or only from a page.

The planner should receive a planning packet built from:

- the current Page brief
- the latest Page synthesis
- mission and task nodes from WorkGraph
- open, blocked, failed, and recently completed work
- linked artifacts
- stale artifacts
- scratchpads with `blocking` or `scope_change`
- recent execution failures and retries
- source bindings and repo or system context
- recurring trigger or template context when relevant

The planner should answer:

- what already exists
- what is already covered by current tasks
- what outputs are still fresh
- what outputs are stale
- what needs a refresh node instead of a new node
- what net-new work should be created

The planner should create the smallest graph that reflects reality, not the largest graph that looks comprehensive.

## 8. Staleness Model

Artifacts and Pages should participate in a staleness system.

An artifact or page should be considered stale when:

- its source page changed after it was produced
- linked task nodes changed meaningfully after it was produced
- a newer artifact supersedes it
- upstream dependencies changed
- unresolved `scope_change` or `blocking` scratchpads exist after its timestamp
- execution failed or was retried after the artifact was marked complete

Useful states:

- `fresh`
- `needs_refresh`
- `superseded`
- `incomplete`

This is how the system should answer:

- what work got done
- what outputs matter
- whether those outputs are still trustworthy

## 9. Memory Model

There should be three memory horizons.

### Temporary memory

Scratchpads.

Used for the next scheduled work to make a better decision.

### Durable output memory

Artifacts.

Used to preserve what happened and what was produced.

### Durable reasoning and context memory

Pages plus attached node memory.

Used to preserve:

- decisions
- constraints
- system understanding
- reusable context
- domain-specific background

In the future, WorkGraph nodes should be memory-aware by attaching durable context to nodes, missions, or templates.

That attached memory should let a planner or executor avoid starting cold when related work happens again.

## 10. Role Model

Roles should exist at two levels.

### Dynamic roles

Roles chosen by the planner for a specific graph.

Examples:

- planner
- implementer
- reviewer
- researcher
- synthesizer
- operator

### Assigned or template roles

Roles that come from a reusable workflow, team policy, or mission type.

Examples:

- feature delivery lanes
- incident response lanes
- release review lanes
- support escalation lanes

The future product should support both.

Short version:

> Some roles should be discovered at runtime. Others should be encoded in reusable workflow structure.

## 11. Runtime And Hosting Model

WorkGraph should work across:

- local execution
- cloud execution
- mixed local and cloud execution

The graph itself should be a durable control-plane object, not a local-only editor artifact.

That means:

- planning should survive restarts
- runs should survive transport boundaries
- artifacts and pages should remain durable
- routing between local and cloud should not change the graph model

Short version:

> Local and cloud are runtime choices. They should not change the meaning of the work graph.

## 12. Model And Provider Model

WorkGraph should stay model- and provider-flexible.

That means:

- planners should not depend on one model family
- node execution should not depend on one provider
- workflow semantics should survive provider swaps
- graph state should remain stable even when execution backends change

The product advantage should come from the graph, memory, and workflow semantics, not only from model access.

## 13. Pages As Living Mission Surfaces

Pages should become living mission surfaces, not static docs.

A mission page should eventually show:

- the brief
- current status
- linked graph nodes
- latest artifact docs
- stale outputs that need refresh
- important recent scratchpads
- unresolved blockers
- execution history
- latest synthesis

So when a human or agent opens a page, they are not opening a note. They are opening the current state of a mission.

## 14. Artifacts As Context Graph Edges

Artifacts should not only be blobs attached to a task.

They should form part of the context graph by linking:

- source page -> artifact
- node -> artifact
- artifact -> refreshed artifact
- artifact -> dependent task
- artifact -> review page

That makes it easier for AI to answer:

- what should I trust
- what is outdated
- what should I reuse
- what should I refresh
- what happened before this task was created

## 15. Closed-Loop System

The future closed loop should be:

1. A source arrives or a Page changes.
2. The planner reads Pages, WorkGraph, artifacts, and temporary scratchpads.
3. The planner updates the graph.
4. Work executes locally or in the cloud.
5. Execution produces scratchpads and artifacts.
6. Important outputs update or refresh Pages.
7. Staleness is recomputed.
8. The next planning cycle starts from the updated context graph.

This is the key product loop:

> intent -> execution -> output -> synthesis -> refresh

## 16. Product Bar

The product should eventually be able to answer these questions at any moment:

- What is this work trying to accomplish?
- What work has already happened?
- What is happening now?
- What outputs were produced?
- Which outputs are stale?
- What should happen next?
- What context should the next node or planner read first?

If Claxedo can answer those questions reliably, it becomes much more than an agentic editor or a task tracker.

It becomes a durable operating layer for AI work.
