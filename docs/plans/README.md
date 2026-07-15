# Claxedo Plans

Status: retained plans index
Last updated: 2026-07-13

This directory keeps active plans and concise dated references that still help
explain a maintained package or cross-package delivery contract.

## Retained Plans

- [WorkGraph end-to-end execution goal](./2026-07-13-001-goal-execute-workgraph-end-to-end.md)
  - Active long-running goal for delivering the tenant-scoped personal WorkGraph across the service embedded in `claxedo-server`, SQLite, Convex, Claxedo Cloud, the single main app surface, the existing global WorkspacePanel, exact versioned Work Sources, the Docs v2 adapter seam, Connections-backed personal candidates, strict Session planning and Recaps, core conformance v5, opaque tenant-bound cursors, expiring capability catalogs, durable execution compensation, and core E2E verification. Local embedded tools invoke the service directly; standalone stdio MCP uses authenticated HTTP; hosted embedded tools require durable Session tenant provenance. Focused repository verification is green; the triggerable Docs journey, final integrated/browser proof, and configured staging deployment remain open.

- [Connections framework](./2026-07-03-004-feat-connections-framework-plan.md)
  - Retained because `packages/claxedo-server` source comments still refer to
    this design while defining integration routes and connection storage.
- [WorkGraph package boundary](./2026-07-06-004-refactor-workgraph-flat-inbox-oss-plan.md)
  - Retained as a concise package-boundary reference. Current architecture and
    delivery status live in `packages/workgraph/{PRD,ARCHITECTURE,SPEC,TASKS}.md`.
- [Connections emulator E2E](./2026-07-06-005-test-connections-e2e-emulate-plan.md)
  - Retained as an active test plan. The connections package, server host,
    settings UI, and WorkGraph consumer still exist, and emulator endpoint seams
    are still pending before the browser E2E can run.
- [Self-host hosted parity channel loop](./2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md)
  - Retained as an active self-host/channel-loop test plan. CLI deploy/creds,
    pi harness, MCP, channels, and hosted auth code anchors still exist.
- [Wakes](./2026-07-07-006-feat-wakes.md)
  - Retained because `packages/wakes/README.md` links it as the full package
    design.

## Maintenance

Delete completed plans when they no longer provide a maintained implementation,
deployment, testing, or package-boundary reference.
