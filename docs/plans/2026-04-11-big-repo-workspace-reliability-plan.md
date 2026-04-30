---
title: "platform: Big Repo Workspace Reliability and Throughput"
type: platform
status: active
date: 2026-04-11
---

# platform: Big Repo Workspace Reliability and Throughput

## Summary

Claxedo already has meaningful durable session state, message replay, session lineage metadata, cloud workspace orchestration, and a remote `workspace-runtime`. That is a stronger baseline than a blank-slate hosted coding system.

Related docs:

- [docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/plans/2026-04-11-durable-workspace-control-plane-implementation-plan.md) — adopted hosted control-plane target
- [docs/sync-architecture-target.md](/Users/yashvardhansingh/.codex/worktrees/b0da/opencode/docs/sync-architecture-target.md) — metadata and timeline target

The current weak point for large repository work is not "sessions do not persist." The weak point is that the system still combines:

- runtime-local session durability
- best-effort central sync
- in-memory workspace supervision
- generic sandbox startup
- no repo-image or runtime snapshot fast path
- no first-class repo bootstrap contract
- no compute-class or admission-control model

For big monorepos and enterprise background coding, those gaps show up as slow cold starts, fragile resumes, poor recovery after crashes, unclear workspace ownership, and too much repeated setup work.

This doc is grounded in the current code and focuses on what we need to make large-repo background coding robust and reliable.

## Problem Frame

Large-repo coding workloads stress parts of the system that smaller projects can tolerate:

- clone and install phases dominate startup time
- remote runtimes must survive control-plane restarts without becoming orphaned
- service-heavy repos need deterministic bootstrap and readiness checks
- long-lived sessions need a stronger resume story than "rebuild from generic image"
- multi-workspace routing and event fanout need tighter workspace isolation
- users need explicit compute sizing and resource queues for heavyweight tasks

The current architecture supports hosted workspaces, but it does not yet optimize the "big repo, long-running, service-heavy, background agent" path as a first-class product flow.

## Current Strengths We Should Preserve

### 1. Runtime-local durable session state already exists

`packages/workspace-runtime/src/store.ts` persists:

- `session`
- `message`
- `part`
- `todo`
- `pending_permission`
- `pending_question`
- `journal_checkpoint`

The store replays durable state on startup, which gives us actual session persistence and replay, not just in-memory chat state.

Implication:

- We do **not** need to invent session durability from scratch.
- We **do** need to decide which session data remains runtime-local and which becomes control-plane-canonical.

### 2. Central metadata and replay sync already exists

`docs/sync-architecture.md` and current code show that `claxedo-server` already persists:

- `claxedo_session_meta`
- `claxedo_session_tag`
- `claxedo_session_attachment`
- `claxedo_cloud_session`
- `claxedo_cloud_message`

Relevant code:

- `packages/claxedo-server/src/session-meta.ts`
- `packages/claxedo-server/src/cloud/message-replay.ts`

This already gives us:

- central title and archive metadata
- parent and root lineage
- tags and attachments
- replay-first message reads for cloud sessions

Implication:

- We already have a meaningful session index and lineage layer.
- The main question is not whether to add one, but whether to make it stricter and more canonical.

### 3. Cloud workspaces already have a real remote execution path

Current hosted flow uses:

- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/claxedo-server/src/cloud/sandbox-pool.ts`
- `packages/claxedo-server/src/cloud/sandbox-runtime.ts`
- `packages/claxedo-server/src/proxy.ts`
- `packages/workspace-runtime/src/server.ts`

This already supports:

- workspace routing
- sandbox acquisition
- remote runtime deployment
- event stream bridging
- idle shutdown

Implication:

- We should evolve this path, not replace it blindly.

## Current Reliability Boundaries And Gaps

### 1. Workspace supervisor state is process-local

`packages/claxedo-server/src/workspace-supervisor.ts` keeps runtime state in:

- `const runtimes = new Map<string, State>()`
- timers for idle shutdown
- in-memory crash counters and backoff
- in-memory active holds

The supervisor can restart remote workspaces, but its authority is process-local.

Risks for big repo work:

- server restart loses the live workspace lease table
- remote sandboxes can continue running after control-plane restart
- crash counts, retry windows, and activity holds are lost
- there is no durable adoption story for already-running remote runtimes

Why this matters more for big repos:

- large repos cost more to bootstrap
- losing ownership and forcing cold restart is materially expensive
- long-running tasks are more likely to cross deployment boundaries

Required change:

- move workspace lease and lifecycle state into a durable control-plane store
- make the supervisor reconstructable from persisted state

### 2. Startup is still generic clone-plus-runtime boot

`packages/claxedo-server/src/cloud/sandbox-runtime.ts` does this:

1. ensure workspace directory
2. clone repo if missing
3. install `@claxedo/workspace-runtime` if snapshot missed it
4. start workspace runtime
5. health-check `/api/wr/health`

This is good generic infrastructure, but it does not encode repo-specific provisioning.

Current missing pieces:

- no repo image fast path
- no runtime filesystem snapshot restore
- no repo-specific setup contract
- no repo-specific start contract
- no repo-specific service readiness model

Risks for big repos:

- repeated dependency install cost
- repeated codegen/build cost
- repeated service boot cost
- user-specific fixes are not productized

Required change:

- add a repo bootstrap contract with separate provisioning and runtime hooks
- add image and snapshot acceleration on top of that contract

### 3. No first-class repo bootstrap contract

We have process config support in `packages/workspace-runtime/src/process/index.ts`, but that is not the same as a remote bootstrap contract for creating a usable workspace from scratch.

Today process config is:

- file-based
- rooted in `.claxedo/processes.jsonc`
- great for long-running user-defined processes once the workspace already exists

But missing for big repo reliability:

- one documented provisioning hook
- one documented runtime-start hook
- strict readiness criteria
- failure mode guidance for remote starts
- portability guarantees between local and cloud workspaces

Required change:

- define a product-owned bootstrap contract, similar in spirit to `setup.sh` and `start.sh`, but aligned to Claxedo naming and metadata

Suggested model:

- `bootstrap`: expensive provisioning, safe to cache into repo images
- `start`: per-session runtime start, safe to rerun after restore
- `verify`: explicit readiness checks for required ports/services

### 4. No runtime filesystem snapshot path for workspace state

Our own `docs/cloud-architecture-hardening.md` already calls this out:

- no sandbox filesystem snapshot or session persistence at the sandbox layer
- large interactive workspaces lose install/build state on stop

This is the single largest throughput gap for big repo work.

Consequences:

- every serious workspace behaves more like a fresh VM than a resumable workstation
- idle stop is expensive
- long dependency installs get repeated
- large generated outputs and caches are lost

Required change:

- support `workspace snapshot -> restore` as a first-class workspace path
- store snapshot metadata on the workspace row
- define snapshot triggers and invalidation rules

### 5. No repo image build pipeline for shared warm starts

We have:

- a shared sandbox image
- a shared runtime snapshot
- a Daytona warm pool

We do **not** have:

- one image per repo or per branch family
- build status and staleness tracking
- image refresh scheduling
- image selection precedence during workspace spawn

For large repos, this means our warm pool optimizes runtime boot, not repo readiness.

Required change:

- add repo image registry and async image builds
- start from `workspace snapshot -> repo image -> base image`

### 6. No explicit compute classes or workload admission model

Current pool config in `packages/claxedo-server/src/cloud/sandbox-pool.ts` is effectively fixed-shape:

- pool target count
- warm Daytona sandboxes
- restricted network mode bypasses pool

Missing for big repo work:

- small/medium/large/gpu classes
- task-to-class mapping
- queueing and concurrency limits
- org quotas
- "restart with more resources" path
- class-specific warm pools

Risks:

- heavyweight builds land on underpowered sandboxes
- pool economics do not match workload shape
- noisy neighbors are hard to reason about

Required change:

- make compute class part of workspace profile and lease state

### 7. Eventing and sync are still eventual and composed

`docs/sync-architecture.md` is explicit that the current model is:

- merged reads
- replay-first fallback-to-adapter
- best-effort hook-driven sync
- eventual consistency inside the control plane

That is workable, but for enterprise background coding we need to be more precise about which reads are:

- runtime-canonical
- control-plane-canonical
- cache-like and reparable

This matters most for:

- session lists
- message histories
- workspace activity indicators
- child session accounting
- automation and reporting

Required change:

- promote a formal source-of-truth matrix into code-level interfaces
- reduce best-effort sync where product behavior depends on strict correctness

### 8. Remote runtime health is only checking the workspace runtime

`workspace-supervisor.ts` and `sandbox-runtime.ts` currently validate:

- runtime health endpoint

They do not validate:

- repo-specific dev services
- required background daemons
- port availability for app services
- correctness of user bootstrapped processes

For large repos, a healthy workspace runtime can still mean a broken usable environment.

Required change:

- add repo `verify` stage
- make service readiness part of the workspace profile

### 9. Local runtime spawn currently forwards full parent env

`workspace-supervisor.ts` local runtime spawn still does:

- `env: { ...process.env, ...explicit vars }`

This is already called out in `docs/cloud-architecture-hardening.md` as a secret-boundary issue.

For big repo work, this is also a reliability concern:

- runtime behavior depends on accidental parent env
- local and cloud behavior drift
- hidden env coupling makes repro harder

Required change:

- switch local runtime spawn to explicit allowlisted env
- converge local and cloud bootstrap semantics

### 10. Process config is good, but not yet a full remote workspace services model

`packages/workspace-runtime/src/process/index.ts` is a strong foundation:

- deterministic ports
- restart policies
- diagnostics
- config watching
- lease primitives

But it is not yet fully integrated into hosted workspace provisioning.

What is missing:

- process configs tied to workspace startup stages
- service readiness integrated with workspace lease status
- central visibility into expected vs actual services for cloud workspaces

Required change:

- treat process config as the runtime-services layer beneath the repo bootstrap contract

## Reliability Model We Should Target

For big repo work, the workspace should be modeled as:

```text
Workspace
├── Profile
│   ├── repo
│   ├── branch
│   ├── compute class
│   ├── bootstrap contract
│   ├── service contract
│   ├── network policy
│   └── secret policy
├── Lease
│   ├── owner
│   ├── state
│   ├── provider object id
│   ├── retry state
│   ├── last activity
│   └── health state
├── Acceleration
│   ├── base image
│   ├── repo image
│   └── runtime snapshot
└── Session Surface
    ├── runtime-local journaled state
    ├── central metadata
    ├── central replay
    └── cross-workspace index
