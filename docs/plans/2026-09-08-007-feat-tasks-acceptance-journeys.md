---
title: "Tasks and Presets — Acceptance Journeys and Live Verification"
type: verification
status: not-executed
created: 2026-09-08
updated: 2026-09-12
scope: presets-tasks-subtasks-and-linked-sessions
---

# Tasks and Presets — Acceptance Journeys and Live Verification

## 1. Scope and status

This document replaces the former J01–J42 catalog. Those planning/activity/run/full-profile journeys are retired, not completed. The new lightweight preset requirement has its own journeys; it does not revive named-bot behavior. T01–T24 below validate presets, tasks/subtasks, local/cloud start, session links and capability isolation from the [HLD](2026-09-08-004-feat-tasks-high-level-design.md), [LLD](2026-09-08-005-feat-tasks-low-level-design.md) and [implementation plan](2026-09-08-006-feat-tasks-implementation-plan.md). All are **NOT RUN**.

The context/memory product needs its own separate design and evidence. No learning or autonomous-work claim follows from passing this checklist.

## 2. Automated and live proof

Follow [E2E invariants](../../packages/claxedo-app/e2e/INVARIANTS.md), [test conventions](../../packages/claxedo-app/CONTRIBUTING.md) and [Playwright configuration](../../packages/claxedo-app/playwright.config.ts).

- Domain/host tests exercise real rules and public APIs. Storage claims require actual SQLite and Miniflare D1, including separate concurrent connections/requests.
- Tier M uses existing mock-runtime infrastructure to exercise actual Solid UI states. It cannot prove session creation or durable persistence.
- Tier R uses actual app/host/storage/runtime/harness, with only the allowed scripted model/provider setup. Do not intercept app APIs with `page.route()` or synthesize runtime outcomes.
- Tier L exercises real model/tool behavior with actual credentials. Missing dependencies are GATING, not skipped or substituted.
- Artifact checks inspect emitted resources and selected deployments, not only source strings.

Reuse [turn-oracle.ts](../../packages/claxedo-app/e2e/helpers/turn-oracle.ts), [geometry-oracle.ts](../../packages/claxedo-app/e2e/helpers/geometry-oracle.ts) and [visual-evidence.ts](../../packages/claxedo-app/e2e/helpers/visual-evidence.ts). A visible assistant result and useful test-file change prove session handoff; a 200 or hidden matching text does not.

**Live computer use is separate.** Open the actual product, inspect screenshots, operate controls with screenshot-based pointer/keyboard input, and inspect resulting screens. Locator-driven browser tests or JavaScript clicking are not this proof. Read-only storage/runtime checks can corroborate identity and persistence after the visible interaction. Document external fault setup separately. Record automated pass, visual review and computer-use verification as distinct fields.

## 3. Journeys

