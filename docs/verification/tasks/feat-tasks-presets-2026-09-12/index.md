# Tasks and Presets — evidence index (local slice, 2026-09-12)

Source: branch `feat/tasks-presets` in worktree `~/test/opencode-tasks`, cut from dev `85f1d007c8`; evidence recorded at `e314940f35` plus the two orchestrator fixes `e40f2444f2` and `571c0a6a18`. Tasks selection: `CLAXEDO_BUILD_TASKS` selects the feature at build time; unset and any value other than `0` keep it on, so the live rows above were taken from an enabled build.

Environment for the live rows: unsigned local stack started from the worktree. Server `npm run start` in `packages/claxedo-server` with `CLAXEDO_DATA_DIR`/`CLAXEDO_STATE_DIR` under the session scratchpad and `CLAXEDO_SERVER_PORT=2594`; app `bun run dev:local` in `packages/claxedo-app` with `PORT=4448 VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:2594`. Project registered with `POST /api/claxedo/projects` (`{ name, source: { kind: "directory", directory } }`) pointing at a scratch git repository. Scope `local`, owner `local`. Screenshots were inspected in the Claude Browser pane; pointer/keyboard input was screenshot-driven with element refs from the accessibility tree.

| Journey | Automated | Visual / live | Result | Notes |
|---|---|---|---|---|
| T01 | app architecture guard; desktop renderer-config guard; self-hosted selection tests; local-server feature-off resume test; hosted Worker selection cases in `core-resource-closure.test.ts`; `verify:closure` emitted manifests both ways | none | PASS (six artifacts measured, hosted Worker included; packaged desktop and a DEPLOYED hosted Worker NOT RUN) | See "Build-time feature selection" below. |
| T02 | package model/service/http tests; SQLite + D1 conformance | live create, reload, server restart | PASS (local) | Task `tsk_234d73b3…` survived app reload and a server restart at revision 3. |
| T03 | conformance `stale revision` cases; app store 409 test | none | PASS (automated only) | Two-client live case not run. |
| T04 | service reparent/child rules | live add subtask via Add button | PASS (local) | Enter in the subtask field did not submit in the Claude Browser pane; a vanilla control form failed identically under the pane's key injection while Playwright submitted both, so this is a harness artifact, not a defect. |
| T05 | board/list vitest | live list, board, filters visible | PARTIAL | One task + one child only; paging not exercised. Board scrolls (`overflow-x: auto`, 904 > 738 px), no clipping. |
| T06 | service guard tests; board vitest incl. snap-back | live Done refused | PASS (local) | Alert "has 1 unfinished children"; server status stayed `doing`; menu shows the record after `571c0a6a18`. |
| T07 | service/store archive tests | none | PASS (automated only) | |
| T08 | local bridge test against a real embedded runtime; hosted bridge with captured fetch | live Start | PASS (local, model turn GATING) | Session `ses_tasks_592388684598e5b5ce40018ac327fa5d` created in the project workspace with harness `claude`, model `claude/opus[1m]`, retained `instructions` = preset block + configuration description (read from `agent-core/<ws>/state.db`), one user message `msg_tasks_<hash>` carrying title + description. The assistant turn failed `authentication_failed` because the isolated data dir holds no Claude credential: the real tool result is GATING, not observed. |
| T09 | service attempt-rule tests; bridge replay tests | live Open on an occupied slot | PASS (local) | Open navigated to the same session; only GETs on the task routes, no second create. Two-client conflicting case not run live. |
| T10 | bridge fault tests | none | PARTIAL | Interruption faults only in unit tests. |
| T11 | bridge no-resend test | none | PARTIAL | Live delete-then-Start-again not run. |
| T12 | persistence tests | live reload + restart, Open later | PASS (local) | Link row `primary / attempt 1 / Careful reviewer / live` read back from `claxedo_task_session_link`. Start-again after archive not run live. |
| T13 | vitest | screenshots at 1024×768 only | PARTIAL | No dark/light or narrow pass. |
| T14 | http negative tests; hosted composition 403/404 test | none | PASS (automated only) | |
| T15 | Miniflare D1 conformance + migration ordering test; staged control-plane migration selection in `core-resource-closure.test.ts` | none | PASS (automated only) | The hosted Worker's `migrations_dir` now names a staged directory: measured, the on staging is the full source list and the off staging is that list without `0024_claxedo_tasks.sql`, with the source directory unchanged (its full list stays pinned in `control-plane-migrations.test.ts`). No migration was applied to a D1 database and no Worker was deployed, so the schema the off control plane ends up with is unverified. |
| T16 | none | none | NOT RUN | Packaged desktop and deployed hosted not exercised. |
| T17 | preset model/service/http tests; preset editor vitest | live create | PASS (local) | Preset `tpr_f8e66290…` persisted with harness/model/instructions; archive/restore not run live. |
| T18 | preview tests; editor revalidation vitest | live preview | PASS (local) | Preview resolved the project's workspace after `e314940f35`; before it the preview was blocked "No reachable workspace" for a task with no explicit workspace. |
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
| hosted Worker `…candidate-agent-plugins` | `bun run build:workerd-boundary` (real `wrangler deploy --dry-run`) | 1165 modules contributing bytes, 25 of them Tasks, `/api/claxedo/tasks` present, 41 staged control-plane migrations | 1085 modules, 0 Tasks modules, route path absent, 40 staged migrations |
| hosted Worker `…agent-plugins-full-hosted` | same command, same run | 1635 modules contributing bytes, 25 of them Tasks | 1563 modules, 0 Tasks modules |