```

Key rule:

- repo acceleration layers make the workspace fast
- lease state makes it reliable
- bootstrap contract makes it reproducible
- sync model makes it observable

## Recommended Architecture Changes

### A. Introduce a durable workspace lease layer

Goal:

- make remote runtime ownership reconstructable after control-plane restart

Needed capabilities:

- workspace status
- provider object id
- retry and backoff counters
- last heartbeat
- last activity
- active holds
- last health failure
- compute class
- selected acceleration inputs

Likely files:

- add storage under `packages/claxedo-server/src/storage/`
- refactor `packages/claxedo-server/src/workspace-supervisor.ts`
- thread through `packages/claxedo-server/src/cloud/sandbox-pool.ts`

### B. Split lifecycle decisions from side effects

Goal:

- move current imperative lifecycle logic into pure decision functions plus provider capability adapters

Why:

- easier testing
- clearer provider support matrix
- safer retries and recovery

Current target files:

- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/claxedo-server/src/cloud/sandbox-pool.ts`
- `packages/claxedo-server/src/cloud/sandbox-runtime.ts`

New shape:

- lifecycle decision module
- provider capability module
- durable lease adapter
- broadcaster adapter

### C. Add repo profiles with bootstrap, start, and verify phases

Goal:

- make large-repo startup reproducible and cacheable

Profile fields should include:

- repo owner/url
- default branch
- compute class
- bootstrap commands or script
- start commands or service refs
- verify checks
- exposed ports
- expected long-running services
- cacheability hints

Implementation direction:

- keep `.claxedo/processes` as the service runtime layer
- add `.claxedo/workspace` as the outer workspace provisioning contract
- make `.claxedo/workspace` authoritative for `prepare`, `verify`, runtime requirements, and acceleration policy
- make `.claxedo/processes` authoritative for long-running service definitions and per-service ports

### D. Add repo images

Goal:

- reduce cold-start cost for large repos

Repo image should capture:

- cloned repo at base SHA
- dependencies
- generated code
- provisioned tools and caches from bootstrap phase

Selection precedence:

1. runtime snapshot
2. repo image
3. shared base image

Validity rules:

- runtime snapshot is only valid when base image lineage, repo profile hash, runtime fingerprint, and source compatibility still match
- repo image is only valid when base image lineage, repo profile hash, runtime fingerprint, and source compatibility still match
- invalid acceleration layers must be skipped instead of best-effort reused

### E. Add runtime filesystem snapshots

Goal:

- make resume cheap after idle stop, restart, and reconnect

Snapshot contents:

- installed dependencies
- build artifacts
- generated outputs
- repo working copy
- runtime-local caches

Triggers:

- before idle stop
- after successful bootstrap for first-time workspaces
- after major workspace mutations
- manual save

Failure contract:

- failed `verify` after boot or restore must move the workspace into a non-ready lease state
- verification failure should not silently publish `ready`
- retry and backoff rules for `verify` failure must be explicit and separate from sandbox spawn failure

### F. Add compute classes and admission control

Goal:

- make large repo tasks land on appropriate resources

Required classes:

- `small`
- `medium`
- `large`
- `xlarge`
- `gpu` if applicable

Required control-plane features:

