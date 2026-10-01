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
- [Tasks: a hosted plugin whose runs are Pi sessions](./2026-09-29-001-feat-tasks-plugin-on-pi-plan.md)
  — planned, not started. Principles, PRD and HLD: a request plus what happened since (no stored status or type), plan
  acceptance before anything repeats, receipts for irreversible actions, one resumed session per task on Pi's
  `AgentHarness` in the task's Durable Object, machine runs on real harnesses; native Tasks (16.3k lines) removed at the end.
- [Reducing server, runtime and machine code](./2026-09-29-002-refactor-loc-reduction-plan.md)
  — planned, not started. 254.8k → ~114k in the server, runtime, machine agent, desktop main process and relay
  (app, UI kit and harness out of scope). Keeps Pages, Teams, the browser pane and channels; adds plugin backends,
  status-hook templates, D1 plus R2 transcripts, a runtime-neutral session core, and the access model (org members,
  per-team and per-member project access, private pages with shares; Phase 1A).
- [Consolidation before launch](./2026-09-30-001-refactor-consolidation-before-launch-plan.md)
  — in progress on `goal/foundation`. Lanes C1–C10 settle machine access, one stored schema per store,
  relay fences, session reads and idempotency, hosted operation declarations, error codes, shared machine
  contracts, one event path, one file index and one session identity before launch.
