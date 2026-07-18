# WorkGraph Package Boundary

Status: retained code-grounded reference
Last updated: 2026-07-13

This dated file records the stable package boundary. The authoritative product, service, status, and delivery contracts are:

- `packages/workgraph/PRD.md`
- `packages/workgraph/ARCHITECTURE.md`
- `packages/workgraph/SPEC.md`
- `packages/workgraph/TASKS.md`

## Authoritative current shape







## Composition boundary

The package composes with:

- team-managed Claxedo Connections plus per-user provider mappings and filters;
- workspace execution ports for sessions, worktrees, and hosted workspaces;
- a backend-neutral storage port and core conformance version 5;
- owner-scoped Convex state as the Claxedo Cloud default;
- SQLite as the local and default single-node OSS adapter;
- a separate portable archive port and archive conformance version 1, implemented by SQLite and Convex;
- user-supplied storage adapters in OSS deployments.

Snapshot resume across adapter restart, workspace-cleanup conformance, and owner-level permanent deletion are implemented by SQLite and Convex. Replacement browser acceptance and real Cloud deployment evidence remain tracked in `packages/workgraph/TASKS.md`; staging has not been deployed.

## Execution boundary

WorkGraph models explicit blockers and Task dependencies in its personal domain. Its embedded execution service selects every ready Task from durable state without a product-level capacity queue. One Stream owns one primary isolated execution envelope, with optional child isolation for individual Tasks.

## Maintenance rule

Update current behavior and architecture in the authoritative package documents. Keep this file aligned as a concise package-boundary reference while it remains linked from the retained plans index.