| ID | User journey and failure branch | Required result | Automated owner / live coverage |
|---|---|---|---|
| T01 | Build/open Tasks+Presets-on and feature-off products; reuse on staging for off build | Off has no catalog UI/code/CSS/routes/migrations; previously preset-started ordinary sessions still work | Artifact/closure tests, availability E2E; live off launch |
| T02 | Create title/description/project task; invalid input, repeated Save, reload/restart | Durable one task, preserved draft on error, no session creation | Domain/store/HTTP + core/real catalog; live create/reload |
| T03 | Edit from two clients with stale revisions | Conflict preserves input; no silent overwrite | Both-store concurrency + catalog E2E; live two clients |
| T04 | Add and open subtasks; try grandchild/cycle/cross-project relation | One-level same-project rules, correct parent/child links | Domain/HTTP + catalog E2E; live child navigation |
| T05 | Switch list/board, filters, pages and child display in a populated catalog | Authorized matching counts/pages, stable ordering, retained preferences/Back position | Query/UI tests + catalog E2E; live populated board |
| T06 | Change status by menu/drag; complete parent with unfinished children; race child reopen | Manual statuses; parent guard prevents invalid completion; no session-state coupling | Domain/store race tests + catalog E2E; live keyboard/drag/reopen |
| T07 | Archive/restore task and children with a session link | Correct visibility/parent guards, link retained, session not stopped or archived | Store/HTTP + catalog E2E; live archive/restore |
| T08 | Start task and subtask with a saved preset and selected configuration; Start with no presets saved | Correct placement/model/effort/instructions, harness-default agent, canonical session/link, initial task text and visible real tool result; task status unchanged; with no presets the dialog creates one inline and keeps the task/start draft, no hidden default | Bridge/public session tests + real/live session-link E2E; live web/desktop/hosted |
| T09 | Double-click/retry Start and use two clients on the same slot, with matching and conflicting presets; Start again while the slot's session is live | Matching requests recover one workspace/session/link and one initial message; conflicting configuration is rejected; a new attempt on a live session is refused and the live session opened | Real create-owner/bridge race tests + E2E; live two-client result |
| T10 | Interrupt allocation/create before link save; lose successful response; change task target/access before attach | Recover same origin-bound workspace/session and link; reject mismatched attachment; never blindly allocate/create another | Real host/producer fault tests + session-link E2E; live recovery with documented fault setup |
| T11 | Fail/interrupt initial message submission after link; target offline/deleted | Link survives; Open session uses ordinary controls; no automatic second message/session; a deleted session makes Start again available without starting anything itself | Bridge + real/live session-link E2E; live error and recovery |
| T12 | Close/reload/restart app, return to each linked slot, Open later; archive or delete a linked session, then Start again with and without Continue from previous session | Same SessionRef/history/resolved settings; no mutable preset reload or new create/send; unavailable link explained and offers Start again; the new attempt gets its own session and origin, the earlier link stays as history; Continue renders the prior session's turns and tool output through the existing handoff transaction only when chosen and readable, a deleted transcript starts from task text | Real persistence/navigation E2E; live app restart |
| T13 | Light/dark, narrow/split pane, keyboard dialog/status/Back; scope switch with pending responses | No clipping or hidden session button; proper focus; no old-scope cache leakage | Mounted Solid + geometry/catalog E2E; live visual/keyboard checks |
| T14 | Foreign task/project/session/preset IDs, revoked access and unsupported placement/capability | Check personal preset and project/session authority separately; no private preset disclosure via task links, unauthorized create or silent substitution | HTTP/bridge/host negative tests; signed E2E and live denied deep link |
| T15 | Hosted catalog with workspace stopped; SQLite/D1 migration and restart; incompatible backend | Catalog usable without provisioning, retained records/links, explicit availability error | Real stores/Worker integration + deployed E2E; live stopped-workspace catalog |
| T16 | Packaged desktop and deployed hosted create preset→task→subtask→Start→reload→Open; disable/re-enable feature | Actual host/auth/relay path works, catalogs/links survive, existing configured sessions independent of flag, no automatic work on re-enable | Desktop/deployed suites and artifacts; live packaged and deployed flows |
| T17 | Create/edit/archive/restore local/cloud presets; optional slots/instructions; stale edits, foreign owner, reload | Durable personal settings, preserved drafts, bounds/ownership enforced; save starts/installs/connects nothing; archived preset unavailable for new starts | Domain/store/HTTP + preset E2E; live full editor lifecycle |
| T18 | Start preview then change harness/model/effort/placement, task source/ref or preset revision; missing connection/model | Dependent validation and refreshed preview; no fallback or side effects before Start; supported settings/instructions visible and reflected in real session | Resolver/host/UI + real start E2E; live preview/error/restart |
| T19 | Start two local tasks with different instructions/model presets; cloud preset selected on unavailable host | Session-specific settings honored, local skill/plugin config unchanged, inherited behavior labeled; cloud does not fall back to local | Real local host/driver and file-config comparison; live two sessions |
| T20 | Start two cloud task/slot roots in the same project with disjoint capabilities; repeat after suspend/restart | Distinct workspace/home/config/secret scope; same-root retries restore same environment; neither root changes the other; no dirty-local-code transfer implied | Real sandbox/provisioning + deployed E2E; live concurrent roots and reopen |
| T21 | Select no plugins/skills, overlapping direct/bundled skills, name collisions, same activation revision/different selections and existing global defaults | Actual skill/tool inventory matches selected closure plus declared platform tools; deduplication; no accidental plugin enablement or wrong cached projection; unsupported collision rejected | All affected adapter/apply tests plus real inventory/tool checks; live selected/empty previews and sessions |
| T22 | Excluded plugin call, revoked integration/skill/plugin access and resumed stopped environment | Real gateway denies unauthorized access; no unselected credentials; retained pins or explicit unavailable result, never expanded project defaults; measured revocation behavior | Gateway/token/preparation negative tests + deployed live calls/resume |
| T23 | Choose Planning/Implementation/Review explicitly; use a supported group through native delegation; unsupported effort/harness | Correct root/child model+effort readback, explicit context/handoff, no implicit transcript/stage transition; child cannot expand capabilities/permission; replay does not duplicate child prompt | MCP/runtime/child contract + real/live group E2E; live distinct models and handoff |
| T24 | Edit/archive preset after start; concurrent preset choices; shared-task reader without preset access; feature-off resume | Existing settings/instructions/pins retained independently; private preset not disclosed; live slots not replaced; ordinary configured sessions and authorized recovery work without feature | Cross-store/session/authority and off-artifact E2E; live edit→resume→off |