The `app-local` and `server-self-hosted` policies in `script/product-boundary/policies/` carry the emitted rules and were cross-checked in both directions: the disabled manifest read against the enabled policy reports the missing required Tasks modules, and the enabled manifest read against the disabled policy reports the forbidden ones.

What is NOT proven:

- The desktop RENDERER has no artifact-level Tasks rule. `desktopRendererBoundaryManifestPlugin` records the base entry's STATIC closure, so a measured enabled build carries no Tasks module and no Tasks chunk either; a forbidden rule there would pass on both artifacts. The renderer source is `@claxedo/app`'s, so the cut is covered by `app-local`'s emitted manifest and the app guard. A desktop-specific emitted proof needs that plugin to record the renderer's dynamic closure.
- The hosted Worker is now selected the same way, with no new certified artifact id: the entry gates Tasks on `process.env.CLAXEDO_BUILD_TASKS`, both Worker config renderers emit that comparison into `[define]`, and `migrations_dir` names a directory staged by `script/migration-journal.ts`. Proven by the real Wrangler dry run above and by the emitted-artifact cases in `core-resource-closure.test.ts` (all four mutants — inverted entry gate, static import instead of the folded dynamic one, inverted `[define]`, inverted staging predicate — fail it). Each built entry was also booted in workerd with no bindings and answered its documented fail-closed code on both selections.
- What that does NOT prove: no Worker was deployed, no `wrangler d1 migrations apply` was run against a D1 database, and no request reached `/api/claxedo/tasks` on a hosted deployment in either selection. `smoke:workerd-boundary` cannot currently confirm the whole set: the PLAIN candidate entry fails to boot in workerd with `TypeError: Class2 is not a constructor`, a pre-existing defect — that entry's emitted bundle is byte-identical (sha256 `76bc1e4c…`) with and without this change's config rendering.
- No packaged desktop and no deployed hosted Worker were built or exercised (T16 stays NOT RUN).

## Defects found only by the live run

- Picking a harness in the preset editor overflowed Solid's reactive graph: the slot editor called the host editor as a function inside JSX and the draft callback read the parent's signal inside a child effect. Fixed in `e40f2444f2` with `Dynamic` + `untrack`; regression test in `preset-editor.vitest.tsx` (both mutants fail).
- The bridge resolved a workspace only from the task's explicit preference, never from the project. Fixed in `e314940f35` (`projectTarget`, deterministic root/primary-checkout choice, refusal naming candidates when ambiguous).
- A refused status change left the native select showing the refused value. Fixed in `571c0a6a18`.

## Reds inherited from dev `85f1d007c8` (proven at the base commit)

claxedo-server: `deployment-closures` (Better Auth locked closure 16 > 15), `governance/codebase-shape` (`documents/routes/index.ts` missing), `session-env-document-roundtrip.integration` (Pi executable), `local-product-contract` allowlist (extra `/api/claxedo/agent-config/providers/custom` from `2e1d6ee407`). workspace-runtime: `generateNotifyScript > reports failed delivery…`. local-server: `control-plane Pi catalog > serves credential-owner authentication methods…`. Root lint: three errors in `claxedo-app/perf-harness/**` on this checkout.

## Escalations outside this feature

- Hosted session access ranks a caller by workspace owner, workspace and project memberships and org role (`actorWorkspaceRoleRankSql` in `packages/claxedo-server-core/src/authority/adapters/sqlite/session-authority.ts`), while project access also counts team grants (`projectAccess` in `workspace-authority.ts`). A member whose project access comes only through a team grant passes `authorizeProject`, can create and edit tasks, and is refused at session reservation. Every hosted session create has the same gap; Tasks is the first feature that makes it visible. Owner: session authority. Not changed on this branch.
- Preview cannot refuse an unsupported effort level: no host-side reader exists for a harness's effort levels that is independent of that harness's current model, so effort travels as `variant` and the runtime refuses at create.

## Fix wave after the Codex review (same day)

All fifteen findings in codex-gpt-6-astra-review.md were acted on in round 1; each fix carries a mutation-checked test. The re-review (codex-gpt-6-astra-rereview.md) judged seven closed and eight partial and added five findings; round 2 below addresses every one of those.

