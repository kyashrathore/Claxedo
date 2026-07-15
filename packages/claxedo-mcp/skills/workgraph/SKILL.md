---
name: workgraph
description: Organize and execute the authenticated user's AI work through WorkGraph.
---

# WorkGraph

WorkGraph is the user's personal organization for AI work. A Stream is a coherent line of work, an Outcome is a shippable result, a Work Item is executable work, and an Attempt is one immutable execution.

Use the `workgraph_*` tools in the same vocabulary shown in the app:

- inspect recent or pinned work with `workgraph_list` and `workgraph_get`;
- inspect the owner-bound action queue with `workgraph_attention`, and use the
  returned canonical record identity for the next detail read or mutation;
- inspect live runtime, harness, agent, model, effort, tool, repository, and
  Connection choices with `workgraph_execution_capabilities`; use
  `workgraph_refresh_execution_capabilities` only when an explicit owner-authorized
  refresh is needed;
- capture manually pasted plans with `workgraph_source`;
- verify immutable content with `workgraph_source_revision` before planning or
  confirming source-derived work;
- create Streams and work with `workgraph_create_stream` and `workgraph_create_work`;
- analyze a source with `workgraph_propose_admission`, then wait for explicit owner confirmation and pass the exact reviewed proposal `version` as `expected_version` to `workgraph_admit`;
- retry failed planning, dismiss a proposal, or reopen a dismissed proposal with
  `workgraph_review_proposal`, always using the current proposal version;
- list personally filtered GitHub, Linear, Jira, and independent-session discoveries
  with `workgraph_intake`; inspect one with `workgraph_get_candidate`, dismiss or
  restore it with `workgraph_update_candidate`, or stage it with
  `workgraph_stage_candidate`; inspect the returned immutable source and proposal
  before confirming that exact proposal with `workgraph_admit`;
- preserve a source update using keep, replace, or fork as the owner directs;
- configure Source Views with `workgraph_configure_source_view`,
  `workgraph_update_source_view`, `workgraph_delete_source_view`, and
  `workgraph_refresh_source_view`; the team Connection supplies credentials while
  the Source View supplies the authenticated user's provider identity and filters;
- execute or cancel using the corresponding atomic tool, and use
  `workgraph_stream_lifecycle` for explicit Stream lifecycle transitions;
- use `workgraph_update_execution` for Stream, Outcome, or Work Item overrides;
  Stream updates may also carry Recap settings, while WorkGraph defaults use
  `workgraph_update_defaults`;
- record findings, follow-up work, Decisions, and evidence as they arise;
- inspect Task history with `workgraph_attempts`, inspect individual Attempt details
  with `workgraph_get`, and inspect completion evidence with `workgraph_evidence`;
- use Recaps to restore context after a Stream has been quiet; actionable Recap
  notifications are available through `workgraph_notifications` and become read
  through `workgraph_mark_notification_read` with the current version;
- close completed or abandoned work; delete a Stream only when the service reports it remains eligible.

Never supply an owner identity, workspace selector, or credentials. Local embedded tools receive trusted owner scope directly from the local Claxedo composition. Standalone stdio tools call the authenticated northbound WorkGraph HTTP contract. Hosted embedded tools are unavailable until the durable invoking Session supplies verified organization-and-user provenance. Reuse `operation_id` only for an exact retry. Treat every cursor as an opaque continuation token: follow it only for the same tenant-bound collection and filter, and use `workgraph_changes` with its ordered change cursor for incremental observation.

Manual capture, connected issues, and independent AI-session discoveries all become immutable Work Source revisions. Every path uses the same bounded admission review before it can create or reorganize Streams, Outcomes, and Work Items.
