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
| T08 | local bridge test against a real embedded runtime; hosted bridge with captured fetch | live Start with a credentialed model turn (2026-09-13) | PASS (local, live) | Second run on a fresh data dir after the Claude login was renewed: session `ses_tasks_cd6bab40…` created in the project workspace with harness `claude`, model `claude/opus[1m]`; the assistant reply began with `TASKMODE` (the preset instruction) and `add.js` on disk gained `export function subtract(a, b)`; the link read back `handoff: sent`. First run (2026-09-12) had failed on an expired provider credential, which was an environment gate. |
| T09 | service attempt-rule tests; bridge replay tests | live Open on an occupied slot | PASS (local) | Open navigated to the same session; only GETs on the task routes, no second create. Two-client conflicting case not run live. |
| T10 | bridge fault tests | none | PARTIAL | Interruption faults only in unit tests. |
| T11 | bridge no-resend test | none | PARTIAL | Live delete-then-Start-again not run. |
| T12 | persistence tests | live reload + restart, Open later | PASS (local) | Link row `primary / attempt 1 / Careful reviewer / live` read back from `claxedo_task_session_link`. Start-again after archive not run live. |
| T13 | vitest | screenshots at 1024×768 only | PARTIAL | No dark/light or narrow pass. |
| T14 | http negative tests; hosted composition 403/404 test | none | PASS (automated only) | |
| T15 | Miniflare D1 conformance + migration ordering test; staged control-plane migration selection in `core-resource-closure.test.ts` | none | PASS (automated only) | The hosted Worker's `migrations_dir` now names a staged directory: measured, the on staging is the full source list and the off staging is that list without `0024_claxedo_tasks.sql`, with the source directory unchanged (its full list stays pinned in `control-plane-migrations.test.ts`). No migration was applied to a D1 database and no Worker was deployed, so the schema the off control plane ends up with is unverified. |
| T16 | desktop compile-cache evaluation of the bundled server (part of `bun run package`) | packaged build attempted 2026-09-13 | PARTIAL (Tasks half proven; packaging blocked upstream) | The first attempt failed inside the compile-cache step with `serializedTransactions is not defined`: Bun's split bundle had dropped every `@claxedo/tasks` module because the package carried a `sideEffects` hint (fixed, pinned by `packages/claxedo-tasks/src/package-manifest.test.ts`). The second attempt passed the server bundle and the compile-cache evaluation and then failed in electron-builder's file-traversal dependency collector (`ansi-regex` under `strip-ansi` in Bun's hoisted layout), the pre-existing app-builder-lib blocker that predates the branch; no `.app` was produced, so the packaged flow was not driven. Deployed hosted not exercised. |
| T17 | preset model/service/http tests; preset editor vitest | live create | PASS (local) | Preset `tpr_f8e66290…` persisted with harness/model/instructions; archive/restore not run live. |
| T18 | preview tests; editor revalidation vitest | live preview | PASS (local) | Preview resolved the project's workspace after `e314940f35`; before it the preview was blocked "No reachable workspace" for a task with no explicit workspace. |
| T19 | local bridge tests | live through the real routes (2026-09-13) | PASS (local, live) | Second preset `Alt voice` with a different instruction block and a second task started on the same project workspace: the runtime store holds `TASKMODE…` on the first session and `ALTMODE…` on the second, and each model reply began with its own word (`TASKMODE — Added…`, `ALTMODE Hello!`). Local skills/plugins untouched (inherit-local); cloud fallback not applicable. |
| T20 | `packages/claxedo-server/src/tasks/session-bridge-cloud.test.ts` against the real workspace store, the real sandbox manager and the fake driver seam | none | PARTIAL (automated only; real isolation GATING) | Proven: two roots in one project are allocated two workspaces with distinct ids and distinct sandbox targets, each cloning the project's own remote at its ref; a retried start of one root recovers that same workspace (one authority create, one workspace row, one lease still at epoch 1) rather than allocating a second; a provision that fails leaves neither a workspace row nor an authority record and the start is refused; a root is kept out of its project's workspace list so an ordinary local Start still resolves one workspace. Not proven: no real driver ran, so nothing about actual filesystem, home, config or plugin-data isolation between two live roots, nor suspend/restart and reopen, was observed. The authority calls that admit and discard a root ran against a fake, not D1. |
| T21 | `packages/claxedo-local-server/src/agent-plugins/runtime/selected-execution.test.ts` against the four real harness adapters and the real materializer; `packages/claxedo-local-server/src/agent-plugins/runtime/runtime-contribution.test.ts` against the real apply route; `packages/claxedo-server/src/agent-plugins/runtime/selected-projection.test.ts` and `provision.test.ts` | none | PARTIAL (automated only; real two-root inventory GATING) | Proven with fakes: a selected plugin contributes its bundled skills and its declared server, while a directly selected skill contributes only that skill's directory — every one of the four adapters receives a pruned tree with the other skills and `mcp.json` removed, and OpenCode's generated config lists the selected plugin's server and not the guidance-only plugin's; an empty selection projects no plugin roots through any adapter, leaves Codex's config empty and Cursor's local directory empty, and reads back after a restart as `{ mode: "selected" }` with its own hash; identities are deduplicated (a skill its own selected plugin already ships is not selected twice) and unresolved or ambiguous references and a same-name skill pair that OpenCode's flat skill list would collapse are all refused; a selected plugin whose project default is *disabled* still resolves, because entitlement is the retained pin and not the default; a contribution under default activation, or a missing one under a selected execution, is refused before anything is written; with global defaults deliberately installed (a `[plugins."ops@baked-in"]` table in Codex's config and an unowned child of `~/.cursor/plugins/local`) a selected projection is refused for those harnesses and ordinary activation leaves both untouched; the same activation revision under a different selection hash is a different generation at the runtime and a separate apply at the provisioner, and a request declaring a selection at apply version 1 is refused rather than applied as defaults. Not proven: no real driver and no real harness ran, so no harness ever listed its actual skills or tools; two live roots with disjoint selections in one project, and a process restart of a real runtime, were not observed. That remains GATING without sandbox driver credentials. |
| T22 | `packages/claxedo-server/src/agent-plugins/mcp/runtime-preparation.test.ts` and `gateway-authorization.test.ts`; `packages/claxedo-server/src/tasks/session-bridge-cloud.test.ts` against the real workspace store, the real sandbox manager and the fake driver seam; `packages/claxedo-server/src/tasks/hosted-composition.test.ts` placement rows | none | PARTIAL (automated only; live gateway call and revocation GATING) | Proven with fakes: default activation prepares a gateway capability for every effective plugin's server, and the same snapshot under a selection prepares one only for a selected plugin — a plugin chosen as guidance, and one not chosen at all, produce no server row and no brokered secret at all, so there is no broader credential left behind a hidden tool; the minted capability is scoped to the workspace, harness, plugin, server and integration, and now also names the artifact digest and the execution it was issued under; at the gateway, a selected credential authorizes against the retained pin rather than the project's default, so it keeps working for a plugin the project has switched off and stops the moment that pin moves to another digest (or the membership/project read the gateway repeats fails); the cloud root's own credentials reach the sandbox on the `ensure` that creates it, and a Start whose runtime did not acknowledge the exact selection is refused with `capability_unavailable` instead of running on inherited defaults; a deployment with a driver but no Agent Plugins wiring refuses cloud placement before any sandbox exists, and `cloudSelectedCapabilities` is true only when both halves are present. Not proven: no live gateway request was made and no access was revoked while a runtime held a credential, so the measured revocation latency the design asks for is unrecorded; a stopped cloud workspace was never restored. That remains GATING without sandbox driver credentials and a deployed gateway. |
| T23 | `packages/claxedo-mcp/src/tools/subagents.test.ts` against the real `create_subagent` tool over a real MCP transport; `packages/claxedo-local-server/src/tasks/session-bridge.test.ts` against the real embedded runtime; `packages/claxedo-tasks/src/start.test.ts` | none | PARTIAL (automated only; live distinct models GATING) | Proven: a Start retains the whole resolved group on the session and reads it back on `GET /session/<id>/config`, with a slot the preset never configured absent rather than empty; an effort a `resolved` harness catalog refuses blocks the preview with `effort_unsupported` naming the levels it accepts and refuses the Start, while `unresolved`, `unsupported` and an accepting catalog all start; `create_subagent` resolves a `configuration` slot from the parent's retained group and the child's own config reads back that slot's model and `variant`; the child is created with the parent's retained instructions plus a block naming the configuration it runs; an unknown slot is refused with the slots the group has, a contradicting harness/model/effort is refused, a refused effort is refused with the accepted levels named and no child is created, a connection-access slot reaches the create as a connection rather than a native id, a child cannot widen the parent's permission ceiling, and a retried `clientRequestId` returns the same child and prompts it once. Not proven: no live run — two distinct real models were never observed answering, no real harness catalog supplied the effort levels (the refused/accepted catalogs are fixture rows), and cross-harness handoff was not exercised. OpenCode and Pi report `unsupported` effort because `opencodeProviderCatalog` carries no per-model variants, so an effort on those harnesses is neither honoured nor refused at preview. |
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
- OpenCode and Pi report no effort levels at all. Their per-model variants would have to come from `opencodeProviderCatalog` (`packages/claxedo-server-core/src/credentials/opencode-provider-catalog.ts`), whose model rows carry `reasoning: boolean` and no level list, so the adapters report `unsupported` and neither the preview nor `create_subagent` can judge an effort on those two harnesses. Owner: the OpenCode catalog reader. Not changed on this branch.
- `harnessEffortVerdict` decides the same question in two places. `@claxedo/mcp` cannot import `@claxedo/agent-sdk-runtime` — that is a new package edge in a measured product closure which today reaches only the MCP SDK, hono, zod, helpers and the runtime contract — so `refuseUnsupportedEffort` in `packages/claxedo-mcp/src/tools/subagents.ts` restates the rule the bridge takes from the shared function. Closing it means moving `harness-effort.ts` into `@claxedo/agent-runtime-contract`, which both packages already depend on. Owner: the runtime contract package.

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

