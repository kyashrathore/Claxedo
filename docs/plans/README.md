# Claxedo Plans

Status: retained plans index
Last updated: 2026-07-16

This directory keeps active plans and concise dated references that still help
explain a maintained package or cross-package delivery contract.

## Retained Plans



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
- [WorkGraph approval gate + continuous execution](./2026-07-18-003-feat-workgraph-approval-gate-continuous-execution-plan.md)
  - Retained as the authoritative reference for the `pending_approval` (Staged)
    Task state, the approve/reject command contracts, and the pause/resume
    launch gate that replaced supervised/autonomous execution modes.

## Maintenance

Delete completed plans when they no longer provide a maintained implementation,
deployment, testing, or package-boundary reference.
