---
title: "Tasks and Presets — Technical Implementation Plan"
type: feat
status: scoped-plan-with-session-and-cloud-isolation-gates
created: 2026-09-08
updated: 2026-09-12
scope: presets-tasks-subtasks-and-linked-sessions
---

# Tasks and Presets — Technical Implementation Plan

## 1. Deliverable and boundaries

Implement two features in the existing optional library: personal reusable presets and project-owned tasks/subtasks. Start joins a task with a preset/configuration, creates an ordinary local or isolated cloud session, and retains its link. Presets include placement, primary/optional Planning/Implementation/Review model configurations, instructions and cloud skill/plugin selection.

Presets are a foundation for future named bots, not an implementation of identities, memory, credentials, inboxes, schedules or standing responsibilities. Do not restore Tasks planning documents/acceptance, activity/comments, a Run entity, execution observation or a workflow engine. Model groups are settings with explicit selection and qualified native delegation, not an automatic phase scheduler.

This revision replaces S1–S5 with S1–S8. Read [HLD](2026-09-08-004-feat-tasks-high-level-design.md), [LLD](2026-09-08-005-feat-tasks-low-level-design.md), [acceptance journeys](2026-09-08-007-feat-tasks-acceptance-journeys.md), and [goal.md](../../goal.md). New paths/contracts below are proposed, not existing capabilities.

## 2. Code grounding: existing owners and gaps

