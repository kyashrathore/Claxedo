# WorkGraph Package Boundary

Status: retained code-grounded reference
Last updated: 2026-07-13

This dated file records the stable package boundary. The authoritative product, service, status, and delivery contracts are:

- `packages/workgraph/PRD.md`
- `packages/workgraph/ARCHITECTURE.md`
- `packages/workgraph/SPEC.md`
- `packages/workgraph/TASKS.md`

## Authoritative current shape

`packages/workgraph` is the user-owned AI-work domain and embedded application service. It owns personal Streams, Tasks (`Work Item` internally), optional Outcomes, backend candidate admission, Attempts, Decisions, Recaps, activity, events, source revisions, execution profiles, and connector sync receipts.

The Claxedo app presents one main WorkGraph surface. Streams expand within it and Add task is the canonical manual work action. The existing app-global WorkspacePanel supplies one top-level toggle and hosts WorkGraph's Needs you and execution-only Settings views; the WorkGraph header controls select those views in the same panel. Zero attention leaves the WorkGraph attention body empty. Stream Settings is a tabless Stream-scoped dialog for execution overrides and Recap configuration, and Stream rows expose Recaps through a hover/focus icon and popover. Focused proposal, candidate, Task result, Decision, and actionable-Recap inspection uses dialogs over the main surface.

Source planning and Recaps publish only valid output from their exact durable Session V2 jobs. Failed generation retries from durable state and then surfaces attention without publishing substitute content.

## Composition boundary

The package composes with:

- team-managed Claxedo Connections plus per-user provider mappings and filters;
- workspace execution ports for sessions, worktrees, and hosted workspaces;
- a backend-neutral storage port and core conformance version 3;
- owner-scoped Convex state as the Claxedo Cloud default;
- SQLite as the local and default single-node OSS adapter;
- a separate portable archive port and archive conformance version 1, implemented by SQLite and Convex;
- user-supplied storage adapters in OSS deployments.

Snapshot resume across adapter restart, workspace-cleanup conformance, and owner-level permanent deletion are implemented by SQLite and Convex. Replacement browser acceptance and real Cloud deployment evidence remain tracked in `packages/workgraph/TASKS.md`; staging has not been deployed.

## Execution boundary

WorkGraph models explicit blockers and Task dependencies in its personal domain. Its embedded execution service selects every ready Task from durable state without a product-level capacity queue. One Stream owns one primary isolated execution envelope, with optional child isolation for individual Tasks.

## Maintenance rule

Update current behavior and architecture in the authoritative package documents. Keep this file aligned as a concise package-boundary reference while it remains linked from the retained plans index.
