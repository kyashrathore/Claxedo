# Tasks and Presets — evidence index (local slice, 2026-09-12)

Source: branch `feat/tasks-presets` in worktree `~/test/opencode-tasks`, cut from dev `85f1d007c8`; evidence recorded at `a44662d5ef` plus the two orchestrator fixes `28cd279a9d` and `b8e08cbc0c`. Tasks selection: `CLAXEDO_BUILD_TASKS` selects the feature at build time; unset and any value other than `0` keep it on, so the live rows above were taken from an enabled build.

Environment for the live rows: unsigned local stack started from the worktree. Server `npm run start` in `packages/claxedo-server` with `CLAXEDO_DATA_DIR`/`CLAXEDO_STATE_DIR` under the session scratchpad and `CLAXEDO_SERVER_PORT=2594`; app `bun run dev:local` in `packages/claxedo-app` with `PORT=4448 VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:2594`. Project registered with `POST /api/claxedo/projects` (`{ name, source: { kind: "directory", directory } }`) pointing at a scratch git repository. Scope `local`, owner `local`. Screenshots were inspected in the Claude Browser pane; pointer/keyboard input was screenshot-driven with element refs from the accessibility tree.

| Journey | Automated | Visual / live | Result | Notes |
|---|---|---|---|---|
| T01 | app architecture guard; desktop renderer-config guard; self-hosted selection tests; local-server feature-off resume test; `verify:closure` emitted manifests both ways | none | PASS (four artifacts measured; packaged desktop and deployed hosted NOT RUN) | See "Build-time feature selection" below. |
| T02 | package model/service/http tests; SQLite + D1 conformance | live create, reload, server restart | PASS (local) | Task `tsk_234d73b3…` survived app reload and a server restart at revision 3. |
| T03 | conformance `stale revision` cases; app store 409 test | none | PASS (automated only) | Two-client live case not run. |
| T04 | service reparent/child rules | live add subtask via Add button | PASS (local) | Enter in the subtask field did not submit in the pane; the Add button did. Unverified whether that is real. |
| T05 | board/list vitest | live list, board, filters visible | PARTIAL | One task + one child only; paging not exercised. Board scrolls (`overflow-x: auto`, 904 > 738 px), no clipping. |
| T06 | service guard tests; board vitest incl. snap-back | live Done refused | PASS (local) | Alert "has 1 unfinished children"; server status stayed `doing`; menu shows the record after `b8e08cbc0c`. |
| T07 | service/store archive tests | none | PASS (automated only) | |
| T08 | local bridge test against a real embedded runtime; hosted bridge with captured fetch | live Start | PASS (local, model turn GATING) | Session `ses_tasks_592388684598e5b5ce40018ac327fa5d` created in the project workspace with harness `claude`, model `claude/opus[1m]`, retained `instructions` = preset block + configuration description (read from `agent-core/<ws>/state.db`), one user message `msg_tasks_<hash>` carrying title + description. The assistant turn failed `authentication_failed` because the isolated data dir holds no Claude credential: the real tool result is GATING, not observed. |
| T09 | service attempt-rule tests; bridge replay tests | live Open on an occupied slot | PASS (local) | Open navigated to the same session; only GETs on the task routes, no second create. Two-client conflicting case not run live. |
| T10 | bridge fault tests | none | PARTIAL | Interruption faults only in unit tests. |
| T11 | bridge no-resend test | none | PARTIAL | Live delete-then-Start-again not run. |
| T12 | persistence tests | live reload + restart, Open later | PASS (local) | Link row `primary / attempt 1 / Careful reviewer / live` read back from `claxedo_task_session_link`. Start-again after archive not run live. |
| T13 | vitest | screenshots at 1024×768 only | PARTIAL | No dark/light or narrow pass. |
| T14 | http negative tests; hosted composition 403/404 test | none | PASS (automated only) | |
| T15 | Miniflare D1 conformance + migration ordering test | none | PASS (automated only) | No deployed Worker. |
| T16 | none | none | NOT RUN | Packaged desktop and deployed hosted not exercised. |
| T17 | preset model/service/http tests; preset editor vitest | live create | PASS (local) | Preset `tpr_f8e66290…` persisted with harness/model/instructions; archive/restore not run live. |
| T18 | preview tests; editor revalidation vitest | live preview | PASS (local) | Preview resolved the project's workspace after `a44662d5ef`; before it the preview was blocked "No reachable workspace" for a task with no explicit workspace. |
| T19 | none live | none | NOT RUN | Two local presets with different instructions not run. |
| T20–T22 | cloud refused with a reason | none | NOT RUN | Cloud placement and selected-only projection (S5/S6) are not implemented. |
| T23 | none | none | NOT RUN | Delegation with effort (S7) not implemented; `effort_unsupported` is never produced at preview. |
| T24 | archive/authority tests; `packages/claxedo-local-server/src/tasks/feature-off-resume.test.ts` | none | PARTIAL | Feature-off resume now proven at the route/runtime level: a session the enabled bridge created answers `GET /session/<id>/config` with its retained instructions, model and harness while the app is composed with no Tasks contribution and `/api/claxedo/tasks/*` answers 404. Not run on a packaged desktop or a deployed hosted Worker. |

