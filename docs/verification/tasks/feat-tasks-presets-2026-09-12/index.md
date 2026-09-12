# Tasks and Presets — evidence index (local slice, 2026-09-12)

Source: branch `feat/tasks-presets` in worktree `~/test/opencode-tasks`, cut from dev `85f1d007c8`; evidence recorded at `a44662d5ef` plus the two orchestrator fixes `28cd279a9d` and `b8e08cbc0c`. Tasks selection: always-on in this build (no `CLAXEDO_BUILD_TASKS` artifact exclusion exists yet; see gaps).

Environment for the live rows: unsigned local stack started from the worktree. Server `npm run start` in `packages/claxedo-server` with `CLAXEDO_DATA_DIR`/`CLAXEDO_STATE_DIR` under the session scratchpad and `CLAXEDO_SERVER_PORT=2594`; app `bun run dev:local` in `packages/claxedo-app` with `PORT=4448 VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:2594`. Project registered with `POST /api/claxedo/projects` (`{ name, source: { kind: "directory", directory } }`) pointing at a scratch git repository. Scope `local`, owner `local`. Screenshots were inspected in the Claude Browser pane; pointer/keyboard input was screenshot-driven with element refs from the accessibility tree.

| Journey | Automated | Visual / live | Result | Notes |
|---|---|---|---|---|
| T01 | none | none | NOT RUN | No feature-off artifact exists; `CLAXEDO_BUILD_TASKS` is not implemented. |
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
| T24 | archive/authority tests | none | PARTIAL | Feature-off resume not testable without an off artifact. |

## Defects found only by the live run

- Picking a harness in the preset editor overflowed Solid's reactive graph: the slot editor called the host editor as a function inside JSX and the draft callback read the parent's signal inside a child effect. Fixed in `28cd279a9d` with `Dynamic` + `untrack`; regression test in `preset-editor.vitest.tsx` (both mutants fail).
- The bridge resolved a workspace only from the task's explicit preference, never from the project. Fixed in `a44662d5ef` (`projectTarget`, deterministic root/primary-checkout choice, refusal naming candidates when ambiguous).
- A refused status change left the native select showing the refused value. Fixed in `b8e08cbc0c`.

## Reds inherited from dev `85f1d007c8` (proven at the base commit)

claxedo-server: `deployment-closures` (Better Auth locked closure 16 > 15), `governance/codebase-shape` (`documents/routes/index.ts` missing), `session-env-document-roundtrip.integration` (Pi executable), `local-product-contract` allowlist (extra `/api/claxedo/agent-config/providers/custom` from `2e1d6ee407`). workspace-runtime: `generateNotifyScript > reports failed delivery…`. local-server: `control-plane Pi catalog > serves credential-owner authentication methods…`. Root lint: three errors in `claxedo-app/perf-harness/**` on this checkout.
