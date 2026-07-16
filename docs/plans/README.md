# Claxedo Plans

Status: retained plans index
Last updated: 2026-07-15

This directory keeps active plans and concise dated references that still help
explain a maintained package or cross-package delivery contract.

## Retained Plans

- [Documents core: product features and architecture](./2026-07-16-002-feat-documents-core-architecture-and-features.md)
  - Readable companion to the implementation plan: every user-facing Documents
    feature and the mechanism that powers it — one-file authority, content-hash
    CAS saves, agents-as-ordinary-collaborators (`/docs` mention + MCP tools +
    editor reactivity, no locks or pipelines), per-document hosted hydration
    with conditional write-back — with flow diagrams and a feature→mechanism map.
- [Documents core implementation plan](./2026-07-16-001-feat-documents-core-implementation-plan.md)
  - Technical implementation plan for the filesystem-authority Documents
    replacement: DocumentWorkspace port with local/repository/hosted backends,
    opaque content-hash version tokens, serialized persistence controller,
    agent-native file access (`/docs` + MCP + external-change reactivity;
    brainstorm R19–R25 superseded by owner decision), WorkGraph
    snapshot-at-ingest continuity, an unknowns register (Q1–Q15), an edge-case
    catalog, and per-unit vision-reviewed verification gates. Units D1–D14.
- [Pages filesystem documents](./2026-07-15-001-fix-pages-filesystem-documents-plan.md)
  - Current-state assessment and clean replacement product contract for one
    indexed filesystem document with managed and repository origins,
    human-agent editing, durable reopening, and normal Git commits. The
    technical execution of this contract is the 2026-07-16-001 plan above.
- [WorkGraph end-to-end execution goal](./2026-07-13-001-goal-execute-workgraph-end-to-end.md)
  - Active long-running goal for delivering the tenant-scoped personal WorkGraph across the service embedded in `claxedo-server`, SQLite, Convex, Claxedo Cloud, the single main app surface, the existing global WorkspacePanel, exact versioned Work Sources, the document-revision adapter seam, Connections-backed personal candidates, strict Session planning and Recaps, core conformance v5, opaque tenant-bound cursors, expiring capability catalogs, durable execution compensation, and core E2E verification. Local embedded tools invoke the service directly; standalone stdio MCP uses authenticated HTTP; hosted embedded tools require durable Session tenant provenance. Focused repository verification is green; the triggerable document journey, final integrated/browser proof, and configured staging deployment remain open.

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