## Build-time feature selection (T01)

`CLAXEDO_BUILD_TASKS=0` is the only value that turns Tasks off; unset keeps it on, so a build that never sets the variable ships the feature rather than silently dropping it. Asserted for every renderer config in `packages/claxedo-app/src/architecture/tasks-build-selection.guard.test.ts` and `packages/claxedo-desktop/src/renderer/renderer-entry-closure.guard.test.ts`, which run the real configs under unset/`1`/`0`.

Measured, with the enabled build as the positive control in each case:

| Artifact | Command | Enabled | Disabled |
|---|---|---|---|
| `@claxedo/app` local renderer | `bun run verify:closure` in `packages/claxedo-app` | 2950 emitted modules, 533 chunks, `assets/tasks-contributions-*.js` present | 2916 modules, 528 chunks, no Tasks chunk and no `packages/claxedo-tasks` module |
| `@claxedo/server` self-hosted bundle | `bun run build:self-hosted-boundary` | 4445 modules, 19 `@claxedo/tasks` + 7 `tasks-host` modules, `claxedo_task_session_link` DDL present, 41 staged migrations | 4415 modules, 0 Tasks modules, DDL absent, 40 staged migrations |
| desktop `claxedo-server` bundle | `bundleClaxedoServer(scripts/claxedo-server-boot.ts, …)` | 52 chunks, `claxedo-tasks` / `TASKS_ROUTE_PATH` / `claxedo_task_preset` / `claxedo_task_session_link` each in one chunk, 41 staged migrations | 49 chunks, none of those strings in any emitted file, 40 staged migrations |
| `@claxedo/local-server` dist | `bun run scripts/build.ts` in `packages/claxedo-local-server` | 41 staged migrations incl. `20260912100000_claxedo_tasks` | 40, that migration excluded |

The `app-local` and `server-self-hosted` policies in `script/product-boundary/policies/` carry the emitted rules and were cross-checked in both directions: the disabled manifest read against the enabled policy reports the missing required Tasks modules, and the enabled manifest read against the disabled policy reports the forbidden ones.

What is NOT proven:

- The desktop RENDERER has no artifact-level Tasks rule. `desktopRendererBoundaryManifestPlugin` records the base entry's STATIC closure, so a measured enabled build carries no Tasks module and no Tasks chunk either; a forbidden rule there would pass on both artifacts. The renderer source is `@claxedo/app`'s, so the cut is covered by `app-local`'s emitted manifest and the app guard. A desktop-specific emitted proof needs that plugin to record the renderer's dynamic closure.
- The hosted Worker variant selection is UNCHANGED: no certified artifact was added or altered, and `certified-worker-artifacts.ts` is untouched. Hosted Tasks remains the hosted composition's own concern.
- No packaged desktop and no deployed hosted Worker were built or exercised (T16 stays NOT RUN).

## Defects found only by the live run

- Picking a harness in the preset editor overflowed Solid's reactive graph: the slot editor called the host editor as a function inside JSX and the draft callback read the parent's signal inside a child effect. Fixed in `28cd279a9d` with `Dynamic` + `untrack`; regression test in `preset-editor.vitest.tsx` (both mutants fail).
- The bridge resolved a workspace only from the task's explicit preference, never from the project. Fixed in `a44662d5ef` (`projectTarget`, deterministic root/primary-checkout choice, refusal naming candidates when ambiguous).
- A refused status change left the native select showing the refused value. Fixed in `b8e08cbc0c`.

## Reds inherited from dev `85f1d007c8` (proven at the base commit)

claxedo-server: `deployment-closures` (Better Auth locked closure 16 > 15), `governance/codebase-shape` (`documents/routes/index.ts` missing), `session-env-document-roundtrip.integration` (Pi executable), `local-product-contract` allowlist (extra `/api/claxedo/agent-config/providers/custom` from `2e1d6ee407`). workspace-runtime: `generateNotifyScript > reports failed delivery…`. local-server: `control-plane Pi catalog > serves credential-owner authentication methods…`. Root lint: three errors in `claxedo-app/perf-harness/**` on this checkout.

## Escalations outside this feature

- Hosted session access ranks a caller by workspace owner, workspace and project memberships and org role (`actorWorkspaceRoleRankSql` in `packages/claxedo-server-core/src/authority/adapters/sqlite/session-authority.ts`), while project access also counts team grants (`projectAccess` in `workspace-authority.ts`). A member whose project access comes only through a team grant passes `authorizeProject`, can create and edit tasks, and is refused at session reservation. Every hosted session create has the same gap; Tasks is the first feature that makes it visible. Owner: session authority. Not changed on this branch.
- Preview cannot refuse an unsupported effort level: no host-side reader exists for a harness's effort levels that is independent of that harness's current model, so effort travels as `variant` and the runtime refuses at create.
