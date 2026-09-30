# Claxedo Plans

A plan stays here only while its work is queued or in progress. When the work
ships, the plan is deleted and anything still true moves to the architecture
doc or package README that owns it.

- [Remote machine connection](./2026-09-14-003-feat-connect-implementation-plan.md)
  — P1–P3 shipped; P4–P6 (host folder operations, machine worktrees, the
  remote access panel) are not started. Onboarding v2 records P4 as its gap.
- [Onboarding v2: project → AI → where it runs](./2026-09-15-001-feat-onboarding-v2-project-ai-execution.md)
  — built on `feat/onboarding-v2`, awaiting merge to `dev`.
- [App rebuild: the first proof](./2026-09-24-001-refactor-app-rebuild-first-proof-plan.md)
  — planned, not started. It rebuilds the app and UI kits to ≤ 93k lines on v2 only, against
  today's server contracts, with e2e tests only. The transcript is moved, not rebuilt. The plan
  keeps phone layouts, gives every project an id, and has four first-party plugins and a
  benchmark gate against today's app.
- [Steering admission and transcript reconciliation](./2026-09-20-harness-steering-admission.md)
  — queue execution and admission safety implemented; provider incorporation,
  transcript placement and the acceptance matrix remain.
- [Tasks as a hosted plugin, with work runs on Pi](./2026-09-29-001-feat-tasks-plugin-on-pi-plan.md)
- [Consolidation before launch](./2026-09-30-001-refactor-consolidation-before-launch-plan.md)
  — planned, not started. Tasks becomes a hosted-only plugin with a Dynamic Worker backend;
  a task's own agent is Pi's `AgentHarness` in its Durable Object; the native Tasks feature
  (~16.5k production lines) is removed at the end.
