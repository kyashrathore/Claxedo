# Claxedo Tech Docs

Status: retained technical index
Last updated: 2026-07-09

This folder keeps technical docs that are still active, cited, or enforced.

## Canonical Architecture

- [Composable AI Infra](./ai-infra/README.md)
  - Retained because `packages/claxedo-app/src/overrides/README.md` points to
    it as the active Claxedo architecture.
- [Architecture Direction Flow](./architecture-direction-flow.md)
  - Retained because Claxedo app Playwright tests cite its flow numbers.

## Test-Enforced Docs

- [Claxedo App Performance Budgets](./claxedo-app-performance-budgets.md)
  - Retained because `workspace-runtime-route-audit.test.ts` reads it directly
    and asserts specific budget text.

## Public-Doc Support Material

- [Claxedo Server Worker Deployment Plan](./claxedo-server-worker-deployment-plan.md)
  - Retained because `public-docs/hosted-control-plane-worker.md`, worker
    source, `wrangler.toml`, and architecture tests refer to it.
- [Identity Roles Auth Foundation](./identity-roles-auth-foundation.md)
  - Retained because `public-docs/hosted-control-plane-worker.md` cites it for
    signed-mode Phase A.
- [Claxedo Up CLI Plan](./claxedo-up-cli-plan.md)
  - Retained because `public-docs/hosted-control-plane-worker.md` cites it for
    the device-login issuer phase.

## Maintenance

Do not keep speculative diagrams, historical reviews, generated evidence, or
completed implementation plans in this folder. If a reference disappears,
delete the corresponding doc in the same cleanup.
