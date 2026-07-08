# Architecture Direction Flow

Status: retained E2E flow index
Last updated: 2026-07-09

This document is retained because Claxedo app Playwright tests cite its flow
numbers in file comments. It is not a remediation backlog.

## Referenced Flows

| Flow | Current test anchors | Purpose |
|---|---|---|
| 1 | `packages/claxedo-app/e2e/playwright/cold-boot.spec.ts` | Cold boot and initial shell load. |
| 2 | `packages/claxedo-app/e2e/playwright/persisted-state-boot.spec.ts` | Boot with persisted local state. |
| 7 | `packages/claxedo-app/e2e/playwright/first-prompt-local.spec.ts`, `packages/claxedo-app/e2e/playwright/first-prompt-cloud.spec.ts` | First prompt path for local and cloud workspaces. |
| 8 | `packages/claxedo-app/e2e/playwright/mid-session-config.spec.ts` | Mid-session configuration changes. |
| 10 | `packages/claxedo-app/e2e/playwright/terminal-in-workspace.spec.ts` | Terminal inside workspace. |
| 11 | `packages/claxedo-app/e2e/playwright/login-roundtrip.spec.ts` | Login round trip. |

## Maintenance Rule

If a Playwright file stops citing a flow number, remove that row. If a new
flow number is introduced, add it here with the exact test file that owns it.
Detailed remediation plans belong in code, tests, or a freshly grounded plan
with live source references.