| Current owner | Observed seam and required change |
|---|---|
| [Connections service](../../packages/claxedo-connections/src/service.ts) | Reference for a host-supplied library; do not put task/preset domain into Connections |
| [Product contributions](../../packages/claxedo-app/src/app/composition/product-contributions.ts), [integration registry](../../packages/claxedo-app/src/app/integrations/registry.ts), [HTTP contribution](../../packages/claxedo-server-core/src/platform/http/route-contribution.ts) | Optional renderer and server mounting; add the two catalog surfaces through current composition |
| [Local app](../../packages/claxedo-local-server/src/app/local-app.ts), [local composition](../../packages/claxedo-local-server/src/app/start-local-server.ts), [hosted core app](../../packages/claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts), [Node app](../../packages/claxedo-server/src/deployments/self-hosted-node/app.ts) | Supply storage/auth/start bridge. Hosted metadata is independent of a live workspace |
| [Authority](../../packages/claxedo-server-core/src/platform/auth/authority.ts) | Keep project/session authorization; add personal preset ownership checks in feature service, not bot-role permissions |
| [Draft defaults](../../packages/claxedo-app/src/features/session/harness/draft-default-policy.ts) | `resolveDraftDefault` knows supported placement, saved-model unavailability and eligible providers/models. Reuse its authoritative inputs and current picker components; explicit preset choices must not silently fall back |
| [Submit target](../../packages/claxedo-app/src/features/session/composer/ui/submit-create-session.ts) | `acquireSubmitSessionTarget` / `finalizeSubmitSessionTarget` connect managed reservation, canonical creation and effective harness/model/variant. Extract/reuse host boundaries, never import UI submission into server code |
| [Session config normalizers](../../packages/workspace-runtime/src/session-config.ts), [SDK contracts](../../packages/agent-sdk-runtime/src/index.ts) | Existing create has `clientRequestId`; current config covers harness/model/variant/permission/handoff, not a resolved preset/capability manifest. Extend canonical storage/wire contracts for generic session settings, not task-specific runtime fields |
| [Private registration](../../packages/claxedo-server/src/routes/private-session-registration.ts) | Managed identity reservation. Qualify durable origin/config association and create/link replay; explicit IDs alone are not evidence of full recovery |
| [Workspace routes](../../packages/claxedo-server/src/workspace/routes/index.ts), [runtime preparation ports](../../packages/claxedo-server/src/workspace/route-support.ts) | Workspace creation reaches `sandboxManager.ensure`; runtime preparation/provision hooks exist. Add canonical origin-based isolated workspace allocation and readback, retain existing lifecycle/cleanup ownership |
| [Plugin activation projection](../../packages/claxedo-server/src/agent-plugins/runtime/provision.ts) | `desiredAgentPluginSelections` derives all effective selections from activation; provision coalesces by workspace. Add exact per-execution selection input without editing defaults, with selection-aware cache/receipt identity |
| [Runtime apply contract](../../packages/claxedo-server-core/src/agent-plugins/runtime/apply-contract.ts), [runtime contribution](../../packages/claxedo-local-server/src/agent-plugins/runtime/runtime-contribution.ts), [materializer](../../packages/claxedo-local-server/src/agent-plugins/runtime/materialize.ts) | Current payload uses project identity/revision and whole plugin artifacts; apply can reuse equal revision. Add explicit selected skills and selection identity through producer/consumer/receipts together; direct skill selection must not register its plugin tools |
| [Plugin catalog types](../../packages/claxedo-server-core/src/agent-plugins/catalog/types.ts), [skill read](../../packages/claxedo-server-core/src/agent-plugins/catalog/read-skill.ts) | Existing plugin-backed skills have source identity. Start with retained catalog-backed selections; broader skill-source support needs an explicit authoritative catalog contract, not arbitrary path input |
| [MCP preparation](../../packages/claxedo-server/src/agent-plugins/mcp/runtime-preparation.ts), [runtime token](../../packages/claxedo-server/src/agent-plugins/mcp/runtime-token.ts) | Brokered credentials are workspace/harness/plugin/integration scoped. Restrict preparation to the same execution manifest; prove gateway authorization/revocation and no credential expansion on resume |
| [OpenCode policy](../../packages/workspace-runtime/src/opencode/launch-policy.ts) | Skill/MCP projection is per workspace. Isolate roots; do not toggle a shared workspace between task presets |
| [Claude driver](../../packages/agent-sdk-runtime/src/harnesses/claude/driver.ts) | Reads system instructions and shared `currentPlugins`/MCP config. Verify dedicated-runtime launch and no native discovery of unselected plugins |
| [Codex driver](../../packages/agent-sdk-runtime/src/harnesses/codex/driver.ts) | Uses developer instructions and shared plugin launch, refuses plugin changes during active turns. Isolated runtime/home is required for independent selections |
| [Plugin harness registry](../../packages/claxedo-server-core/src/agent-plugins/runtime/harness-registry.ts) | Registered adapters are OpenCode/Claude/Codex/Cursor; this is not proof of selected-only behavior. Gate by verified capabilities, not name membership |
| [Subagent tools](../../packages/claxedo-mcp/src/tools/subagents.ts), [child routes](../../packages/workspace-runtime/src/routes/session-children.ts), [handoff transaction](../../packages/agent-sdk-runtime/src/runtime/handoff-transaction.ts) | Native delegation/handoff owners exist. `create_subagent` currently takes harness/model, no effort/configuration key, and explicitly copies no parent history. Extend this path for group selection/inheritance; no Tasks execution tools |
| [Renderer build](../../packages/claxedo-app/vite.cloud.config.ts), [local build](../../packages/claxedo-local-server/scripts/build.ts), [desktop bundle](../../packages/claxedo-desktop/scripts/bundle-claxedo-server.ts), [Worker artifacts](../../packages/claxedo-server/src/deployments/hosted-workerd/certified-worker-artifacts.ts), [boundary verifier](../../script/product-boundary/verify.ts) | Carry feature selection through actual emitted resources, manifests and launch lanes |

These are source observations, not runtime qualification. Canonical session instruction persistence, allocation idempotency and exact cloud capability isolation remain release gates. Cloud means an isolated sandbox/runtime behind the hosted control plane, not running arbitrary agent binaries inside a Worker.

## 3. Delivery sequence

### S1 — Optional package and independent domain boundaries

