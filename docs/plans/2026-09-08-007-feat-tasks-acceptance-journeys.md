---
title: "Tasks — Acceptance Journeys and Live Verification"
type: verification
status: not-executed
date: 2026-09-08
implementation_plan: docs/plans/2026-09-08-006-feat-tasks-implementation-plan.md
---

# Tasks — Acceptance Journeys and Live Verification

**Direction updated 2026-09-09:** [One agent, scoped context and memory](2026-09-09-001-claxedo-single-agent-context-memory-direction.md) is authoritative. This document covers the Tasks foundation for @claxedo; it does not specify the complete cross-surface learning system.

## 1. What this document proves

This is the acceptance contract for the [implementation plan](2026-09-08-006-feat-tasks-implementation-plan.md). Every journey is currently **NOT RUN**. It covers the scoped Tasks product, not the future Company product. This Tasks foundation is complete only when the applicable automated, durable-state, visual and live computer-use evidence is recorded. The overall single-agent product additionally requires a scoped context/memory design and its learning, correction, deletion and cross-surface acceptance journeys; J01–J42 do not claim that coverage.

The canonical UI direction is [HLD section 4.6](2026-09-08-004-feat-tasks-high-level-design.md#46-ui-direction-from-the-supplied-references) and [LLD section 10](2026-09-08-005-feat-tasks-low-level-design.md#10-solid-ui-and-caches). The user's five Circle screenshots are visual references, not evidence of a Claxedo implementation. Temporary screenshot attachment paths must not be a prerequisite for executing this document.

## 2. Distinct verification layers

Follow [app E2E invariants](../../packages/claxedo-app/e2e/INVARIANTS.md), [contributing guidance](../../packages/claxedo-app/CONTRIBUTING.md), and [Playwright configuration](../../packages/claxedo-app/playwright.config.ts). Keep these layers separate in reports:

| Layer | What it exercises | Permitted simulation | Required proof |
|---|---|---|---|
| D: domain/contract | Real package rules, SQL commits, host auth and runtime producers | Controlled ports for pure algorithms; real SQLite and Miniflare D1 for adapter claims | Exact DTO/state/error predicates; rollback, races and authoritative records |
| M: Tier M browser | Actual Solid feature UI through the mock runtime harness | Existing `installMockRuntime` and bounded transport fixtures | Visible user flow, pending/error states, geometry and focus; cannot prove real persistence/dispatch |
| R: Tier R browser | Real app, host, database, workspace/runtime and real harness executable | Scripted model endpoint/provider setup only, per existing invariants | Actual API/DB/runtime effects and visible completion; no `page.route()` |
| L: Tier L browser | Real app/host/model/harness with actual credentials | No model, tool, auth or runtime mocks | Real session/tool behavior through selected public entrypoint |
| CU: live computer use | The actual built/running product operated from screenshots | Test workspaces/accounts and controlled external outages; no mocked app behavior | Screenshot observation → visual input → screenshot result; separate evidence from Playwright |
| A: artifact/deployment | Emitted product bundles, packaged resources and selected deployment | Isolated builds/staging and dedicated acceptance deployment | Inventories/manifests, resource absence/presence, deployed identity and actual flow |

Tier M core journeys run in both existing `test-user` and `local-unsigned` modes. Signed fixtures explicitly establish test auth. Tier R must not replace app responses, tool results or canonical runtime events with browser interceptions. Faults that require deterministic timing belong in producer/adapter tests or a server-side test harness around the real boundary. Missing binaries, credentials or deployment access are **GATING**, never silently skipped or replaced with another harness.

Assistant visibility assertions reuse [turn-oracle.ts](../../packages/claxedo-app/e2e/helpers/turn-oracle.ts), including `expectAssistantReplyVisible`. Geometry and screenshot evidence reuse [geometry-oracle.ts](../../packages/claxedo-app/e2e/helpers/geometry-oracle.ts) and [visual-evidence.ts](../../packages/claxedo-app/e2e/helpers/visual-evidence.ts). A matching string in an invisible DOM, a 200 response, a task-side status flag, or a screenshot nobody inspected is insufficient.

### Live computer-use protocol

1. Record the build SHA, Tasks selection, environment, public app URL or packaged desktop path, auth mode, account/scope, project/workspace and harness/model/version. Open the actual product through that entrypoint.
2. Capture the screen and inspect it. Use a computer-use tool that sends pointer/keyboard input based on the observed screenshot. Operate the visible controls: no JavaScript `.click()`, hidden state mutation, locator-driven navigation or API calls in place of the journey's UI actions. Browser/Playwright tools may supply screenshots and coordinate input when those actions are genuinely chosen visually; ordinary selector-driven E2E is still Tier M/R/L.
3. Before each material action, confirm the current visible state. Capture important results: created task, accepted plan/children, run link, rendered session reply, permission/question wait, conflict and recovery. Record the action and screenshot reference. Use normal keyboard navigation for the keyboard journeys.
4. Read-only API/DB/runtime inspection may corroborate persistence, identity and counts after the UI action. Label it supporting evidence; it does not replace the visible action. Deterministic fault setup occurs outside the app and is documented separately.
5. Inspect each screenshot/video for clipping, overlays, wrong scope/target, unreadable state, missing response and lost focus. Record `visual_verified` separately from automated pass and from `computer_use_verified`.
6. For a failed journey, record the exact mismatch, fix its authoritative owner, rerun its focused automated coverage, and repeat the same live journey. Broaden reruns only for the changed behavior's affected journeys.

If the active tool environment lacks screenshot-driven input, record that specific blocker and owner. Do not use a screen-history reader or voice-only capture tool as a substitute. Do not claim that attaching a Playwright screenshot satisfies computer use.

## 3. Environment and fixture matrix

| Environment | Minimum required coverage | Additional condition |
|---|---|---|
| Local web, unsigned host + SQLite | All catalog/configuration/subtask/planning UI journeys; all execution/recovery journeys on supported local harnesses | Restart actual host; read back same catalog |
| Signed self-hosted Node | Catalog CRUD, project/actor isolation, replay after revocation, start/continue/session navigation, planning tool authorization | Use real signed route and current host policy |
| Packaged desktop, local unsigned | Create → start → session tool result → reopen task; host execution settings, narrow pane, permission/question flow, off/on restore | Actual packaged `file://` renderer and embedded server/runtime, not web dev server |
| Signed desktop accessing hosted work | Correct authority/project/workspace, start/continue, disconnect/reconnect, session navigation and account switch | Existing signed desktop/relay harness and actual signed product path |
| Hosted Worker + Miniflare D1 | Full store conformance, auth/public API, stopped-workspace catalog reads, migrations, payload bounds and conflicts | Real D1 binding through Worker composition; not a memory store |
| Deployed Claxedo-hosted Worker | Create → plan → accept children → start one → real session/tool result → reload; stopped workspace, authority denial and reconnect | Selected full-hosted artifact, real D1/auth/provisioning/relay/runtime |
| Feature excluded artifacts | Local renderer/server, packaged desktop, selected Node and Worker artifacts | Clean off, clean on positive control, on→off staging reuse, off→on data preservation |

For each host-advertised launch harness, record native/ACP identity, binary/version, supported model/instructions path and qualification status. Exercise start, continue, configured instructions, outcome and admission recovery in Tier R for each supported implementation. The release harness list must explicitly account for native Claude, Codex, Pi, OpenCode and available ACP choices; source enumeration alone does not prove availability. At least one real model-backed tool turn per advertised harness is required in Tier L. Use CU for each materially different harness selection, permission/question and recovery interaction; shared catalog interactions need not be repeated once per model.

The deployed and desktop journeys above are required in addition to local web coverage. A host-specific capability may truthfully report unsupported cancellation/configuration. An unqualified host or harness must not advertise a launch capability whose invariants have not been proved. Capability restrictions do not turn an intended supported release matrix cell into a pass; record it as incomplete until supported or explicitly rescoped.

### Deterministic test data

Use dedicated local data directories and test accounts/projects, never a user's existing work. Fixtures include two organizations/installations where applicable, two users with different project rights, two projects in one authorized scope, multiple workspaces for one project, a stopped hosted workspace, and native/ACP execution settings with supported and unavailable choices. Give entities recognizable unique titles so the visible target is unambiguous.

Use more than one page of tasks in at least two statuses, duplicate titles to exercise stable ID ordering, one empty status, parent/children with mixed states, long Unicode descriptions/plans, archived tasks, and activity longer than one page. Preparation may use service fixtures or test APIs; the behavior being claimed must be exercised through its stated entrypoint. Agent completion examples should create/modify a harmless file in an isolated test repository and verify the resulting content, rather than count a generic greeting as successful coding work.

## 4. Journey catalog

**Automation references below are proposed test files**, relative to `packages/claxedo-app/e2e/playwright/`, unless D/A is stated. IDs are stable acceptance requirements. Each test may parameterize several journeys without copying fixture infrastructure. "CU required" means the normal user-visible path and practical failure/recovery must be repeated live; precise internal races additionally require automated fault evidence.

### J01 — Build selection removes the feature

- **Setup/action:** produce clean off and on artifacts, then reuse the on staging directory for an off build. Launch the off app and inspect emitted renderer/server/desktop/Worker resources.
- **Expected:** no Tasks surface, commands, routes, tool group, migrations, exclusive CSS/assets or package implementation. Existing chat/session functions work. On artifacts contain the positive-control feature resources.
- **Proof:** A inventories and closure/source-map/resource analysis; D selection tests; `core-tasks-availability.spec.ts`. CU required for off app launch and ordinary session regression; artifact absence is proved by A.

### J02 — Renderer/server availability mismatch

- **Action:** open an enabled renderer against a server with Tasks absent, and against an incompatible Tasks protocol. Retry availability after switching to a matching server.
- **Expected:** intentional unavailable state, no writable stale detail/actions, no mutation requests; matching host becomes usable without adopting old-scope data.
- **Proof:** M availability spec plus D host contract; CU required with actual mismatched artifacts.

### J03 — Acceptance lanes run the intended artifact

- **Action:** discover core/real/live/desktop Tasks specs; attempt to reuse a build with the wrong feature/auth identity.
- **Expected:** required specs appear in explicit lanes; mismatch fails before journeys. An empty Tasks selection is not reported green.
- **Proof:** D discovery/build-manifest consumer tests and A CI job evidence. CU not applicable; verify the same manifest in live evidence.

### J04 — Enter an empty Tasks surface and navigate

- **Action:** open Tasks from Claxedo navigation with an empty authorized catalog, open create, cancel, navigate away and back; open a direct task link after a task exists.
- **Expected:** one host sidebar, useful empty state, correct scope, first view All tasks/Board, no unrelated company controls; deep link opens detail and Back reaches collection.
- **Proof:** M `core-tasks-catalog.spec.ts`, R `real-tasks-catalog.spec.ts`; CU required in web and desktop.

### J05 — Create and persist a small task

- **Action:** enter title/description/criteria, select a project, save directly, reload and restart host; repeat from Doing and Needs you groups.
- **Expected:** task/project/initial status persist, creation activity appears once, no session/run starts. Missing project/blank or oversized title gives inline validation. Done-group creation starts To do with explanation.
- **Proof:** D real store/HTTP; M/R catalog specs; CU required, including actual host restart readback.

### J06 — Preserve a draft and recover an unknown save outcome

- **Action:** enter text, trigger validation/server failure, close with a dirty draft, use Create more; lose a successful response and retry without changing the request identity; double-click Save.
- **Expected:** draft survives failure, discard is explicit, focus restores correctly; Create more resets task text only after confirmed save; one task/activity/receipt despite retries.
- **Proof:** D duplicate receipt and M dialog tests; R lost-response test at server boundary; CU required for draft/error/Create more and visible retry behavior.

### J07 — Edit without overwriting another user's changes

- **Action:** open same task in two clients; change description in one and submit stale title/criteria edit in the other, then resolve using current versions.
- **Expected:** conflict preserves the second user's draft and shows current values; no partial writes or silent last-writer-wins; successful retry has a new request ID and one activity entry.
- **Proof:** D both-store conformance, M/R catalog specs; CU required with two real clients.

### J08 — List/board parity and accurate pages

- **Action:** switch presets, project filters, List/Board and sort order across a multi-page dataset; load another page in two groups; toggle children and empty groups.
- **Expected:** identical authorized task set/counts, separate status cursors, stable duplicate-title ordering, no lost/duplicate cards, no falsely empty column from global pagination. Filter change resets incompatible pages.
- **Proof:** D query/HTTP predicates, M/R catalog specs; CU required with populated real catalog.

### J09 — Display preferences and return position

- **Action:** set view/metadata/sort preferences, open a card/child, return, reload, then change account/authority.
- **Expected:** selection, scroll/focus and own-scope preferences restore; another account does not inherit private filter IDs or records. Only supported metadata controls appear.
- **Proof:** M catalog/integration tests, R public flow; CU required.

### J10 — Change status with pointer and keyboard

- **Action:** drag To do → Doing, perform equivalent status menu change by keyboard, attempt Done with unchecked criteria; induce a conflict while a drag is pending.
- **Expected:** one canonical status command, pending state then confirmed result or rollback with reason. Failed Done does not bypass criteria. No rank changes or implicit agent launch.
- **Proof:** D status rules, M catalog interaction tests, R mutation persistence; CU required including keyboard path.

### J11 — Archive and restore a task

- **Action:** archive an eligible task; find it using the archive filter, open history and restore. Attempt archive with unresolved run or nonarchived children.
- **Expected:** normal presets exclude archive; history/identity retained; blocked archive explains prerequisite; restore validates parent/project access.
- **Proof:** D store/HTTP and M/R catalog/subtask specs; CU required.

### J12 — Comments, attribution and activity pagination

- **Action:** add a comment, retry a lost response, load older activity while another client adds entries; execute a mutation whose commit fails.
- **Expected:** attributed comment once, stable ordered pages without duplicate entries, useful field-change records; no activity for failed commit and no token/tool transcript flood. Malicious Markdown renders inertly.
- **Proof:** D atomicity/sequence/security tests and M/R catalog specs; CU required for visible history, paging and attribution.

### J13 — Invoke @claxedo with the correct context and no profile setup

- **Action:** create tasks in two authorized projects, use Start and Plan with agent with existing host defaults; open the resulting sessions. Repeat with a supported advanced execution setting.
- **Expected:** no profile catalog, picker, assignment or creation step. Both sessions represent @claxedo; each receives its own authorized task/project context and target. One project's context cannot leak into the other. Saving a task starts nothing.
- **Proof:** D target/input assembly and host-default contracts, M `core-tasks-configuration.spec.ts`, R execution spec; CU required. This verifies current invocation context, not future learned-memory retrieval.

### J14 — Freeze accepted settings and report unavailable configuration

- **Action:** change host defaults after run acceptance; inspect the accepted input and resume the pending run. Attempt new work with unavailable model/harness/instruction support; choose a supported configuration.
- **Expected:** accepted run retains frozen settings; new start explains unavailable configuration before acceptance. No silently substituted model, dropped instruction or named preset entity. Invocation history remains readable under current access.
- **Proof:** D run/configuration/capability tests, M configuration spec, R producer tests; CU required.

### J15 — Resolve project and workspace explicitly

- **Action:** create a task in a project with multiple workspaces, start without a workspace, choose one; change project while old workspace is selected; attempt a foreign-project workspace ID via API.
- **Expected:** visible target choice; no globally active directory fallback; project change clears/revalidates incompatible workspace; API rejects forged mismatch. Failure leaves no accepted run.
- **Proof:** D host/HTTP tests, M configuration/execution specs, R execution spec; CU required.

### J16 — Refuse unauthorized or impossible preflight

- **Action:** start with project execution denied, stopped target that cannot provision, unavailable harness/model, or denied hosted entitlement; revoke project write authority during a concurrent edit.
- **Expected:** specific authorized error, no partially accepted start, no accidental provisioning bypass, conflict/forbidden result does not silently persist edits.
- **Proof:** D auth/capability tests and R relevant host entrypoints; M error rendering; CU required for real available denial conditions.

### J17 — Explicit Start with @claxedo

- **Action:** start a task using current host defaults, repeat with a supported execution override, then start another task directly. Open the linked session and request a harmless test-file change.
- **Expected:** one run and exact target session, Doing for execution, configured harness/model/instructions reach the actual invocation, real assistant/tool result visible and file content verified. No duplicate start from double-click.
- **Proof:** D adapter/producer tests; M `core-tasks-execution.spec.ts`; R `real-tasks-execution.spec.ts`; L `live-tasks-execution.spec.ts`; CU required per environment matrix.

### J18 — Agent settles but task still needs human completion

- **Action:** let the invocation finish, return to task, inspect outcome/history and criteria, mark Done after actual review; reopen.
- **Expected:** completed run is distinct from business status; no automatic criteria checks or Done. Explicit Done enforces current guards; reopening permits a subsequent explicit run.
- **Proof:** D run/completion tests, M/R execution specs, L/CU required.

### J19 — Continue, open existing session and inspect history

- **Action:** open linked session without sending; explicitly Continue from task; change host settings or target and attempt incompatible continuation; send an ordinary message directly in session.
- **Expected:** opening creates no run; Continue creates a new message/run in the same compatible session. Incompatible configuration is explained. Manual message is not a fabricated task run; latest invocation and current session activity are distinct.
- **Proof:** D history/config tests, M/R execution specs, L/CU required.

### J20 — Recover accepted intent before session creation

- **Action:** interrupt host after task intent commit but before create; reload task and Inspect, then choose Resume start.
- **Expected:** pending durable run survives, Inspect launches nothing; Resume reauthorizes and uses persisted IDs. One session eventually exists, not one per retry.
- **Proof:** D fault injection and R `real-tasks-recovery.spec.ts`; CU required with controlled real host interruption/recovery.

### J21 — Recover lost create/prompt response

- **Action:** drop response after real session creation and separately after prompt admission; reopen, Inspect and replay original command; explicitly resume only where needed.
- **Expected:** exact existing session/turn recovered; same request replay does not drive; no second message or tool dispatch due to Tasks retry. Hash mismatch is rejected.
- **Proof:** D producer/store receipts and dispatch counts; R recovery spec; CU required for pending/recovered UI, with documented transport fault setup.

### J22 — Runtime restart and unrelated busy session

- **Action:** restart after durable admission but before final reply; attempt a different invocation identity while another turn is busy; inspect both identities.
- **Expected:** unrelated busy state is not proof of this run's admission; ambiguous work stays unresolved; recovered outcome belongs to exact invocation. No success inferred from session status alone.
- **Proof:** D runtime producer tests and R recovery spec; CU required for restart behavior and truthful pending/unavailable display.

### J23 — Competing starts and late driver/observer writes

- **Action:** two clients start the same task; expire the winning driver's lease while its request is in flight; deliver repeated/out-of-order observations including an old outcome after a later run.
- **Expected:** one unresolved run constraint; loser sees existing run/conflict; old generation cannot overwrite checkpoints; repeated observation adds no duplicate activity and cannot clear a newer active run.
- **Proof:** D independent DB connections/Worker requests + producer fault evidence; R two-client recovery case. CU required for two-client start result; precise event scheduling is automated evidence.

### J24 — Permission and question round trips

- **Action:** real harness requests permission and asks a question; navigate away/reload, reopen the exact linked session, answer/deny via canonical controls.
- **Expected:** task run remains waiting/unresolved; session controls resume the correct invocation once, with no duplicate dialog or task-specific permission UI. Another session/user cannot answer it.
- **Proof:** R execution/recovery using existing permission/question helpers, L relevant supported harnesses; CU required in web and packaged desktop.

### J25 — Cancel or Stop with truthful evidence

- **Action:** race safe pre-admission Cancel with admission when supported; otherwise inspect visible cancellation-unavailable state. Stop an admitted invocation in the ordinary session, lose observation temporarily, reconnect.
- **Expected:** only confirmed producer fence yields cancelled-before-admission. Abort request alone does not clear ownership; confirmed outcome settles it. No fresh run allowed during ambiguity.
- **Proof:** D producer fence/outcome races, R recovery, L/CU required for supported real behavior; unsupported cancellation is explicitly recorded, not a false successful cancel.

### J26 — Real error, offline state and recovery

- **Action:** cause a real provider/tool failure, disconnect runtime/relay, reload task while unavailable, reconnect and inspect.
- **Expected:** last confirmed state/time preserved with Unavailable; task is not Done or spuriously Failed from transport loss. Definitive invocation failure displays reason and retains session history; fresh run requires resolved prior run.
- **Proof:** D outcome normalization, M/R recovery, L/CU required using controlled test environment failure.

### J27 — Create, attach, detach and navigate subtasks

- **Action:** create children manually, open parent/child breadcrumbs, attach/detach an existing eligible task, attempt grandchild/cycle/cross-project attachment and parent project change.
- **Expected:** one level, same project, copied initial workspace, durable activity; rejected mutations leave no partial relation. Detached task survives. Collection child toggle avoids accidental default duplication.
- **Proof:** D both-store rules, M `core-tasks-subtasks.spec.ts`, R `real-tasks-subtasks.spec.ts`; CU required.

### J28 — Parent progress and explicit completion

- **Action:** execute/complete children independently, review all-done parent, leave a parent criterion unchecked or parent run unresolved, attempt Done; satisfy guards and complete explicitly.
- **Expected:** accurate progress, no automatic parent completion; errors identify blockers. Archived children follow LLD nonarchived completion semantics, without bypassing archive constraints.
- **Proof:** D aggregate tests, M/R subtasks specs; CU required.

### J29 — Completion/archive races and reopening

- **Action:** race parent Done against child insert/reopen, then attempt adding/reopening child beneath Done parent; archive/restore child around parent state changes.
- **Expected:** at most a valid committed state; child-set read-set guard blocks invalid Done; reopen parent first. Archive/restore cannot manufacture dangling or inaccessible parent relations.
- **Proof:** D concurrent SQLite/D1 conformance, R two-client subtask case; CU required for observable conflicts/reopen workflow.

### J30 — Tenant/project isolation including counts and receipts

- **Action:** query/mutate another scope's task, plan, run, frozen section and command receipt using known IDs; try foreign/stale cursors and group counts; move project without both permissions.
- **Expected:** no unauthorized record, body, count, existence leak beyond host policy, or external execution. Actor/scope supplied in bodies cannot override verified identity.
- **Proof:** D exhaustive HTTP/SQL/MCP negative matrix and R signed public routes. CU required for denied deep links/visible collections with two accounts; API forgery proof is D/R.

### J31 — Access revocation after a valid mutation

- **Action:** revoke project/organization access after a command committed or run accepted; replay receipt, retrieve old snapshot and Resume start; keep an old tab open.
- **Expected:** current authority enforced on reads and future effects; previously admitted work follows runtime policy, never a promise of retroactive cancellation. No old receipt authorizes new work.
- **Proof:** D host/driver tests, R signed flow; CU required for denial and stale tab behavior.

### J32 — Account/scope switch and late responses

- **Action:** switch account/authority with detail/list requests pending; return late responses, refocus and remount surface; close Tasks while a real run continues.
- **Expected:** old response cannot populate new scope, private preferences/data cleared, one polling request per key, no polling when unmounted; closing surface does not abort session.
- **Proof:** M mounted integration/race tests and R signed flow; CU required for account switch and continuing session.

### J33 — Plan with agent and preserve a proposal

- **Action:** choose Plan with agent on a task, discuss a real feature, have agent save a plan through the task tool, reload task, open immutable revision and linked session.
- **Expected:** planning run/session linked, original business status unchanged; durable plan survives reload, source/actor visible, conversation remains canonical session. Actual permission policy is shown accurately.
- **Proof:** D tool/plan tests; M `core-tasks-planning.spec.ts`; R `real-tasks-planning.spec.ts`; L `live-tasks-planning.spec.ts`; CU required local and deployed hosted.

### J34 — Review and accept a breakdown atomically

- **Action:** select a subset of proposals and accept exact revision, retry a lost response, edit task/children before accepting another pending revision, then save a reviewed new revision and accept. Exercise empty proposal and maximum-size proposal.
- **Expected:** one acceptance and one stable set of selected child IDs; no child execution. Stale revision conflicts with preserved proposal. Prose-only revision adds no children; additional proposals explicitly visible. Any failure rolls back all children/activity/receipt.
- **Proof:** D SQLite/D1 maximum/race/rollback tests; M/R/L planning specs; CU required including stale-review recovery and selected subset.

### J35 — Exact bounded context and configuration

- **Action:** start with long Unicode task/plan/criteria; inspect actual admitted input and fetch continuation sections through task tools. Edit live task/host settings, fetch frozen section again, Continue an eligible run.
- **Expected:** declared prompt budget enforced without silent criteria loss, exact snapshot versions/bodies unchanged, current reads labeled current, resolved system settings present through supported harness path, no concatenation of all prior task prefixes or tool definitions.
- **Proof:** D budgets/hash/section authorization + R producer/model input capture at scripted endpoint; L real tool fetch and response; CU required for long-document UI and real agent retrieval outcome. Do not claim provider cache hit savings from deterministic input ordering.

### J36 — Packaged desktop end-to-end execution

- **Action:** launch actual packaged app, create a task, start a local task, observe real tool result, restart app, reopen task/session and Continue.
- **Expected:** file-origin security/auth works, data/session identities persist, canonical navigation opens correct target, no extra local service or terminal launch workaround.
- **Proof:** proposed `desktop-tasks-local.spec.ts` through existing Electron fixtures, L where available and CU required. Record packaged app/server/runtime hashes.

### J37 — Deployed hosted full journey

- **Action:** use real Claxedo-hosted account/project, create parent, plan, accept children, start one, provision/resolve workspace and inspect actual session/tool result, reload catalog.
- **Expected:** real D1 records independent of workspace filesystem, correct identity/entitlement/relay path, one task/run/session, no dev server or alternate local authority substituted.
- **Proof:** extend deployed Cloudflare acceptance and L planning/execution; CU required on deployed URL. Record certified artifact and deployed build identity.

### J38 — Hosted stopped workspace and relay interruption

- **Action:** stop workspace, read/edit task/comment/plan without starting execution; later explicitly start, interrupt relay and reconnect; repeat navigation from signed desktop.
- **Expected:** catalog remains usable without provisioning; only explicit execution acquires workspace; old target/run preserved and no duplicate launch after reconnect.
- **Proof:** Worker/D1 integration, R signed relay tests, deployed L and CU required.

### J39 — Disable/re-enable with persisted work

- **Action:** create records and an ordinary running session with Tasks on; restart into off artifact; inspect restored workbench and continue ordinary session; return to on artifact.
- **Expected:** excluded feature code/resources remain absent, generic restoration stays usable, catalog preserved, session not aborted by feature removal; re-enable performs read-only reconciliation and never automatic run replay.
- **Proof:** A off/on resource/migration tests, D driver tests, proposed `desktop-tasks-availability.spec.ts`, CU required.

### J40 — Migrations and deployment mismatch recovery

- **Action:** initialize empty catalog, upgrade a prior Tasks schema with preserved data, repeat migration; attempt incompatible server/schema and a failed migration in an isolated environment.
- **Expected:** migration runs through host deployment lifecycle, not requests; failure is explicit and no partially usable writer starts; repeat does not duplicate records; disabled artifact does not stage/run Tasks migrations. New incompatible formats require coordinated rollout, not silent fallback readers.
- **Proof:** D both-store migrations and A selected Node/Worker packaging/deploy dry run; CU required for visible availability/recovery using real artifacts.

### J41 — Agent authority and stale invocation rejection

- **Action:** from actual planning tool context read task/comment/propose; try accepting plan, completing task, starting sibling, editing host configuration, reading foreign snapshot, spoofing human actor and using old run ID after Continue.
- **Expected:** only authorized task reads/comments/proposals succeed; human-only actions unavailable and direct calls denied; active invocation binding cannot be supplied by the model. Baseline MCP inventory preserved, Tasks tools absent when excluded.
- **Proof:** D credential/registry/host tests plus R actual runtime credential route; L successful allowed tool round trip; CU required for visible proposal/attribution/refusal result where surfaced.

### J42 — Visual, accessibility and bounded rendering acceptance

- **Action:** use light/dark themes, wide and <900 px allocated panes, split workbench and narrow/touch viewport; navigate dialogs, menus, board/status actions and detail with keyboard; inspect large list/activity/plan content.
- **Expected:** title-first density matches references, properties collapse by pane width, no overlapping controls or second host horizontal scrollbar; visible focus and correct Escape/return focus; statuses named beyond color; long content bounded/paged and no hidden primary action.
- **Proof:** M accessibility/geometry and mounted Solid tests; R real data screenshots; CU required across themes and pane widths. Automated accessibility checks supplement actual keyboard and screen-reader semantic inspection.

## 5. Test ownership and coverage without duplicate frameworks

| Proposed owner/spec | Journeys | Existing mechanisms to extend |
|---|---|---|
| `core-tasks-availability.spec.ts` | J01–J03, J39–J40 UI states | mock runtime, auth matrix, capability fixture |
| `core-tasks-catalog.spec.ts`, `real-tasks-catalog.spec.ts` | J04–J12, J30–J32, J42 | common geometry/visual oracles; actual local host in R |
| `core-tasks-configuration.spec.ts` | J13–J16 | host defaults, context resolution and existing execution selectors via ports |
| `core-tasks-execution.spec.ts`, `real-tasks-execution.spec.ts` | J17–J19, J24–J26 | real-local-server, scripted-model-server, turn/permission/question oracles |
| `real-tasks-recovery.spec.ts` | J20–J26, J31–J32 | existing real harness restart/relay infrastructure; test-only controlled boundary faults |
| `core-tasks-subtasks.spec.ts`, `real-tasks-subtasks.spec.ts` | J27–J29 | same Tasks client/UI and both real stores |
| `core-tasks-planning.spec.ts`, `real-tasks-planning.spec.ts` | J33–J35, J41 | existing first-party MCP mounts and real runtime credentials |
| `live-tasks-execution.spec.ts`, `live-tasks-planning.spec.ts` | J17–J26, J33–J35, J37–J38, J41 | live harness setup with real credentials; no app/provider mocks |
| `desktop-tasks-local.spec.ts`, `desktop-tasks-availability.spec.ts` | J36, J39 | `electron-app.ts`, packaged app fixtures and file-origin path |
| Existing signed-desktop and deployed acceptance owners, with Tasks cases | J30–J32, J37–J38 | `real-desktop-signed-cloud.spec.ts`, `e2e/deployed-cloudflare-acceptance.ts` |
| `script/tasks-artifacts.test.ts`, existing closure/deploy owners | J01–J03, J39–J40 | normalized build manifests, product-boundary tooling, certified Worker artifacts |
| Package/host/runtime colocated tests | Every durable, authorization, race and context predicate above | finite service/adapter contracts and canonical runtime stores |

Use `@core` for core specs, `@tier-real` for real specs and `@live` for live specs according to the existing suite selector. Desktop tests also use existing surface tags. Introduce a `@tasks` selector only by updating `e2e/suites.ts`, discovery tests and script/CI selection together. Do not use file existence or tag strings alone as proof a test ran. Retries remain consistent with the current no-retry configuration; flakes require diagnosis.

No new universal E2E harness, assistant oracle or auth implementation is needed. Extend existing fixtures only at explicit seams and keep runtime fault controls test-only, absent from production artifacts. Actual test commands are recorded by execution in the evidence ledger, with exit status and relevant output, rather than treated as successful merely because they appear in a plan.

## 6. Evidence ledger and release decision

During implementation create one evidence directory per reviewed build under `docs/verification/tasks/<build-id>/`. Its `index.md` links automated results, build/resource inventories and live sessions. Store large screenshots/videos in the existing test artifact location or approved artifact storage; link stable accessible locations rather than transient temporary paths. Do not commit credentials or private task bodies.

Each entry contains:

| Field | Required value |
|---|---|
| Identity | Journey ID, scenario/negative branch, timestamp, reviewer |
| Artifact | Source SHA, dirty diff identifier if applicable, build/package/deployment ID, Tasks selection |
| Environment | Entry URL/app path, auth mode/scope, project/workspace, harness/model and binary/runtime versions |
| Setup | Fixture names and any controlled outage/fault; explicit mocks for M only |
| Automated execution | Exact command, result, test/report link; `NOT RUN` when absent |
| Visual evidence | Screenshot/video links, what was inspected, `visual_verified: true/false` |
| Computer use | Tool/driver used, screenshot-based action sequence, `computer_use_verified: true/false/not_applicable` |
| Durable evidence | Task/run/session/message/receipt identities and redacted supporting state/counts where required |
| Outcome | PASS / FAIL / GATING / NOT RUN, actual versus expected behavior |
| Follow-up | Defect, owner, next action and affected journeys; rerun evidence after fix |

Each of J01–J42 starts NOT RUN. Maintain a row for every required environment/harness variant, not one global checkbox that hides a missing hosted or desktop run. "Not applicable" needs a reason tied to the matrix or an explicitly unsupported capability; lack of time/environment is GATING.

Release requires all applicable rows passed, final artifacts inspected, visual evidence actually reviewed, and required CU journeys executed. A plan/document review is not an E2E result. Local SQLite success is not D1 proof. Miniflare success is not deployed hosted proof. Browser-dev success is not packaged desktop proof.
