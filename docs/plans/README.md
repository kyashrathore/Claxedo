# Claxedo Plans

Status: retained plans index
Last updated: 2026-07-26

This directory keeps active plans and concise dated references that still help
explain a maintained package or cross-package delivery contract.

## Retained Plans

- [Claxedo public website strategy](./2026-07-20-001-feat-claxedo-website-strategy-plan.md)
  - Repository implementation and local launch acceptance are complete. The
    production cutover remains active pending a named hosting/edge owner,
    analytics provider and data owner, deployed smoke evidence, and the
    monitored retirement of the legacy documentation deployment.
- [Universal sandbox checkpoints](./2026-07-27-004-feat-universal-sandbox-checkpoints-plan.md)
  - Active plan completing `2026-07-23-002`'s `U6`: snapshot/restore for all
    seven drivers under BYOK, native capture preferred so most providers need no
    object-storage binding, a portable runtime-level artifact as the universal
    floor, and the seven checkpoint defects found reviewing the landed code.
- [PostHog observability](./2026-07-28-001-feat-posthog-observability-plan.md)
  - Active implementation plan (W0–W7): PostHog is the single stack for
    product analytics and error tracking across every runtime. Normative
    amendment source for launch streams F1, F6, and §7 owner decision #2.
- [Connections emulator E2E](./2026-07-06-005-test-connections-e2e-emulate-plan.md)
  - Retained as an active test plan. The connections package, server host,
    settings UI, and WorkGraph consumer still exist, and emulator endpoint seams
    are still pending before the browser E2E can run.
- [Self-host hosted parity channel loop](./2026-07-07-002-feat-self-host-hosted-parity-and-channel-loop.md)
  - Retained as an active self-host/channel-loop test plan. CLI deploy/creds,
    pi harness, MCP, channels, and hosted auth code anchors still exist.
- [WorkGraph v2: durable work ledger](./2026-07-18-004-feat-workgraph-execution-shape-intake-trust-plan.md)
  - Active plan (rewritten 2026-07-18 after 12-simulation + market-research
    validation): three nouns (Stream/Task/Charter), per-stream master agents on
    wakes, two stream shapes (project/flow), the evidence layer (receipts +
    audit records + anti-reward-hacking gates), and the hard charter guardrails.
- [WorkGraph v2 implementation](./2026-07-18-005-feat-workgraph-v2-implementation-plan.md)
  - Companion technical plan to 2026-07-18-004: UX per surface with backend
    needs, HLD attaching every addition to a named existing seam (gateway,
    wakes sinks, command union, launchability oracle), and phased impl with
    exact files, tests, and DoD. Evolves the existing WorkGraph; nothing rebuilt.

## Maintenance

Delete completed plans when they no longer provide a maintained implementation,
deployment, testing, or package-boundary reference.