The term "Start" resolves a preset/configuration and creates an ordinary session with its initial request; all later execution control belongs to the existing session UI. Planning is a configuration slot, not an accepted-plan record. Model-group delegation is tested only through its real runtime capability, not inferred from a prompt. These journeys do not add Tasks run monitoring, cancellation, plan tools or activity recording.

## 4. Required matrix and test wiring

- **Local unsigned web:** all applicable journeys, actual SQLite/runtime, host restart and correct local target.
- **Signed Node:** task/project/session authority, create/link/open, denied access and two-client cases.
- **Packaged desktop:** T08, T11–T14, T16–T19 and T24 through actual file-origin renderer and embedded runtime; not a dev web preview.
- **Worker + Miniflare D1:** all storage/API guard/migration cases; stopped-workspace catalog reads. Mocked storage is insufficient.
- **Deployed hosted:** T08, T10–T12, T14–T18 and T20–T24 through actual signed app, D1, provisioning and relay. Miniflare does not replace this proof.
- **Harnesses:** qualify create/first-message/open through each supported session-creation integration affected by the bridge. Reuse the current harness matrix; do not create a Tasks outcome test suite for every runtime behavior. At least one real model/tool handoff is required on local and hosted paths. Every advertised selected-only harness needs real isolation/inventory evidence; every advertised agent-directed group path needs actual model/effort and inherited capability evidence. Distinct bridge branches need their own evidence. An unsupported adapter is a visible capability limitation, not a silent test skip.
- **Feature exclusion:** renderer, local/Node server, desktop resources and selected Worker artifact; on positive control, clean off, staging on→off and data off→on.

Proposed browser files: `core-presets.spec.ts`, `real-presets.spec.ts`, `real-preset-cloud-isolation.spec.ts`, `live-preset-model-group.spec.ts`, `core-tasks-catalog.spec.ts`, `real-tasks-catalog.spec.ts`, `core-tasks-session-link.spec.ts`, `real-tasks-session-link.spec.ts`, `live-tasks-session-link.spec.ts`, plus Tasks cases in existing packaged-desktop and deployed acceptance owners. Update suite discovery, fixed spec lists and explicit Tasks-on lanes together. Off builds require independent coverage. Build manifests and consumers must agree on feature/auth/build identity.

Core UI cases use the existing signed test-user and local-unsigned modes. Keep test fixtures isolated from user projects/data. Prepare more than one page of tasks, mixed child statuses, personal presets with distinct instructions, an archived and a deleted linked session, disjoint/empty plugin and skill sets, multiple configured models, and distinct authorized/unauthorized projects. Include a same-project pair of cloud roots and installed global defaults to challenge isolation. Use controllable host-boundary faults for precise interruption tests, never browser-faked session evidence.

## 5. Evidence and completion

During implementation create `docs/verification/tasks/<build-id>/index.md`. Record per journey/environment: source/build identity, Tasks selection, app URL/package path, auth/scope/project/workspace, preset ID/revision, slot, attempt, placement, resolved configuration/selection hash and effective harness/model/effort when used, fixture/fault setup, exact command and result, screenshot/video links, inspected visible behavior, computer-use action sequence, redacted task/session identity proof, PASS/FAIL/GATING/NOT RUN and any owner/follow-up.

Keep `visual_verified` and `computer_use_verified` separate from automated pass. Read screenshots rather than merely saving them. Missing live input tooling, credentials or deployed access leaves the exact criterion GATING. No test has passed solely because this document lists it.

Completion requires all applicable T01–T24 variants, final artifact exclusion and the real create/link/reopen journeys. The retired larger catalog is not an additional requirement. No product/runtime tests were executed during this documentation update.