Create proposed `packages/claxedo-tasks` with separate preset and task modules, shared finite store/auth ports, HTTP/client and Solid subpaths. Preset contracts cannot depend on task IDs/lifecycle. Use current TypeScript/Solid/Hono stacks, local SQLite and hosted D1 only. No second package for presets and no runtime dependency on Tasks.

Wire `CLAXEDO_BUILD_TASKS` through existing product/route contributions and artifact selection. It enables both user-facing features. Off excludes catalogs, implementation, styles, routes, migrations and exclusive dependencies; generic session configuration remains readable without the feature. Use an enabled positive control and inspect on→off reused staging directories. Acceptance: T01, T16.

### S2 — Preset and task/subtask persistence, authority and API

Implement proposed `presets/{model,service}.ts`, `tasks/{model,service}.ts`, `contracts.ts`, `ports/`, `http/routes.ts`, `client/`, `schema/` and `conformance/store.ts`. Add host adapters under `claxedo-server-core/src/tasks-host/` and hosted `claxedo-server/src/tasks/d1-store.ts`, composed through current local/Node/Worker owners.

Persist personal presets, project-owned tasks, slot-unique TaskSessionLinks and plain command receipts. There is no Run, plan, activity or bot table. Add finite commands, expected revisions, payload bounds and atomic parent/link guards. Preset references are provenance; a session must survive preset archival without loading private preset content through task APIs. Migrations use host lifecycle and are staged only for enabled products.

Run the same conformance suite against SQLite and Miniflare D1, including independent concurrent requests, failed-predicate rollback, restart, unauthorized IDs/cursors and revocation. Verify at most one link per slot and no private preset disclosure through shared tasks. Acceptance: T02–T07, T14–T15, T17, T24.

### S3 — Preset editor, task surface and start preview

Compose proposed `solid/{presets-surface,preset-editor,task-list,task-board,task-detail,task-create-dialog,task-subtasks,start-task-dialog}.tsx` through app `app/integrations/tasks/`. Reuse existing shared controls and current model/harness/effort selectors; read their owner charters before modifying them.

Preset editor supports placement, primary and optional fixed configuration slots, instructions and cloud selections. Local shows inherited capability behavior; do not display enforceable selection controls there. Cloud skill/plugin catalogs reference authorized installed content, with preview of bundled skills/platform tools and missing connections. Saving does not install/connect/provision. Validate dependent selection fields and preserve drafts on errors/stale edits.

Start preview is host-owned and side-effect free: resolve task/project/preset revision, local target or cloud source/ref, configuration, supported instruction/group behavior and capability selection. Show unavailable explicit choices; never auto-substitute. The preview supplies an expiring resolved identity to revalidate on Start. No preview call invokes an agent, creates a workspace or starts OAuth setup.

Task UI retains manual statuses and Circle-style list/board/detail. Start selects a preset/configuration; linked slots open ordinary sessions. Optional handoff text is explicit and is not an activity comment or plan document. Use mounted Vitest for Solid interactions and existing browser tiers, not duplicate test frameworks. Acceptance: T02–T07, T13, T17–T18.

### S4 — Canonical session-start configuration and local linking

Trace and extend current registration/create/storage contracts for a generic resolved start configuration and durable source-origin association. Keep host task/preset resolution in proposed `tasks/session-bridge.ts`; runtime receives resolved values, not Tasks service access. Include instruction content, model group, selected slot and source/config hash as needed by the canonical owner. No secret values or live preset dereference on resume.

Qualify unique `(scope, taskId, slot)` origin reservation before side effects. Two clients with the same resolved settings return one session; competing settings conflict. Same client request after uncertainty recovers the canonical receipt. Create/link and first-message are distinct failure points: persist link before handoff, distinguish initial submission from replay, never blindly resend. Review the existing child-create/first-prompt replay path as well; its request ID alone must not be assumed to deduplicate prompt submission.

For Local, use the selected actual host/workspace and existing skills/plugins without config mutation. Resolve real harness/model/variant and wire instructions through each supported adapter, retaining them across resume. Open later must not create/send or reapply an edited preset. Task edits/archive/access loss during start cannot attach a session to a different target. Created resources remain under canonical host recovery/cleanup.