- org quotas
- class-specific queue limits
- class-specific warm pools
- manual resize flow
- task hints from UI/agents

### G. Strengthen source-of-truth boundaries

Goal:

- reduce ambiguity in session and workspace reads

Rules to formalize:

- runtime-local store remains canonical for active session internals
- central metadata remains canonical for title/archive/lineage/attachments
- message replay is central and reparable, but should gain stricter write contracts where needed
- workspace lease status must become central and canonical through `WorkspaceAuthority`

### H. Make service readiness first-class

Goal:

- a ready workspace should mean "repo environment is usable," not just "workspace runtime is up"

Examples:

- required port responds
- process is running
- migration step completed
- package install succeeded

This should integrate with:

- process manager
- workspace lease status
- bootstrap profile verification

Failed verification should:

- block transition to `ready`
- record the failure on lease state
- allow configured retry or require explicit operator/user action depending on failure class

## Implementation Units

- [ ] **Unit 1: Durable workspace lease store**

Goal:

- Persist remote workspace lifecycle state outside process memory.

Files:

- Add storage tables under `packages/claxedo-server/src/storage/`
- Modify `packages/claxedo-server/src/workspace-supervisor.ts`
- Modify `packages/claxedo-server/src/workspace-store.ts`

- [ ] **Unit 2: Lifecycle decision engine**

Goal:

- Refactor workspace lifecycle into pure decisions plus provider actions.

Files:

- Add `packages/claxedo-server/src/cloud/lifecycle/`
- Modify `packages/claxedo-server/src/workspace-supervisor.ts`
- Modify `packages/claxedo-server/src/cloud/sandbox-pool.ts`

- [ ] **Unit 3: Repo profile contract**

Goal:

- Define product-owned bootstrap/start/verify contract for hosted workspaces.

Files:

- Add `.claxedo/workspace` schema and loader under `packages/workspace-runtime/src/`
- Integrate with `packages/workspace-runtime/src/process/index.ts`
- Expose profile status through `packages/workspace-runtime/src/routes/`

- [ ] **Unit 4: Repo image registry and build pipeline**

Goal:

- Build and refresh repo-scoped images for large repos.

Files:

- Add registry tables and routes under `packages/claxedo-server/src/storage/` and `src/routes/`
- Add build worker path under `packages/claxedo-server/src/cloud/`

- [ ] **Unit 5: Runtime snapshot support**

Goal:

- Restore stopped workspaces from runtime snapshots instead of cold clone/setup.

Files:

- Extend provider abstractions in `packages/claxedo-server/src/cloud/`
- Store snapshot metadata on workspace lease rows
- Update `workspace-supervisor.ts` spawn logic

- [ ] **Unit 6: Compute classes and scheduling**

Goal:

- Add resource sizing and queue controls for heavy workloads.

Files:

- Extend workspace model and lease model
- Modify `packages/claxedo-server/src/cloud/sandbox-pool.ts`
- Add settings routes/UI later

- [ ] **Unit 7: Readiness and verification**

Goal:

- Promote service verification into workspace startup and resume behavior.

Files:

- Extend `packages/workspace-runtime/src/process/index.ts`
- Add verification routes under `packages/workspace-runtime/src/routes/`
- Update `packages/claxedo-server/src/cloud/sandbox-runtime.ts`

## Recommended Order

1. Durable workspace lease store
2. Lifecycle decision engine
3. Repo profile contract
4. Repo image pipeline
5. Runtime snapshot support
6. Readiness and verification
7. Compute classes and scheduling

## Success Criteria

- Large repo hosted workspaces resume in seconds when a valid runtime snapshot exists.
- First boot of a large repo can use a repo image instead of clone-plus-install.
- Control-plane restart does not orphan active remote workspaces.
- Workspace readiness means repo services are actually usable, not just that `workspace-runtime` is healthy.
- Big repo workloads can choose or infer appropriate compute classes.
- Session durability remains intact while workspace lifecycle becomes more reconstructable and more observable.

## Non-Goals

- Backward-compatible migration for old hosted workspace ownership state.
- Replacing the existing runtime-local session store.
- Replacing `claxedo_session_meta` or message replay with a brand-new system immediately.
- Designing the final enterprise secret broker in this doc.
- Solving every cloud-provider-specific snapshot capability in the first pass.

## Bottom Line

Claxedo already has durable sessions, replay, lineage, and hosted workspaces.

To make it robust for big repo code work, the next major step is not "add session persistence." The next major step is:

- durable workspace leases
- productized repo bootstrap
- repo images
- runtime snapshots
- readiness verification
- compute classes

Those changes turn the current hosted path from "generic remote runtime with durable session state" into "reliable large-repo background workstation."
