---
title: "refactor(strategy): OpenCode is just another harness — workstream index"
type: refactor
status: proposed
date: 2026-08-19
planned-at: c97fe21
---

# OpenCode is just another harness — workstream index

## Strategic goal

Claxedo's product bet is the **backend**: the control plane, workspace runtime,
relay, sandbox management, normalized agent events, WorkGraph, and Agent
Extensions — with every coding agent (Claude, Codex, Cursor, OpenCode, Pi, and
any future ACP-speaking agent) attaching as **one harness among peers**. Today
OpenCode is not a peer: it is a hard fork vendored in-repo AND the privileged
default engine of the control plane. This index tracks the workstreams that
demote it to "just another harness" and open the harness surface to arbitrary
external agents.

## Where the code already agrees

These are observed facts at commit `c97fe21`, not aspirations:

- `OpenCodeHarnessAdapter` (`packages/agent-sdk-runtime/src/harnesses/opencode/index.ts`)
  implements the same `AgentHarnessAdapter` contract as Claude/Codex/Cursor/Pi
  and manages an `opencode serve` process or an injected in-process transport.
- The workspace runtime dispatches adapters through an ordered
  `WorkspaceHarnessRegistry` (`packages/workspace-runtime/src/workspace/runtime.ts:720-817`);
  hosts may supply their own registry.
- WorkGraph already has a harness-aware execution path:
  `createHarnessWorkGraphGateway`
  (`packages/claxedo-server/src/hosts/workgraph/composition/session-gateway.ts:198`)
  drives non-OpenCode harnesses through embedded workspace-runtime session
  routes, and Run tools reach harness sessions through the harness-neutral
  `workGraphRuntimeRouteContributions`
  (`packages/workgraph/src/runtime-adapter/index.ts:101`).
- The hosted (cloud) WorkGraph execution-capabilities port
  (`packages/claxedo-server/src/hosts/workgraph/hosted/execution-capabilities.ts`)
  is engine-free: sandbox manager + relay + signed auth.

## Where OpenCode is still privileged

1. **Embedded default engine.** `packages/claxedo-server-core/src/opencode/engine.ts`
   lazily boots the vendored engine in-process as the default transport
   (`config` defaults to `{ mode: "embedded" }`, line 50), and the default
   harness is `{ id: "opencode", access: "native" }`
   (`packages/claxedo-server-core/src/agent-config/index.ts:360`).
2. **WorkGraph local execution rides the engine.** Session V2 admission,
   connection-bound Runs, session intake, and the local execution-capabilities
   catalog all call `opencodeRequest` directly (see plan 001).
3. **Credentials engine-bridge.** `packages/claxedo-server-core/src/credentials/engine-bridge.ts`
   writes registry credentials into the engine's own auth store, and boots the
   engine as a side effect of a credential write (see plan 002).
4. **Unknown-harness fallthrough.** The default workspace harness registry's
   catch-all entry maps ANY unmatched runner to the OpenCode adapter
   (`packages/workspace-runtime/src/workspace/runtime.ts:802-815`), and the
   closed `AGENT_HARNESS_IDS` union blocks new agents entirely
   (`packages/agent-sdk-runtime/src/harness-types.ts:68`).

## Workstreams

| # | Workstream | Plan | Status |
|---|-----------|------|--------|
| W1 | Open the harness surface: any operator-configured stdio ACP agent becomes a selectable harness; first-party ACP duplicates removed | [2026-07-22-001-refactor-scriptable-acp-connections-plan.md](./2026-07-22-001-refactor-scriptable-acp-connections-plan.md) (pre-existing, `status: active`) | active — see drift note below |
| W2 | WorkGraph local execution harness-neutral: connection tools, session intake, and capabilities catalog stop requiring the OpenCode engine | [2026-08-19-001-refactor-workgraph-harness-neutral-execution-plan.md](./2026-08-19-001-refactor-workgraph-harness-neutral-execution-plan.md) | DONE (2026-08-19; full claxedo-server suite green except the pre-existing `tokentracker-cli` baseline failure in `src/usage/adapters/token-tracker-local-history.test.ts`, present on a clean tree) |
| W3 | Credentials engine-bridge scoped to the OpenCode domain: a credential write never boots the engine | [2026-08-19-002-refactor-opencode-engine-auth-bridge-scoping-plan.md](./2026-08-19-002-refactor-opencode-engine-auth-bridge-scoping-plan.md) | proposed |
| W4 | Embedded engine becomes an opencode-adapter implementation detail: no engine load unless an OpenCode surface is used; unknown runners no longer fall through to OpenCode | [2026-08-19-003-refactor-opencode-engine-as-adapter-detail-plan.md](./2026-08-19-003-refactor-opencode-engine-as-adapter-detail-plan.md) | proposed |

### Recommended order and dependencies

1. **W2 (WorkGraph)** first — it removes the largest engine consumer and is
   independently shippable in three units.
2. **W3 (credentials)** second — small, independent of W2, but its "no boot on
   credential write" acceptance is a prerequisite for W4's end-state check.
3. **W1 (scriptable ACP)** can proceed in parallel; it touches
   `agent-sdk-runtime`/`workspace-runtime` registry surfaces that W4 also
   touches, so land W1's accepted-registry before W4's catch-all removal, or
   coordinate the two changes in one series.
4. **W4 (engine scoping)** last — it is the capstone whose done-criteria only
   hold once W2/W3 have removed the ambient engine consumers.

### Drift note on W1 (pre-existing plan)

The scriptable-ACP plan was written 2026-07-22. At `c97fe21` the code still
contains what it plans to remove (first-party ACP definitions in
`AGENT_HARNESS_DEFINITIONS`, the closed `AGENT_HARNESS_IDS` union, ACP binary
fallbacks in `workspace-runtime`), so the plan has not landed. Any executor
picking it up must re-run its own grounding pass against current code before
starting — in particular the `WorkspaceHarnessRegistry` seam
(`WorkspaceHostOptions.harnesses`, `runtime.ts:720-817`) now exists and is the
natural mount point for its accepted-registry design.

## Explicitly out of scope for this initiative

- **Removing the vendored OpenCode fork packages** (`packages/{opencode,core,
  server,protocol,schema,plugin,llm,codemode,tui,ui,session-ui,sdk,sdk-next,
  http-recorder}`). The shared UI packages are load-bearing for the desktop
  app; shrinking the fork is a separate, later initiative that these plans
  enable but do not perform.
- **Changing the product default harness** away from OpenCode
  (`agent-config/index.ts:360`). That is a product decision, not an
  architecture one; these plans make it a one-line config change either way.
- **The OpenCode-compat HTTP surface** (`opencodeCompat` in
  `workspace-runtime`, the server compat routes). This is deliberately KEPT:
  it lets external OpenCode-dialect clients connect to claxedo-server, which
  serves the strategy. W4 only ensures it does not force an engine boot when
  disabled or unused.