Test through real host/session entrypoints, separate clients and injected process/network failures. Verify model/effort/config readback and a real instruction-following result. Gate unqualified harness/instruction combinations. Acceptance: T08–T12, T14, T18–T19, T24.

### S5 — Isolated cloud root allocation and lifecycle

Extend current workspace creation/sandbox preparation to reserve and recover a dedicated workspace for each root origin, with the user's authorized project source/ref. Different tasks/slots cannot share mutable runtime/home/plugin state; retries reuse their own workspace. Children of a root can share that root's capability set.

Bind selection/config identity before provisioning and use existing sandbox lifecycle for readiness, failure cleanup, suspend/resume and storage/checkpoint retention. No Tasks worker, lease table or scheduler. Handle quota, missing source/connection, allocation success with lost response, partial projection and host restart through authoritative workspace receipts. Never fall back to Local or delete an unrelated workspace.

Cloud source preview must make clear whether it includes committed repository state only; do not imply dirty local changes were transferred. Preset archive/task archive do not destroy environments. Opening a stopped session restores the same association/configuration without allocating another workspace. Backend metadata works while runtimes are stopped. Acceptance: T10–T12, T15, T20, T22, T24.

### S6 — Exact cloud skill/plugin selection and credential scope

Extend canonical activation projection/runtime preparation/apply contracts and every affected adapter/test together. Version and validate producer/consumer changes together. Keep ordinary workspace-default activation distinct from explicit execution selection; selected-only requests cannot fall through to defaults on an older runtime. Explicit execution selection is independent of project defaults and carries a selection hash in preparation, apply, cached work and acknowledgement. Equal activation revision with a different selection is not a cache hit. Do not write task overrides into shared project activation.

Resolve only authorized retained catalog artifacts. Materialize selected plugins, their bundled skills and directly selected skills; direct skills do not implicitly enable MCP servers. Deduplicate identities and reject harness naming collisions. An empty optional selection is tested through engine readback. Filter native/global discovery or reject the harness/environment combination. Do not claim selection just because a generated directory contains fewer files.

Use the exact manifest for MCP preparation and brokered credentials. Verify workspace uniqueness, gateway enforcement/current authorization and revoked credentials on resume. Limit the promise to supplied/discovered capabilities; repository/shell/network policy remains separate. Persist pins and restore them rather than applying current broader defaults. Local configuration remains untouched.

Run adapter tests plus real two-root concurrency with disjoint selections in the same project, global-default plugins deliberately present, same activation revision and process restart. Inspect skill discovery, actual tool inventory and gateway calls, not only payloads. At least one excluded tool call must be rejected through the real gateway path. Acceptance: T19–T22, T24.

### S7 — Model-group use through existing session mechanisms

Explicit slot selection already works through S3/S4. Add qualified agent-directed group use through canonical `create_subagent`/session-child contracts: stable configuration key resolution, effort propagation, inherited instructions and bounded parent capability/permission ceilings. The runtime resolves the parent's retained group; tools cannot inject a different arbitrary preset or broaden capability scope. Keep all existing public consumers aligned if the contract changes.

Prove the child actually uses the selected harness/model/effort and receives explicit delegated context. Do not rely on prompt wording or a label. Preserve request/first-message deduplication and existing child limits. No implicit parent transcript, automatic Plan→Execute scheduler or Tasks-owned child observation. Native cross-harness handoff is optional only where existing capability checks pass; explicit separate-root handoff remains available.

Capability responses/UI must distinguish manual group selection from verified agent-directed group support. Unsupported combinations are refused with a useful message; never silently ignore an effort or delegate with an unintended model. Acceptance: T18, T23–T24.

### S8 — Final artifacts, E2E and live computer use

Wire Tasks-on preset/catalog/session tests into existing suite discovery, fixed spec lists, build manifests and CI lanes. Extend existing packaged-desktop and deployed owners; maintain an independent off-artifact lane. No root `bun test`; use owning-package scripts.