## Round 3 after the third review (same day)

The third review (codex-gpt-6-astra-review3.md) judged eight closed, five partial and added R1 and R2. Commits by subject.

| Item | Commit subject | Outcome |
|---|---|---|
| 1 remainder (revocation during the bridge's await) | `fix(tasks): authorize the transcript at the read, assert the preset at settlement, and recover a stranded origin` | the bridge command carries `authorizeTranscript()`, asked immediately before each transcript read; false means no read and `forbidden` |
| 3 remainder (no D1 predicate on the preset re-read) | same | `presets.assertRevision` inside the settlement unit; D1 turns it into a guard row in the same batch; conformance case on all three stores; the matching-link branch is proven write-free |
| R2 (refused settlement strands the origin) | same, plus `fix(authority): release a compensated reservation's session and operation ids` and `fix(tasks): only a pending compensation blocks a hosted reservation` | `bridge.abandon` deletes a created session only when its history is readable and carries no first message, then forgets its metadata and releases the reservation; a completed compensation releases its ids at the next reservation, with no schema change (a partial unique index is infeasible on D1 because `sessions` references the operations table by foreign key) |
| 7 remainder and R1 (link committed, message never sent) | same, plus `fix(tasks): let task detail resend a first message that never landed` | `handoffText` persisted on the link; each live link reports `handoff` as sent, pending or unknown from the same history read the handoff uses; task detail shows Send task for a pending link and posts the current attempt, which the service delivers idempotently |
| N1 remainder (204 before admission) | `fix(runtime): answer prompt_async only once the turn is admitted` | pre-execution admission runs before the response; a refused configuration read answers 503 `session_configuration_unavailable`; a slow model turn does not delay the 204 |
| 15 remainder (comments claiming more than proven) | first commit above | the bridge port's comments state that deleted links pass without a grant and that delivery is at-most-once per readback |

Gates at the round-3 tip: see the final section of this file once recorded. Still not proven here: packaged desktop, a deployed Worker (dry run only), a credentialed model turn, cloud placement (S5/S6), delegation with effort (S7); durable admission across a runtime restart still rests on the history readback rather than a runtime-owned journal.

## Gates at the round-3 tip

| Gate | Result |
|---|---|
| root `bun run test:architecture-ratchets` | product boundary holds (5 products, 8 policies); helpers ratchet passed |
| root `bun run lint` | 3 errors, all in `packages/claxedo-app/perf-harness/**`, byte-identical on dev |
| `packages/claxedo-tasks` `bun run test` / `typecheck` | 180 pass / clean |
| `packages/claxedo-app` tasks vitest / architecture guards / `tsgo -b` | 50 pass / 259 pass / clean |
| `packages/claxedo-server-core` `src/tasks-host` / `typecheck` | 25 pass / clean |
| `packages/claxedo-server` tasks, dispatch, hosted-workerd, selection / `typecheck` | 205 pass / clean |
| `packages/claxedo-local-server` tasks, execution allowlist, architecture / `typecheck` | 33 pass / clean |
| `packages/workspace-runtime` `bun run test` / `typecheck` | 1036 pass, 1 fail (`generateNotifyScript > reports failed delivery…`, pre-existing on dev) / clean |
| `packages/claxedo-desktop` `typecheck` | clean |
| authority adapters (`src/authority`, `src/platform/auth`) | 99 pass server-core, 275 pass server |

## Wave 4: plan slices S5–S7 (2026-09-13)

Commits by subject.

| Slice | Commit subject | Outcome | Proof |
|---|---|---|---|
| S7 runtime contract | `feat(runtime): retain a session's model group and report the effort a harness accepts` | immutable `group` on session config (400 `session_group_invalid`, 409 `session_group_immutable`); `effortLevels` on the capability read from the Claude and Codex drivers; child creates honor variant, instructions and group | real routes; store reopen; per-harness fixtures. OpenCode and Pi report `unsupported`: the provider catalog carries only `reasoning: boolean`, so no level list exists to read (escalation) |
| S7 delegation | `feat(tasks): delegate a session's own model group, and refuse an effort its harness will not run` | `create_subagent` gains `effort` and `configuration` (slot key resolved from the parent's retained group), validates against capabilities and the parent's ceiling, passes retained instructions; preview refuses `effort_unsupported` when the harness resolved its levels | real MCP tool on a real transport (13 cases); local bridge with the embedded runtime. T23 row updated: automated half proven, live distinct models GATING |
| S5 cloud allocation | `feat(tasks): allocate an isolated cloud workspace per Tasks root` | one workspace per Tasks origin, id derived from the origin (no new table), retries recover it, failure removes it, readiness bounded; hosted capabilities report cloud only with a configured driver | fake driver seam; T20 real isolation GATING (no DAYTONA/MODAL credentials, no wrangler login) |
| S6 selected-only projection | `feat(tasks): run a cloud root on the capability set its preset chose` | apply contract v2 `execution: { mode: "selected", selectionHash }`; projection from retained pins not activation defaults; bundled skills, guidance-only direct skills, dedup, collision refusal; hash in preparation, coalescing, apply, generation and receipt; gateway capabilities minted for the selected manifest only; hosted bridge refuses an unacknowledged selection | adapter, coalescing, gateway and bridge tests with fakes; T21–T22 rows updated, real inventory and revocation GATING |

Also fixed on the way: the `sideEffects` bundling defect above (`fix(tasks): drop the sideEffects hint that made Bun's split bundle discard the kit`), and the SDK-boundary guard scanning build outputs.

Escalations added in this wave: OpenCode/Pi effort vocabulary needs an owner in the provider catalog; `refuseUnsupportedEffort` in `@claxedo/mcp` restates `harnessEffortVerdict` because that package may not import the SDK runtime (move `harness-effort.ts` to `@claxedo/agent-runtime-contract`); `createCloudWorkspace` requires org admin, so a plain member's cloud Start is refused (policy question); `prompt_async` still answers 204 for non-refusal admission errors on the runtime path.

## Gates at the wave-4 tip (2026-09-13)

| Gate | Result |
|---|---|
| root `bun run test:architecture-ratchets` | product boundary holds (5 products, 8 policies); helpers ratchet passed |
| root `bun run lint` | 3 errors, all in `packages/claxedo-app/perf-harness/**`, byte-identical on dev |
| `packages/claxedo-tasks` `bun run test` / `typecheck` | 184 pass / clean |
| `packages/claxedo-mcp` `bun run test` / `typecheck` | 143 pass, 3 fail (`session_create` permission-ceiling and cloud-placement cases, present at the pre-wave tip `18910aa58b`; not touched by this branch) / clean |
| `packages/claxedo-app` tasks vitest / architecture guards / `tsgo -b` | 50 pass / 259 pass / clean |
| `packages/claxedo-server-core` tasks-host, agent-plugins, authority, auth / `typecheck` | 218 pass / clean |
| `packages/claxedo-server` tasks, agent-plugins, workspace, sandbox, dispatch, hosted-workerd, selection, authority / `typecheck` | 966 pass / clean |
| `packages/claxedo-local-server` tasks, agent-plugins, execution allowlist, architecture / `typecheck` | 123 pass / clean |
| `packages/workspace-runtime` `bun run test` / `typecheck` | 1050 pass, 1 fail (`generateNotifyScript > reports failed delivery…`, pre-existing on dev) / clean |
| `packages/agent-sdk-runtime` `typecheck` | clean |
| `packages/claxedo-desktop` `typecheck` | clean |
| `packages/claxedo-app` `verify:closure` (real build, marker control, emitted identity) | passes; `tasks-surface-*.css` emitted |

## UI rounds from the user's screenshots (2026-09-13)

The user measured the surface against Circle (lndev-ui's Linear clone) and sent six rounds of screenshot feedback on the running stack. Commits by subject, oldest first.

| Commit subject | What the user asked | Outcome |
|---|---|---|
| `feat(tasks): redesign the Tasks and Presets surface` | "current UI is very ugly" | header with count and tab switch, Filter/Display controls, grouped table with sticky group headers, board columns, two-pane task page, presets table, "Where this will run" start card; host tokens only |
| `feat(tasks): start a task from its row, and follow the host's own status palette` | no status control inside a status group; start from the row with a preset caret; drop the blue borders; preset chosen at start, not a setting | split Start control on rows and cards; status chip is the native select restyled; `RowMenu`; host status colours |
| `feat(tasks): make a subtask's page say whose it is, and scope the capability promise` | subtask tag on the page, no empty Subtasks section on a subtask, subtask rows clickable; banner that a saved local+cloud preset guarantees no tool set | `Subtask of …` tag; `CapabilityNotice` on Cloud placement |
| `fix(tasks): let the task page and the preset editor fill the width they are given` | "not full width looking ugly" | page and editor stretch to the pane |
| `feat(tasks): edit descriptions and preset instructions in the Documents editor` | Notion-like editor rather than a transcript renderer; user accepted Tiptap | `ProseEditor` host port → Documents `RichMode` behind `detectMarkdown`; markdown remains the record; `source`/`rejected` falls back to the textarea |
| `feat(tasks): put the draft's actions in the page header and give the create dialog the editor` | Save at the top right; `#`/`##` must work; markdown when creating | Save/Discard on the breadcrumb row while dirty, Cmd/Ctrl+S; New task dialog laid out like Linear's new-issue modal with the same editor |

The "typing `#` does nothing" report reproduced only on the New task dialog, which was the one description still on a plain textarea; the task page and preset instructions already converted. Live proof after the last commit, Playwright `keyboard.type` per key against the running stack (the Browser pane's own `type` inserts a whole string at once and its `key` action carries no text, so neither can fire an input rule that completes on the space keystroke):

| Surface | Typed | Editor DOM | Stored |
|---|---|---|---|
| New task dialog | `## Plan` ⏎ `- read the file` ⏎ `write the test` | `<h2>Plan</h2><ul><li>…read the file…</li><li>…write the test…</li></ul>` | markdown (mounted test `create-task-dialog.vitest.tsx`) |
| task page, empty description | ⏎ `## Plan` ⏎ `- read the file` | `<h2>Plan</h2><ul><li>…</li></ul>`; breadcrumb row shows `Unsaved changes · Discard · Save` | `tasks-markdown-shortcuts.vitest.tsx` drives the production extension set through `handleTextInput` for `#`, `##`, `-`, `1.`, `>` and a fence and asserts the markdown round-trips |
| task page, populated description | `## Plan` at the caret | `<h2>Plan</h2>`; the `- ` rule correctly declines inside a block that already holds text | same |

Gates at this tip: app tasks vitest 77 pass (14 files); kit 186 pass; `tsgo -b` and kit typecheck clean; architecture guards 259 pass; `test:architecture-ratchets` holds with app-local 1044 modules / 58 packages and desktop renderer 1087 / 58 (Tiptap's chunk was measured and the ceilings raised in the editor commit); `lint:theme-tokens` at its two pre-existing failures; root lint at the three pre-existing perf-harness errors.

## Full markdown in the editor (2026-09-13)

The user clarified that `#` and `##` were examples and the description must support markdown in full, with every fix in the existing components rather than a parallel path. Measured before the change against `documentRichEditorExtensions()` (typing through `handleTextInput`, loading, a real paste in Playwright, and `detectMarkdown`): emphasis, strike, code, rules, task items, headings, bullets, `1.`, fences and highlight already converted on typing; loading rendered every GFM construct. The gaps and where they were closed, all in the Documents editor and its detector (`fix(documents): close the markdown gaps between what the editor parses and what it converts`, then `fix(documents): leave text pasted inside a code block to the default paste`):

| Gap | Cause | Fix |
|---|---|---|
| typed `[text](url)` stayed literal | `@tiptap/extension-link` ships no input rule | `Link.extend({ addInputRules })` in `editor/markdown-input-rules.ts`; written out because `markInputRule` keeps the last capture as the visible text |
| typed `![alt](url)` wiped the line, `getMarkdown()` empty | `Image` block while the parser places images inline | `Image.configure({ inline: true })` |
| typed `1) ` started no list though the parser reads `1)` | bundled rule accepts `.` only | `OrderedListParenInput` beside the bundled rule |
| pasted markdown became literal paragraphs | `@tiptap/markdown` 3.23.4 has no paste option (`indentation`, `marked`, `markedOptions` only) | `MarkdownPaste` parses text/plain through the editor's own manager when no text/html is present and the caret is not in a code block (the first cut converted a `#` comment pasted into a fence into a heading; caught by a probe before it shipped) |
| `* item`, `__bold__`, `1) x`, loose lists, unpadded tables and any document with a table opened in the textarea | the detector's byte-identity gate; the serializer normalizes them | `detectMarkdown(input, fidelity)`: `exact` (Documents, default) unchanged; `normalizing` for the app-owned Tasks record |

Left as upstream: `@tiptap/markdown` emits `\n\n\n` around a serialized table; `serializeMarkdownDocument` only trims trailing newlines.

Live proof on the running stack (Playwright `keyboard.type` and a real `ClipboardEvent` in the New task dialog): one line with bold, italic, strike, code and a link; `1)` list; task item; inline image; rule; then a pasted GFM document rendered as h1, marks, link, table, task list, quote, `js` fence, rule and ordered list, nothing literal. Gates: app vitest for tasks, tasks integrations and documents 17 files / 111 pass (the Documents fidelity proof included); `tsgo -b` clean; architecture guards 259; ratchets hold at app-local 1046 / 58 and desktop renderer 1089 / 58 (two new Documents modules, no new package edge); theme-token lint at its two pre-existing failures; root lint at the three pre-existing perf-harness errors.

## Codex review of the UI and markdown commits, and the fix round (2026-09-13)

`codex-gpt-6-astra-review-ui-markdown.md` covers the range `705d912351..7b67f20d2d` only (the feature itself had three reviews already). Verdict was "not ready to merge" with six findings; every one was reproduced against the code before it was fixed, and the first was worse than reported. Two lanes fixed them with disjoint ownership.

| Finding | Verified how | Fix commit | Proof |
|---|---|---|---|
| P1 pasting markdown with an HTML comment loses it | production `handlePaste` called directly: it threw `RangeError: Invalid content for node paragraph`, so the paste did nothing | `fix(documents): gate a markdown paste on representability and fit it to the selection` | the paste path asks `detectMarkdown(text, "normalizing")` first and yields to ProseMirror's literal paste otherwise; plugin-level tests; live paste of the comment lands verbatim |
| P1 a description replaced from outside bypassed the detector | read: `admitted` computed once at mount, later values forwarded to `RichMode.setContent` | `fix(tasks): re-admit a description replaced from outside the editor` | `createMemo` re-detects any value the editor did not itself emit; mounted tests for the replacement and the emitted-value cases; three mutants killed |
| P2 pasting a word mid-sentence split the paragraph | production handler: `hello ` + `nice ` → three paragraphs | same commit as the first | `Slice.maxOpen` + `replaceSelection`; `<p>hello nice world</p>` in test and live |
| P2 "Create a preset" from a row opened nothing | read: draft opened in the store, editor rendered only on the Presets page | `fix(tasks): give a row's Start and Open the attempt rule the service enforces` | the row now also navigates to Presets; mounted surface transition test |
| P2 a row's Open went to a deleted session and Start always asked for attempt 1 | read `checkAttempt` in `tasks/service.ts`: only `current` while live, `current + 1` once gone | same commit | `slotAttempt` in the kit's view-model shared by the task page and the row; row Start on a deleted slot previews attempt 2, Open on it reports instead of navigating |
| P2 subtask `done/total` counted the filtered page | read: `progressById` folded `visible()`, which excludes done tasks in Active | `fix(tasks): count subtasks in the store, not in the page the list happened to get` | `TaskSummary.children` computed by the memory, SQLite and D1 stores (archived excluded), conformance case reads a parent through a one-row page, paired page-folding mutant killed on all three |

Found on the way: the memory store's row-key separator was a raw NUL byte in the source, so git had shown every change to that file as "Binary files differ" since the package landed (`fix(tasks): spell the memory store's row-key separator as an escape`). The running dev server had to be restarted after the contract change: the client's decoder refuses a summary without `children`, so an old server process answered "Response did not match the tasks contract".

Gates at this tip: app vitest tasks + integrations + documents 18 files / 122 pass; kit 188; server-core tasks-host 27; local-server tasks 27; D1 conformance new case green under Miniflare (the whole `src/tasks` directory there is environmentally flaky on `spawn(workerd) ENOENT`, never an assertion); `tsgo -b` and every touched package's typecheck clean; architecture guards 259; ratchets unchanged at 1046 / 58 and 1089 / 58; theme-token lint two pre-existing; root lint three pre-existing.

## Second Codex pass and its fix round (2026-09-13)

`codex-gpt-6-astra-rereview-ui-markdown.md` re-reviewed the first fix round (the second and last consultation on this range under the two-review rule). It rated four of the six prior findings closed and two partially closed, and raised three new ones. Every claim was reproduced before it was fixed; the restart-test finding turned out worse than reported (the fake answered a route the client never posts, so the start threw and was swallowed on every run while the test passed).

| Finding | Verified how | Fix commit | Proof |
|---|---|---|---|
| P1 pasted frontmatter bypassed the gate (detector reads the body, handler parsed the whole string) | production handler: the comment vanished and the delimiters became a rule | `fix(documents): paste a markdown document as the blocks it is, and leave an enveloped one to the literal path` | an enveloped paste yields to the literal path; live paste keeps the comment verbatim |
| P1 an emitted value could inherit a later replacement's rich admission | read: the marker was the text alone | `fix(tasks): let the field's emission carry the detection it was admitted under` | emit → replace → restore ends on the textarea with the comment intact |
| P2 block pastes flattened into the paragraph | production handler: `# Title` → `hello Titleworld` | same commit as the first | a lone paragraph still fits inline; anything else is inserted closed and keeps its blocks, in tests and live |
| P2 row Open looked only at the primary slot | read: default `slot = "primary"` | `fix(tasks): open the session of whichever slot ran, and send the start the row's test claimed` | `openableSlot` in the kit beside `slotAttempt`; secondary-only live session opens |
| P2 the restart test asserted only the preview | read, then found the fake's wrong route | same commit | consistent fake, start asserted with attempt 2 and the digest, navigation asserted; removing the send fails it |

Gates at this tip: app vitest tasks + integrations + documents 18 files / 129 pass; kit 194 and its typecheck clean; architecture guards 259; theme-token lint two pre-existing; root lint three pre-existing. `tsgo -b` and the ratchets were red on the first-project lane's uncommitted files alone — a `TS1355` in `project-create-form.tsx` and two modules, `first-project-canvas.{tsx,css}`, reachable from both app entries. Re-measured at `1040ae39c0`, where that lane landed the fix and raised the two ceilings to the numbers those modules account for: `tsgo -b` clean, product boundary holds at app-local 1048 / 58 and desktop renderer 1091 / 58.

## First-project canvas (2026-09-13)

The user hit the host's no-project screen (a "Select project" chip over an empty list, stacked on a "New Project" button to the same form, under an upscaled logo) and chose to inline the create form. `feat(workbench): open on the first project's form instead of a select with nothing in it`: `FirstProjectCanvas` renders `ProjectCreateForm` as its third host (a `size` prop; folder button renamed "Choose folder" everywhere) with a headline, a lede, and Diagnostics as a quiet link; background drawn from host tokens only (grid, glow, drifting hatch off under reduced motion, vignette); one staggered reveal. `LegacyEmptyState`, `NoProjectComposer` and the onboarding fallback copy are deleted, and the composer's dead no-project branch with its test. Proof: six mounted cases (form present, repository-only without a filesystem, created project reaches `onProjectCreated`, invalid checkout refused, Diagnostics only when supplied, create intent focuses the name); screenshots in both themes from a second stack with an empty data dir. Gates at `1040ae39c0`: `tsgo -b` clean; app vitest tasks + integrations + documents + workbench 60 files / 455 pass; ratchets at 1048 / 58 and 1091 / 58 (the two new modules, no new package edge). Not done: focus on the name field at mount, because the shell swaps its boot subtree a few ms after the canvas mounts and takes focus with it; the create-intent focus is covered instead.

## Presets into Settings, and the pane grip (2026-09-13)

Three asks from the user: move adding a preset to Settings, take the
Tasks/Presets switch out of the Tasks UI, and stop the Marketplace and Tasks
panes from being draggable.

| Commit | What changed | Proof |
|---|---|---|
| `feat(settings): keep presets in Settings, contributed by the Tasks build` | `SettingsContribution` gains `label`, `icon` and `renderer`; `app/integrations/settings-sections.ts` holds their registry and `DialogSettings` renders them under the group each `section` names. Tasks registers `Presets` from `tasks-contributions.ts` alone. `PresetsView` owns its own selection (no route props, no `TasksHeader` switch), `PresetDraftEditor` loses `onSaved`/`onClose` because closing the draft is what returns the list, and every path that created a preset inline — the row menu, the Start dialog — opens Settings through one opener, `features/settings/open-settings.tsx`, which replaces the providers-only one | mounted tests for the contributed tab (its value is the contribution id, and a gate hides it), registry tests for the gate and the id upsert, the build-selection guard extended to the settings registration; live: a row's menu and the Start dialog both land on Settings › Presets, both themes |
| `refactor(tasks): drop the presets pages from the Tasks route` | `TasksPage` is the task page alone: `/tasks/presets` is no longer minted, parsed, restored or mirrored, and the surface has one nested page | route, surface-route and persistence tests; the preset-mirroring test deleted — the task-page test already covers list-vs-page and page-vs-other-page |
| `feat(workbench): let a whole-page surface decline its pane's drag grip` | `ContentSurfaceContribution.draggablePane`, default true, false on the Tasks and Marketplace contributions; the workbench renders no grip for such a pane rather than an inert one, and the close control is untouched | `contentSurfacePaneDraggable` over the real contributions; a workbench test that a declining pane has no grip while a session pane still starts a drag; live: Tasks and Marketplace panes have no grip, a session pane does, and a Tasks pane split beside a session keeps its close |

The store bug found on the way: `<PresetsView store={createTasksStore()} …>`
minted a fresh store on every read, because Solid wraps a call expression in a
prop getter — the editor never opened. Bound to a const in `PresetsSettings`
and in the two tests that passed one inline.

Gates at `346cd8a60b`: `tsgo -b` clean; app vitest for tasks, integrations,
workbench, dialogs and identity 457 pass, 1 pre-existing fail
(`provider-connect-form.vitest.tsx`, last touched at the branch base
`85f1d007c8` and fully mocked away from this change); app bun tests 944 pass;
kit typecheck clean and 194 pass; `lint:theme-tokens` at its two pre-existing
failures; root lint at its three pre-existing perf-harness errors; ratchets
hold with both renderer ceilings raised by the three measured modules — the
settings-section registry and the two Presets owners — to app-local 1051 / 58
and desktop renderer 1094 / 58.

## Build-time selection removed (2026-09-13)

Tasks is built into the app, the desktop renderer, the desktop-bundled server,
the self-hosted binary and the hosted Worker, and `0024_claxedo_tasks.sql` /
`20260912100000_claxedo_tasks` are staged with every other migration. The kit
stays embeddable through route contributions and the app's contributions
module, which is what the owner asked for; selecting the feature in or out of a
build was not.

Removed: `CLAXEDO_BUILD_TASKS` and every reader, the
`__CLAXEDO_TASKS_ENABLED__` define and its ambient declarations, the Worker
`[define]` and the `migrations_dir` staging predicate, the self-hosted start
gate, the desktop renderer and server-bundle defines, the feature-off resume
test, and the guard tests that measured the disabled artifact. The app keeps
the dynamic import of `app/integrations/tasks-contributions.ts` for the chunk
boundary alone, so `features/tasks/**` still stays out of the chunks the shell
needs before first paint.

The "Build-time feature selection (T01)" section above, and the selection note
in the source line at the top of this file, are the record of a behaviour that
no longer exists.

## The Tasks UI moves into the app and is rebuilt on the host's primitives (2026-09-13)

The user's verdict on the surface: too many horizontal lines, no separation
between the page heading and the table, Start / the caret / the three-dots
barely readable as controls, a text caret rather than an icon, menus and
popovers that are not the ones the rest of the app uses, a poor board card
surface, a bad grouping of status + caret + a separate more-menu, and a round
number tag in the status card header. The reference was Linear's issue list,
board, issue page and its filter/display popovers.

The ownership question was settled by the user: "UI lives in task package —
that is anti pattern, ui should live in some folder in app. idea was just
embeddable." So `@opencode-ai/ui` was never added to the kit.

| Commit | What changed |
|---|---|
| `refactor(tasks): move the Tasks UI out of the kit into the app` | every Solid component, `tasks.css` and the view-model move from `packages/claxedo-tasks/src/solid/**` to `packages/claxedo-app/src/features/tasks/**`, filed by surface (`ui/{shared,list,board,detail,presets,start,dialogs}`) with each mounted test beside its subject. The kit's `./solid` subpath and its `solid-js` dependency are deleted, so it is domain + http + client + conformance and its own tests carry no Solid. `StartTaskDialog` → `StartTaskForm` and `TaskCreateDialog` → `TaskCreateForm`, because the move put them next to the containers that render them. The `ProseEditor` port folds into `features/tasks/app-ports.ts`, which is what declares it — it still crosses a real boundary, since a feature may not import the Documents editor. |
| `feat(tasks): rebuild every Tasks surface on the host's own primitives` | every menu, popover, select, button, icon button, tag, switch and checkbox is now a `@opencode-ai/ui` component; `tasks.css` keeps layout, table and board geometry and the accents that have no primitive |

Per screen, at the second commit:

- **List.** Page header = title + plain muted count + New task over the one
  hairline on the screen; the toolbar under it has none, so the first sticky
  group header is where the table starts. A group header is the status glyph,
  its name and a plain count on a tinted band with no rule. Rows are 36px with
  no borders, a hover surface, a selected accent, a strong title, a muted
  parent, and properties right-aligned in muted tabular text.
- **Row actions.** One group at the row's right, revealed on hover, on
  focus-within and while its own menu is open (an open menu portals focus out
  of the row, so neither hover nor focus-within survives the press that opened
  it). Start/Open is a `Button` and its caret an `IconButton` with the host
  chevron, sharing one border with a hairline seam; the three-dots is an
  `IconButton`. Both open `DropdownMenu`s.
- **Status.** `circle-dashed`, `circle-half`, `circle-alert`, `circle-check`
  from the host icon set, coloured from tokens. In a menu the four are a
  `RadioGroup`, so the tick is the record and a refused change snaps back; where
  the surface does not already say the status, the chip is the trigger.
- **Filter and Display.** `Popover`s of labelled rows: `Select` for project,
  status and grouping, `Switch` for subtasks, a segmented List/Board pair, and
  the active filters as `Tag`s with a remove.
- **Board.** Flat columns with no fill and no border; header = glyph, name,
  plain count and a plus that appears on hover; cards on `surface-raised-strong`
  with a hairline and a small shadow; the dashed drop target exists only while a
  card is being dragged.
- **Task page.** Properties is a rail of icon-and-label rows (Status, Project,
  Preset, Workspace), sessions are hairline-separated rows rather than cards,
  Archive is a quiet destructive link, "Add a subtask" is a link row with a plus.
- **Dialogs and presets.** `Select` for preset, configuration and project;
  `TextField` for the handoff text and the preset name; `Checkbox` for Continue
  and each capability; "Where this will run" as label-and-value rows between two
  hairlines. The placement radios stay native: the host's `RadioGroup` is a
  segmented control with no per-option `disabled`, and a placement this server
  cannot run must not be selectable.

Two asks in the brief were not built, because neither had anything behind it:
a search field in the Filter popover (the store filters on project and status
alone, and a search over two rows is decoration), and a "…" on a board column
header (there is no column-level command; `task.create` takes no status, which
is also why the plus is on To do alone).

Tests: the board, start-flow, start-form, create-form, preset-editor,
conflicts, pagination, refused-read and row-action suites now drive the host
components through one double in
`features/tasks/ui/shared/test-support/host-controls.tsx`. Kobalte's menu and
select are portal- and pointer-driven and jsdom cannot open them — the
established substitution in this package — and the doubles keep what the
assertions read: a real disabled-able trigger carrying the caller's test id and
label, items with their roles and disabled state, and a radio group that
reports which value is checked. `fireEvent.change` on a native select became a
press on the menu row or the listbox option; `getByLabelText(...).tagName ===
"SELECT"` became the same element's `role === "radiogroup"`.

Gates at `3e5d7309f3`: app vitest for tasks, tasks integrations and settings 16
files / 99 pass; `bun test ./src/architecture` 252 pass across 39 files (seven
fewer than the previous round only because the `ungate-tasks` lane deleted
`tasks-build-selection.guard.test.ts` in its own commits); `npx tsgo -b` clean;
`lint:theme-tokens` at its two pre-existing failures; kit `bun test src` 188
pass and its typecheck clean; root `test:architecture-ratchets` holds, with the
two renderer ceilings raised by the eighteen modules the walker could not see
while they were a package edge and then lowered by the two this round deletes
(the hand-rolled menu panel and the kit's own glyph) — app-local 1067 / 58 and
desktop renderer 1110 / 58; root `bun run lint` at its three pre-existing
perf-harness errors.

Screenshots, light and dark at 1440×900, against the running stack:
`ui-shots/v9-{list,list-row-menu,filter-popover,display-popover,board,task-page,new-task-dialog,start-dialog,settings-presets,preset-editor}-{light,dark}.png`.

## Task numbers, Backlog, and the popover fix (2026-09-14)

The user asked for the row properties Linear shows (a short id, the status mark, a date) and chose a real Backlog status over a filter that only meant "To do". Landed as `feat(tasks): give every task a number of its own inside its project` (`Task.number` minted by the store one past the project's highest, archived rows counted, inside the serialized unit; unique `(scope, project, number)` in SQLite and D1, both unreleased migrations edited in place; D1 has no interactive transaction, so a raced create is refused by the index and surfaced as the new `number-taken` conflict), `feat(tasks): make Backlog a status a task can be parked in` (`TASK_STATUSES` gains `backlog` first; `task.create` takes an optional `backlog | todo`; no DDL constrained the status), `feat(tasks): put the key, the parked column and a date choice on the surface` (key `KEY-n` derived from the project name at render, status mark leading every row and card, Backlog column first, Display gains Date: Updated | Created), and `fix(app): let a select opened inside a dialog paint above it`. Earlier the same day: `fix(ui): keep a popover open while a layer it opened holds focus` (the host popover's own window listeners closed it on the first focus into a portaled select list; the adoption rule lives in `popover-dismissal.ts` with six tests and was proven live by mouse, by keyboard and through a pick) and `feat(tasks): draw the status glyphs in one icon colour`. The project column stays out: the list read requires a project and no any-project read exists. Live proof on a second stack with fresh dirs: numbers 1–7 contiguous, `status: "backlog"` accepted at create, `"doing"` at create refused 400, a task created into Backlog through the dialog's select. The user's stack was migrated in place (`alter table … add column number`, backfilled by creation order, unique index created; `claxedo.db.before-number` kept beside it) and restarted. Gates at the tip: kit 197, server-core tasks-host 29, claxedo-server `src/tasks` 72, local-server tasks 26, app 146 across tasks + integrations + settings + documents, architecture guards 252, `tsgo -b` clean, ratchets unchanged, theme-token and root lint at their pre-existing counts.

## Four surface cuts from the owner's screenshots (2026-09-13)

The owner read the list, the task page and the Start dialog off the running
stack and asked for four things: the row's checklist and bubble glyphs are
overkill; the task number breaks the title's left edge when the breadcrumb
already carries it; the Properties rail says every name twice; and Start should
be a press and a preset, not a dialog.

| Commit | What changed |
|---|---|
| `feat(tasks): say a row's subtasks and session without glyphs` | the subtask fraction stands alone as muted tabular text (the count is also its `title`), and the session mark is the rail's own `.tsk-dot`. A list read carries `links.count` and no liveness, so the row's dot has no `data-liveness` and stays a ring; the rail's fills green only where the host reports the session live. `.tsk-dot` gained that ring, so a slot with no session reads as an outline rather than a grey disc. Board cards took both changes, and gained the session dot they never had. |
| `feat(tasks): let a task page's title start at the left edge` | the key leaves the title row; the last crumb keeps `DP-4 another sub issue` and carries `data-testid="task-detail-key"`. `.tsk-title-row` and `.tsk-title-key` are gone. |
| `feat(tasks): make each property in the rail the value itself` | the rail is rows of values: the `StatusControl` is the status row (`aria-label="Status"`), and project, preset and workspace are a glyph and a name in a `role="group"` carrying their own label. No `<dl>`, no label column, `PROPERTIES` still the eyebrow. The "Status is manual: To do until you change it." line is deleted — nothing in the product sets a status, so it was a fact about the product written on every task. |
| `feat(tasks): start a task from the page the way a row does, and drop the dialog` | below. |

### Start, without the dialog

The Start dialog is deleted — `start-task-dialog.tsx`, `start-task-flow.tsx`,
`start-task-form.tsx` and the two suites that drove them — and the task page's
per-slot Start, Start again and the dialog they opened are one
`TaskStartControl`, the same split control a list row and a board card carry.
Start runs the default preset through `startNow`, which reads the task and
takes the attempt `slotAttempt` yields, so a gone slot starts its next attempt
without the page deciding a number. The caret lists the presets that configure
that slot.

The dialog's two extras were decided rather than carried over:

- **Handoff text is gone.** The task's own text is what a session is handed;
  a note only the starter could see was a second place to say it, and the
  route still takes `handoffText: null`.
- **Continue from previous** is a menu item on a slot whose session is gone,
  starting the next attempt under the preset that attempt ran, with
  `continueFromPrevious: true`. A deleted session is not offered, because the
  service refuses to continue from one. A continue whose preview comes back
  with `previousTranscriptReadable: false` is refused in `startNow` rather
  than sent: the service would drop the transcript and start a fresh session,
  which is not what continuing means.

`useTaskStartOffers` in `data/start-task.ts` is now the one owner of what a
Start may offer — the default preset, the busy task, the store's refusals, the
preset catalog and its own failures — for the list, the board and the page.
`TasksView` lost its copy. Two things the dialog owned and the row never had
moved into the caret menu with it: a refused preset read shows the refusal and
its retry instead of "you have none yet" (an unread catalog is not an empty
one), and an incomplete preset list keeps its Load more.

Gates at the tip: app vitest for `src/features/tasks` and
`src/app/integrations/tasks` 15 files / 107 pass (two files fewer, five tests
more); `bun test ./src/architecture` 252 pass across 39 files; `npx tsgo -b`
clean; `lint:theme-tokens` at its two pre-existing failures; root
`test:architecture-ratchets` holds with both renderer ceilings lowered by the
three deleted modules to app-local 1064 / 58 and desktop renderer 1107 / 58;
root `bun run lint` at its three pre-existing perf-harness errors.

Screenshots, light and dark at 1440×900 against the running stack:
`ui-shots/v12-{list,task-page,task-page-live,task-page-start-menu}-{light,dark}.png`.

## Code-quality review of the whole branch, and its fix round (2026-09-14)

Four read-only Opus review lanes read the range `85f1d007c8..44bae06645` against one rubric (the user's: highest quality, maintainable, readable, scalable, reusable, extensible; no duplicate, dead or parallel implementation; no bad comments) split by ownership: kit 25 findings, servers 24, runtimes 17, app and ui 29. The reports are in the session scratchpad under `review/`. The top claims of each were verified by hand before any fix (two raw NUL bytes in the presets model, the slot decoder twice, the `instructions` capability nothing read, a lost number race answering 500 on SQLite and 409 on D1, the instruction block delivered four ways across the harnesses, the Presets settings chunk with no path to its stylesheet, the app-ports stub declaring seven of ten ports). Four fix lanes with disjoint package ownership then applied them: kit 25/25 fixed; servers 24/24 plus three runtime items delegated to it; runtimes 17/17; app 26 fixed, two split with the rejected half argued from the code, one partly refuted (principal isolation already clears the query cache, so the catalog key was a consistency defect rather than a leak). Substantive facts surfaced by the fixes rather than the reviews: Pi loses a spawn-time system prompt when an idle session is reaped and respawned, so the per-turn delivery is the one that works; the SQLite tasks store was a false factory over module singletons; the D1 number-race probe counted the inserting task as its own holder; two Settings ports and one fixture field were missing and invisible because test support sits outside the typecheck. New owners created: `tasks-host/{contribution,store-conflicts,session-reservation,session-bridge-conformance}.ts`, `workspace/http/session-create-request.ts`, `helpers/crypto` (`sha256Hex`), `@claxedo/agent-runtime-contract` now holding the effort vocabulary, verdict and session-group parser, `@claxedo/tasks/test-support` published, `app/integrations/settings-sections.ts` rendering all three groups, and two app architecture guards (every lazily mounted Tasks entry reaches the stylesheet; every declared feature port has a stub thunk). Found by the final verification: the checked-in icon inventory lacked the `circle` glyph (regenerated) and the local bridge conformance fixture removed its temp root before the runtime shut down (deferred). Gates at the tip: kit 198; server-core tasks-host 31; claxedo-server tasks + deployments 397 pass with the two pre-existing failures; local-server tasks + architecture 33; app 490 across tasks, integrations, settings, workbench and documents, guards 256, `tsgo -b` clean; ui 75; runtime contract 64, adapter 53, mcp 143 with its three pre-existing failures (vitest is that package's runner; `bun test` reports four more that are its own hook timeouts); every package typecheck clean; ratchets at app-local 1063 / 58, desktop renderer 1106 / 58, self-hosted 117 / 39; theme-token lint two pre-existing; root lint three pre-existing. Commit trailers normalised across the range with the tree hash unchanged.

## Tasks from inside a session (2026-09-14)

Plan `docs/plans/2026-09-14-001-feat-tasks-mcp-tools.md`. Security ruling that shaped it: the runtime credential is an HS256 bearer the runtime mints for its own loopback MCP with the signing secret in the same process and a self-asserted user claim, so it never crosses to the control plane; account-reaching tools forward with a control-plane-minted Tasks capability (same key as the gateway token, scope user/org/project/workspace/session/operations) resolved to the WORKSPACE OWNER, never the token's user alone. Landed: capability mint/verify and root preparation (`tasks/capability.ts`, `tasks/root-capability.ts`, env handed to the cloud runtime host), the capability branch of the Tasks identity (`tasks-host/authorization.ts` `capabilityTasksAuthenticate`, owner from `resolveWorkspaceOwner`), the `tasks` grant on the MCP client (`TasksGrant { fetch, operations, projectId? }`), the tool group `task_list` / `task_get` / `task_create` / `task_start` with listing filtered by granted operation and every refusal as a sentence, `Task.createdFrom` across contract, three stores and the task page, the self-hosted node's mount supplying the grant in both postures (`tasks/session-grants.ts`, proven by `mcp/self-hosted-tasks-mcp.test.ts` with a negative case for the exact regression the first live run hit), and the kit as the one owner of the admissible attempt (`admissibleAttempt`). Corrected after the live run: `task_start` had double-gated on the cross-machine setting the minter already applies, refusing a local session; the grant is now the only gate, and a preset resolves by name as well as id. Live on the local stack, real Claude turns: a fresh session's agent called `mcp__claxedo__task_create` → `DP-5` in Backlog with `createdFrom` naming the session and an `mcp.audit` line with `callerSessionId`; the task page shows "Created from session"; then `mcp__claxedo__task_start` with preset "Alt voice" → link `primary / attempt 1 / live / sent` to `ses_tasks_225e…`, audited with the started session id. Two earlier runs failed for reasons recorded here: a long-lived harness keeps the tool list it fetched at launch (a fresh session sees new tools), and the self-hosted node's mount had no grant. Not proven live: a real cloud root (sandbox credentials), and `start` on hosted, which stays ungranted until a composition supplies the cross-machine setting reader. Gates at the tip: kit 204, server-core 32, claxedo-server tasks + hosts + gateway + deployments with the two pre-existing failures, local-server 33, mcp 171 with its three pre-existing, app 118 across tasks + integrations, every typecheck clean, ratchets green (self-hosted 118 / 39 after one named module), root lint three pre-existing.
