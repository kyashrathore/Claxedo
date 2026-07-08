# Claxedo Plans

Status: retained plans index
Last updated: 2026-07-09

This directory keeps only dated plans that still have live references outside
`docs/`.

## Retained Plans

- [Connections framework](./2026-07-03-004-feat-connections-framework-plan.md)
  - Retained because `packages/claxedo-server` source comments still refer to
    this design while defining integration routes and connection storage.
- [WorkGraph flat inbox OSS](./2026-07-06-004-refactor-workgraph-flat-inbox-oss-plan.md)
  - Retained because `packages/workgraph/test/orchestrator-ratchet.test.ts`
    cites it as the deletion-ratchet design.
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

Delete new plans once their implementation lands unless a package README,
source comment, test, or public doc still cites them.
