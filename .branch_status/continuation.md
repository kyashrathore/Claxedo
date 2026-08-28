---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-28T06:27:18Z"
title: "Tenant-aware multiplayer branch continuation"
summary: "All authority and real-harness findings are closed; two existing composer unit contracts remain before merge."
keywords: ["multitenant", "multiplayer", "session-authority", "central-routing", "subagent-lifecycle", "composer"]
cwd: "/Users/yashvardhansingh/test/opencode/.worktrees/codex/single-tenant-multiplayer-ready"
resume_focus: "Resolve the two composer unit contract failures, rerun the app unit command, and prepare merge/deploy evidence without reopening closed authority findings."
repository: "Claxedo"
repo_root_sha: "728cedf2a29e2f9da901c8c36620ce5efc09e6b2"
branch: "codex/single-tenant-multiplayer-ready"
head: "9bf5849c418597ba10f222e3ce990dd39c508445"
worktree_path: "/Users/yashvardhansingh/test/opencode/.worktrees/codex/single-tenant-multiplayer-ready"
---

# Continuation handoff

## User intent

The user asked for every review/architecture document to be current, for the
branch changes to be pushed, and for a fresh agent to be able to continue from
the report without this conversation history.

The user explicitly challenged a prior tendency to chase only newly written
E2E assertions. Continue from the canonical producer and real runtime/UI flow;
do not weaken a test or add synthesized fallback data to make a lane green.

## Start here

Read these in order:

1. `.branch_status/README.md` — current verdict, commits, and readiness.
2. `.branch_status/architecture.md` — full tenant, actor, runtime, event, and
   client-continuity flow plus implementation source map.
3. `docs/tech-docs/access-model.md` — canonical product/security policy and the
   managed-versus-local boundary.
4. `.branch_status/review-findings.md` — the 18 closed review findings and
   post-review acceptance findings A1-A5.
5. `.branch_status/verification-and-rollout.md` — exact executed matrix,
   remaining unit failures, rollout, rollback, and environment gates.
6. `.branch_status/product-requirements.md`, `user-journeys.md`, and
   `decisions.md` — acceptance criteria and settled decisions.
7. `.branch_status/status.json` and `change-inventory.md` — machine-readable
   status and reproducible diff scope.

## Completed work

### Tenant-aware multiplayer authority

All 18 validated P1/P2 findings are closed. The authority closure runs through
`2adbe6ca4c`. Do not reopen roles/permissions without new contrary evidence.

The settled access equation is:

```text
private session access
  = sufficient current workspace authority
  AND (creator OR active participant OR organization admin)
```

It applies to storage, HTTP, prompt/command, PTY/process aliases, live events,
replay, reconnect, and compatibility streams. Files and the working tree remain
workspace-authorized; per-session filesystem privacy is an explicit non-goal.

### Post-review runtime-to-UI continuity

`430fa0bc1d` fixes the real product flow rather than only its E2E:

- `packages/claxedo-server/src/session/runtime.ts` stamps authoritative central
  workspace/host/session-ref identity on compatible lifecycle events.
- `packages/claxedo-app/src/app/workbench/state/route-intent.ts` and
  `route-bridge.tsx` keep central sessions out of workspace-route inference and
  open them through the central transport.
- inventory, directory cache, session resource authority, controller, and pane
  queries preserve transport provenance and never satisfy a central/signed read
  from stale local cache state.
- `toolbar-state.ts` keeps an existing session inert while its saved model is
  restoring.
- `opencode-conversation.ts` and timeline grouping preserve intermediate task
  parts and canonical snapshot/live ordering.
- `packages/workspace-runtime/src/routes/events.ts` retains terminal subagent
  lifecycle for authorized replay.
- `packages/session-ui/src/components/message-part.tsx` renders canonical child
  lifecycle even when the parent task tool reports an error.

`9bf5849c41` contains separate deterministic E2E mechanics: exact pointer-enter
and selection behavior, a WorkGraph harness refresh where central SSE is
intentionally absent, and unambiguous accessibility selectors.

## Verification performed

Passing current follow-up commands:

- focused app Bun units: 177 passed;
- focused app Vitest components: 25 passed;
- central runtime: 30 passed;
- ACP adapter: 42 passed;
- workspace event route: 6 passed;
- session UI: 14 passed;
- app, server, agent SDK runtime, workspace runtime, and session UI typechecks:
  all passed;
- complete real-harness browser lane: 14 passed, 1 recording-only skip;
- former Pi and Codex ACP blockers together: 2 passed;
- the one core matrix WorkGraph strict-locator failure, rerun in both auth
  modes after the selector fix: 1 passed in `test-user` and 1 passed in
  `local-unsigned`;
- `git diff --check`: passed.

The full two-mode core browser matrix completed before `9bf5849c41` with one
failure only: `openWaitingItemPanel` used `/Needs you/` and matched three
accessible buttons. No product assertion failed. The exact failed journey
passed in both modes after the helper selected
`/^Needs you — \d+ waiting on you$/`.

## Remaining local merge gate

`packages/claxedo-app: bun run test` currently reports 5,695 passed and 2
failed:

1. `src/features/session/composer/ui/submit.harness-dispatch.test.ts`
   — “existing harness follow-up preserves its persisted harness variant”.
   Expected the persisted `claude-acp/opus` model with variant `high`; the
   submitted transport payload used the generic `provider/model` selection.
2. `src/features/session/composer/ui/submit.session-config.test.ts`
   — “second submit with unchanged config does NOT re-PATCH”.
   Expected one config PATCH after two identical submits; observed two.

Neither failing test file changed in `430fa0bc1d` or `9bf5849c41`. Treat the
failures as real contracts, not as permission failures and not as permission to
change expectations. Inspect the existing submit/config owner and restore the
canonical persisted model/variant and dedupe key at their producer.

After fixing them, run:

```text
cd packages/claxedo-app
bun test --conditions=browser --preload ./happydom.ts \
  src/features/session/composer/ui/submit.harness-dispatch.test.ts \
  src/features/session/composer/ui/submit.session-config.test.ts
bun run test
bun run typecheck
```

Then rerun the relevant existing-session real-harness journey if the submitted
model/config path changed.

## Remaining deployment gates

These require environment or operator authority not available in this session:

- credentialed staging tenant-migration rehearsal and legacy-session smoke;
- live-provider E2E with real credentials;
- packaged desktop E2E with a built Electron artifact;
- public-web E2E if/when that package exposes a discoverable lane.

Follow `docs/tech-docs/tenant-identity-schema-rollout.md` exactly. Ambiguous
tenant/project provenance is a hard stop; do not guess or synthesize it.

## Constraints and wrong paths

- Fix authoritative producers; do not repair missing identity, model, events,
  or authors with downstream fallback.
- Request bodies cannot assert actor identity.
- Historical unknown authors stay unknown; never substitute the current reader
  or sync caller.
- Workspace admin from a narrow share is not organization-admin authority.
- Keep OpenCode request/response/event compatibility.
- Keep managed signed and caller-owned unsigned local policies distinct.
- Do not collapse central, workspace-runtime, and local session cache authority.
- Do not mark merge-ready while `packages/claxedo-app: bun run test` is red
  unless the user explicitly waives the two contracts.
- Do not commit generated Playwright videos, test-results, or the onboarding
  evidence PNG rewritten by a browser run.

## Expected repository state

The implementation commits are `430fa0bc1d` and `9bf5849c41` on
`codex/single-tenant-multiplayer-ready`. The review dossier should be committed
after them and pushed to `origin/codex/single-tenant-multiplayer-ready`. A fresh
agent should verify `git status --short` and the remote head before acting.