Run affected package tests/typechecks/builds and `bun run test:architecture-ratchets` for changed production imports. Inspect new closure edges before any exact-ceiling ratchet update and run the affected full closure verifier. Record actual commands/results during implementation rather than inventing commands for an uncreated package.

Qualify local web, signed Node, packaged desktop file-origin and deployed hosted flows. Use actual SQLite/D1, sandbox/relay and credentials where relevant. Complete T01–T24 with screenshots actually reviewed and independent screenshot-driven computer use. Missing deployed/model access remains GATING for the exact journey.

## 4. Pressure test and resolved design decisions

| Failure or ambiguity | Required design/proof |
|---|---|
| A named preset quietly becomes a bot | Only settings/ownership/revisions; no inbox, memory namespace, standing work or credentials |
| Model-group prose promises unsupported automation | Manual slot selection is concrete; delegation requires S7 capability and real configuration readback; no automatic phase transition |
| Cloud control plane is mistaken for isolation | Dedicated workspace/runtime/home and secret scope per root; two-root concurrent proof |
| Applying preset A changes task B or local configuration | No mutation of activation defaults/shared runtime; distinct root projections and local before/after checks |
| Same activation revision returns a different preset's cached projection | Selection identity participates in all preparation/coalescing/apply receipts, not just a UI cache key |
| Empty selection becomes inherited defaults | Explicit selected-empty discriminator end to end; test actual inventory with defaults installed |
| Selected skill silently enables an entire plugin | Direct skills contribute guidance only; bundled-plugin expansion is visible and intentional |
| Names collide or repeated sources fill context | Canonical source/revision deduplication and target-harness collision validation |
| Tool hidden but broad credential still available | Exact credential preparation plus gateway negative tests/current authorization; describe workload-policy limit |
| Two clients start same slot with different presets | Canonical origin reservation compares resolved hashes; loser conflicts, no orphan duplicate allocation |
| Preset edited/archived during start or before resume | Reserved settings remain immutable; new starts revalidate; existing session opens without private preset access |
| Root link lost after cloud allocation/create | Canonical owner recovers same workspace/session; no Tasks Run substitute |
| Initial/child message is sent twice on replay | Prove admission replay in canonical producer; preserve linked session on uncertain outcome |
| Separate planning/implementation roots appear to share code/history | Explicit source/ref and handoff text; no implicit transfer of uncommitted changes/transcript |
| Feature-off build prevents an existing session from resuming | Generic runtime settings have no Tasks import; off→open-session proof |
| Tests validate serialization but not behavior | Real effective-config readback, tool calls/refusals, isolation/resume and inspected live user flows |

## 5. Remaining implementation gates

- **G1 — S2 store/auth owner:** atomic task/parent/slot/preset guards in SQLite and D1, bounded data and personal-preset/project-task isolation.
- **G2 — S4 session owner:** durable origin/config association, canonical instruction/group persistence, two-client creation and first-message replay across restart. Existing ID parameters do not close this gate.
- **G3 — S5 workspace owner:** isolated origin-bound allocation, readiness, source/ref semantics, failure cleanup and checkpoint/restore guarantees without a second orchestration layer.
- **G4 — S6 plugin/credential owners:** exact selected capability manifest through all projections/caches, native discovery, gateway authority/revocation and empty-set behavior. Unsupported harnesses cannot advertise selected-only mode.
- **G5 — S7 runtime/MCP owner:** actual model/effort selection and context/capability inheritance for agent-directed group use. Manual configuration selection must not be mislabeled as verified delegation.
- **G6 — S8 acceptance owner:** real local/desktop/hosted/model access, emitted artifact selection and independent live computer-use evidence.

Catalog slices may be reviewed independently, but the agreed full feature is incomplete until its advertised local/cloud/preset/group journeys pass. Record any blocked criterion, evidence, owner and follow-up. No implementation or future product tests were executed by this documentation update.