| Finding | Commit | Outcome |
|---|---|---|
| 1 Start bypassed session authorization | `adcb6b699c` | `authorizeSessionOpen` before an idempotent return, a readability probe, or a Continue transcript read |
| 2 Origin did not reserve its configuration | `adcb6b699c`, `c48a73f627` | `configurationDigest` on the link and in the hosted operationId; both hosts read the session config back and refuse a mismatch |
| 3 Settlement ignored the admitting state | `adcb6b699c` | link insert plus task CAS in one unit; the task revision advances on link |
| 4 Parent guard used a reread | `adcb6b699c`, `66d974c3ef` | validated parent snapshot carried to the CAS; conformance case pins no in-write reread |
| 5 SQLite transaction on the shared connection | `66d974c3ef` | dedicated Tasks connection (`ClaxedoDB.connect()`), `BEGIN DEFERRED`; an unrelated write survives a Tasks rollback |
| 6 Memory rollback over concurrent commits | `66d974c3ef` | serialized units; overlap cases pinned in the conformance suite |
| 7 Unreadable history read as not sent | `adcb6b699c` | `present / absent / unreadable`; unreadable refuses |
| 8 Metadata never repaired on recovery | `adcb6b699c` | projection reconciled when an existing reserved session is recovered |
| 9 D1 commit conflicts unclassified | `66d974c3ef`, `c48a73f627` | typed `TasksStoreConflict`; duplicate receipts replay, competitors get 409 |
| 10 Continue unreachable | `adcb6b699c`, `c149b62a22` | readability computed independent of the checkbox; dialog re-previews without unmounting the row |
| 11 Pagination dropped | `c149b62a22` | cursors followed; Load more on list and board; children auto-follow |
| 12 Signed self-host mounted loopback composition | `8c77c74f48`, `1fb18ad49f`, `6c10630f4a` | signed SQLite composition selected by the composed auth posture; sessions reserved for the signed starter |
| 13 No build-time selection | `1fb18ad49f` | `CLAXEDO_BUILD_TASKS` define-gated loaders and baked server gates; measured ON/OFF artifacts (see T01 section) |
| 14 Config read failed open | `a157f6a269` | a failing config read refuses the turn; a missing row still prompts |
| 15 Comments claimed absent checks | `adcb6b699c`, `2a972a4aa8` | effort comment rewritten; hosted capabilities report local only |

Also found and fixed during the wave: the kit client dropped `currentTask` / `currentPreset` from stale-revision refusals, so every rebase path in the app was dead while its hand-built tests passed (`b69be7a7ac`); the Start flow now rebases once and retries, and the edit conflict paths are proven through the real transport (`a6d3815550`).

Still not proven here: packaged desktop, deployed hosted Worker, a credentialed model turn, cloud placement (S5/S6), delegation with effort (S7).

## Round 2 after the re-review (same day)

Commits are named by subject because the branch history was rewritten for attribution after they landed.

| Re-review item | Commit subject | Outcome |
|---|---|---|
| 1 remainder (transcript read without recheck) | `fix(tasks): link the session before handing the task over, and gate the slot on what is there to open` | the service re-authorizes the previous session immediately before calling the bridge; a deleted session is never offered as a transcript |
| 2 remainder (unsigned local creation race) | same | per-origin lock around reserve/probe/create/recover; a create refused for a taken id is re-probed and compared by configuration |
| 3 remainder (settlement, existing-link comparison) | same | preset revision re-read inside the settlement unit; an occupied origin answers only when session id, digest and workspace all match |
| 7 remainder (link before handoff) | same | bridge split into `start` and `handoff`; the link commits between them; a retry after a crash between the two sends once |
| 9 remainder / N3 (duplicate edit replay) | `fix(tasks): answer a duplicate command from its receipt inside the unit` | receipt lookup inside the serialized unit; a `stale_revision` loser with a committed receipt replays; cases on memory, SQLite and D1 |
| 13 remainder (hosted Worker) | `feat(tasks): select Tasks for the hosted Worker at build time` | `[define]` rendered into the Wrangler config, one dynamic import inside the folded branch, staged control-plane migrations; measured ON 1165 modules / 25 Tasks / 41 migrations vs OFF 1085 / 0 / 40 under a real `wrangler deploy --dry-run` |
| 14 remainder / N1 (admission marker on a refused turn) | `fix(runtime): free a prompt_async admission when the turn is refused before execution` | admission means accepted execution; the refusal is published as a session error with `session_configuration_unavailable`; a retry with the same message id executes once with the retained instructions |
| 15 remainder / N5 (comments) | `chore(tasks): comments say only what the code cannot` | comment pass over every branch file; the authorization resolver comment now states human principals only |
| N2 (deleted session blocks Start again) | `fix(tasks): link the session before handing the task over…` | liveness classified before authorization; a deleted session permits attempt+1 without a grant; deleted links stay visible so the next attempt is derived correctly |
| N4 (unbounded auto-pagination) | `fix(tasks): stop following a list at a failed page and offer the retry that resumes it` | following stops at a failed page; Retry resumes it; bounded request counts asserted |
| found on the way | `fix(tasks): tell a refused preset read apart from an empty catalog` | a refused first preset page no longer renders as "no presets" |
| found on the way | `test(runtime): keep boundary and local build outputs out of the SDK-boundary walk` | the SDK-boundary guard no longer scans `dist-boundary` / `dist-local` bundles |

Still not proven here: packaged desktop, a deployed hosted Worker (dry run only), a credentialed model turn, cloud placement (S5/S6), delegation with effort (S7), and `prompt_async` still answers 204 before the configuration read on the adapter path (the refusal is on the event stream).
