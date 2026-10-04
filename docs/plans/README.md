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
- [Work system: high-level design](./2026-10-01-work-system-hld.md)
  — proposed. The complete system of presets, optional bot identity, tasks, sessions, memory, tools,
  script checks, triggers and local/cloud execution; current code, reuse points, required refactors and delivery slices.
- [Task foundation: durable wakes and session memory](./2026-09-29-001-feat-tasks-plugin-on-pi-plan.md)
  — proposed first slice. Extend existing Tasks with shared task memory and one pending one-time wake;
  retain the current session/harness system. The full work-system HLD adds script-first checks and later ongoing work.
- [Hosted agent core](./2026-10-01-001-feat-hosted-agent-core-plan.md)
  — deferred runtime option. Worker-hosted Pi, retained files and sandbox delegation consume the same
  work-system contracts; they are not prerequisites for the Task foundation.
- [Session seen state](./2026-10-02-001-feat-session-seen-state-plan.md)
  — planned, not started; the server contract changes await owner sign-off. The rail's finished and failed
  dots become a per-reader server fact (`lastTurn` + `seenAt` on list items, a `session.seen` notice), and
  every readable session's status and attention reach the app as a per-reader `cp/events` notice, never missed.
- [Activity sidebar, seen state and settle: rebuild](./2026-10-03-1500-feat-activity-sidebar-rebuild-plan.md)
  — in progress, lanes B and E first. Extends the session seen state plan with the Activity view, per-reader
  Settle and agent session delete, under the owner's binding rulings; lane B (`lastTurn` on list items) is implemented.
- [Pi on pi-durable, harness sharing and per-session capabilities](./2026-10-03-1700-feat-pi-durable-harness-plan.md)
  — in progress on `feat/pi-harness`. Pi runs embedded per session locally and in one SessionDO per cloud session
  (Cloudflare `PiHarness`), with tools on the workspace machine over any sandbox driver; Codex and Cursor share
  processes safely; OpenCode gets per-session MCP and skills.
- [Reducing server, runtime and machine code](./2026-09-29-002-refactor-loc-reduction-plan.md)
  — planned, not started. 254.8k → ~114k in the server, runtime, machine agent, desktop main process and relay
  (app, UI kit and harness out of scope). Keeps Pages, Teams, the browser pane and channels; adds plugin backends,
  status-hook templates, D1 plus R2 transcripts, a runtime-neutral session core, and the access model (org members,
  per-team and per-member project access, private pages with shares; Phase 1A).
- [Sandbox provider setup, prebuilds and machine sizes](./2026-10-04-feat-sandbox-prebuilds-plan.md)
  — slice 1 (start and prebuild telemetry) implemented on `feat/sandbox-start-telemetry`; slices 2–5 planned.
  Org provider keys on the shared credentials route, `.claxedo/setup.sh`/`start.sh`, one prebuild per key with
  push and daily builds, and per-driver machine classes.
- [Consolidation before launch](./2026-09-30-001-refactor-consolidation-before-launch-plan.md)
  — in progress on `goal/foundation`. Lanes C1–C10 settle machine access, one stored schema per store,
  relay fences, session reads and idempotency, hosted operation declarations, error codes, shared machine
  contracts, one event path, one file index and one session identity before launch.
