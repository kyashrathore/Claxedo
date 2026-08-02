---
name: workgraph
description: Organize and execute the authenticated user's AI work through WorkGraph.
---

# WorkGraph

WorkGraph is the user's personal organization for AI work. A Stream is a coherent line of work, an Outcome is a shippable result, a Work Item is executable work, and a Run is one immutable execution.

Use the `workgraph_*` tools in the same vocabulary shown in the app. Each workflow has an entry point; the tool descriptions carry the rest:

- Orient with `workgraph_attention` for what needs the owner, `workgraph_list` for a filtered snapshot, and `workgraph_get` for one record.
- Create with `workgraph_create_stream`, `workgraph_create_outcome`, `workgraph_create_task`, and `workgraph_create_work`; revise with `workgraph_update`.
- Work a Session by binding it with `workgraph_bind_session`, selecting a Task with `workgraph_select_work`, reporting through `workgraph_record_progress`, and finishing with `workgraph_complete_current_work`.
- Admit external discoveries by listing them with `workgraph_intake`, staging one with `workgraph_stage_candidate`, then confirming that exact proposal with `workgraph_admit`.

Never supply an owner identity, workspace selector, or credentials. Local embedded tools receive trusted owner scope directly from the local Claxedo composition. Standalone stdio tools call the authenticated northbound WorkGraph HTTP contract. Hosted embedded tools are unavailable until the durable invoking Session supplies verified organization-and-user provenance. Reuse `operation_id` only for an exact retry. Treat every cursor as an opaque continuation token: follow it only for the same tenant-bound collection and filter. Observe WorkGraph by re-reading current state — `workgraph_list` for the snapshot and `workgraph_attention` for work needing the owner — rather than following a change feed.

Manual capture, connected issues, and independent AI-session discoveries all become immutable Work Source revisions. Every path uses the same bounded admission review before it can create or reorganize Streams, Outcomes, and Work Items.
