---
name: workgraph
description: Organize and execute the authenticated user's AI work through WorkGraph.
---

# WorkGraph

WorkGraph is the user's personal organization for AI work. A Stream is a coherent line of work, an Outcome is a shippable result, a Work Item is executable work, and an Attempt is one immutable execution.

Use the `workgraph_*` tools in the same vocabulary shown in the app:

- inspect recent or pinned work with `workgraph_list` and `workgraph_get`;
- capture manually pasted plans with `workgraph_source`;
- create Streams and work with `workgraph_create_stream` and `workgraph_create_work`;
- analyze a source with `workgraph_propose_admission`, then wait for explicit owner confirmation and pass the exact reviewed proposal `version` as `expected_version` to `workgraph_admit`;
- list personally filtered GitHub, Linear, or Jira discoveries with `workgraph_intake`; stage one with `workgraph_stage_candidate`, then inspect its returned `source` and `admissionProposalId` through `workgraph_list` before confirming that exact proposal with `workgraph_admit`;
- preserve a source update using keep, replace, or fork as the owner directs;
- execute, pause, or cancel using the corresponding atomic tool;
- record findings, follow-up work, Decisions, and evidence as they arise;
- use Recaps to restore context after a Stream has been quiet;
- close completed or abandoned work; delete a Stream only when the service reports it remains eligible.

Never supply an owner identity or credentials. The Claxedo server binds every call to the authenticated owner and applies Attempt authority. Reuse `operation_id` only for an exact retry. Follow returned cursors when reading subsequent changes.

Manual capture, connected issues, and independent AI-session discoveries all become immutable Work Source revisions. Every path uses the same bounded admission review before it can create or reorganize Streams, Outcomes, and Work Items.
