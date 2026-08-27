---
title: "refactor(workgraph): harness-neutral local execution — connection tools, intake, and capabilities off the embedded OpenCode engine"
type: refactor
status: proposed
date: 2026-08-19
planned-at: c97fe21
priority: P1
effort: L
risk: MED
depends-on: none
---

# refactor(workgraph): harness-neutral local execution

> **Executor instructions**: Follow this plan unit by unit. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's status row in
> `docs/plans/2026-08-19-000-opencode-just-another-harness-index.md`.
>
> **Drift check (run first)**:
> `git diff --stat c97fe21..HEAD -- packages/claxedo-server/src/hosts/workgraph packages/claxedo-server/src/deployments/self-hosted-node packages/workgraph/src/runtime-adapter`
> If any in-scope file changed since `c97fe21`, compare the "Current state"
> excerpts below against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Why this matters

WorkGraph is Claxedo's differentiating product layer, but its **local** (self-
hosted / desktop) execution path hard-wires three capabilities to the embedded
OpenCode engine: connection-bound Runs refuse every other harness outright,
session intake only ever observes engine sessions, and the composer capability
catalog reads agents/models/tools from the engine transport. This contradicts
the strategic direction ("OpenCode is just another harness") and means the
flagship feature cannot honestly be marketed as harness-agnostic. The hosted
(cloud) path is already engine-free, proving the neutral shape works. After
this plan, a WorkGraph Run with connection tools executes on Claude, Codex,
Cursor, or Pi exactly as it does on OpenCode, and idle interactive sessions on
any harness are projected into WorkGraph.

## Current state (observed at c97fe21)

### Files and roles

- `packages/claxedo-server/src/hosts/workgraph/composition/session-gateway.ts`
  — the local WorkGraph session gateway. Two gateways live here:
  - `createSessionV2WorkGraphGateway(opencodeRequest, options)` (line 401):
    drives the ENGINE's Session V2 API (`/api/session`) over the injected
    `OpenCodeRequestFn`, and injects dynamic per-session tools through the
    engine's `/api/session/:id/tool` callback mechanism (lines 428-462). Used
    for the `opencode` harness only.
  - `createHarnessWorkGraphGateway(opencodeRequest, options)` (line 198):
    wraps the V2 gateway and routes every OTHER harness through
    `options.sessionRequest(directory, request)` — i.e. the embedded
    workspace-runtime Hono app for that directory. It creates sessions via
    `POST /session` (line 269), registers Run-tool bindings via
    `POST /api/workgraph/run-binding` on the runtime (lines 308-319), and
    prompts via `POST /session/:id/prompt_async` (line 321).
- `packages/claxedo-server/src/hosts/workgraph/session-intake.ts` — projects
  idle interactive sessions into WorkGraph. Engine-only in both directions:
  its event source is `globalBus` (fed by engine upstream events), and
  `readIdleSession` (line 53) reads `/session/:id` + `/session/:id/message`
  over `opencodeRequest` against `OPENCODE_INTERNAL_BASE`.
- `packages/claxedo-server/src/hosts/workgraph/local/execution-capabilities.ts`
  — the composer capability catalog. Reads the OpenCode entry's agents,
  providers, and tools from the engine (`runtimeJson` at lines 59-66 and
  249-260 hits `/agent`, `/api/model`, `/experimental/tool/ids` on
  `opencodeRequest`); every non-OpenCode harness entry carries
  `connectionTools: false` (lines 79, 86).
- `packages/workgraph/src/runtime-adapter/workgraph-connection-tools.ts` — the
  HARNESS-NEUTRAL connection-tool mechanism, already built:
  `WORKGRAPH_CONNECTION_BINDING_PATH = "/api/workgraph/connection-binding"`
  (line 171), `POST` handler (line 223), bind schema (lines 34-40):

  ```ts
  const bind = z.object({
    version: z.literal(1),
    identity: bindingIdentity,
    connectionIds: z.array(z.string().min(1)).min(1),
    tools: z.array(z.enum(WORKGRAPH_CONNECTION_TOOL_NAMES)).min(1),
    brokerUrl: z.string().min(1),
  }).strict()
  ```
- `packages/workgraph/src/runtime-adapter/index.ts:101-105` — route
  contributions:

  ```ts
  export function workGraphRuntimeRouteContributions(
    options: WorkGraphRuntimeAdapterOptions = {},
  ): WorkspaceRuntimeRouteContribution[] {
    return [connectionContribution(options.connection), runContribution(options.run)]
  }
  ```
- `packages/claxedo-server/src/deployments/self-hosted-node/capabilities.ts:41-47`
  — the self-hosted composition currently wires ONLY the run broker:

  ```ts
  return {
    runtimeRouteContributions: workGraphRuntimeRouteContributions({
      run: { broker: input.workGraphRunBroker },
    }),
  }
  ```
- `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` — local
  composition root. Key sites:
  - `workgraphRuntime(directory)` (lines 1407-1427): registers a workspace and
    returns its embedded runtime; `sessionRequest` at lines 1467-1469 fetches
    against `runtime.app`.
  - `createHarnessWorkGraphGateway(...)` composition (lines 1432-1477),
    including `runContexts` bind/release into the `localWorkGraphRuns` map
    (lines 1450-1465).
  - Embedded-runtime session event tap `onSessionMetaEvent` (lines 1309-1316)
    — receives compat events from EVERY harness session hosted by an embedded
    workspace runtime (wired through
    `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:140`
    `onCompatEvent: configuredOnSessionMetaEvent`).
  - `globalBus` publishers: engine upstream events only (line 1369, gated on
    `opencodeCompat`), plus process events and worktree compat routes —
    embedded-runtime harness sessions do NOT reach `globalBus`.
  - Intake wiring (lines 1738-1755): `subscribeSessionIntake({ events:
    globalBus, opencodeRequest, ... })`.

### The three OpenCode privileges this plan removes

1. `session-gateway.ts:250-253`:

   ```ts
   admit: async (input) => {
     if (input.profile.harness === "opencode") return v2.admit(input)
     if (input.profile.connectionIds.length > 0) {
       throw new Error("Connection-bound Runs currently require the OpenCode harness")
     }
   ```

2. `session-intake.ts` — engine-only event source and session read-back.
3. `local/execution-capabilities.ts` — `connectionTools: false` on every
   non-OpenCode harness entry.

### Repo conventions that apply

- No fallbacks without explicit request; keep one implementation per
  responsibility (root `CLAUDE.md`). U2 therefore adds a SECOND intake
  subscription with its own reader, not a try-engine-then-runtime fallback
  inside one path.
- Follow the existing broker trust pattern: run-tool identity is validated
  against a server-authored registry (`localWorkGraphRuns` +
  `requireLocalMasterIdentity`, app.ts:1587-1599), never trusted from the
  session.

## Commands you will need

| Purpose | Command (from repo root) | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck (all) | `bun turbo typecheck` | exit 0 |
| claxedo-server tests (targeted) | `cd packages/claxedo-server && node ./node_modules/vitest/vitest.mjs run src/hosts/workgraph` | all pass |
| workgraph package tests | `cd packages/workgraph && node ./node_modules/vitest/vitest.mjs run src/runtime-adapter` | all pass |
| Full claxedo-server suite | `cd packages/claxedo-server && bun run test` | all pass |

## Scope

**In scope** (the only files you should modify):

- `packages/claxedo-server/src/hosts/workgraph/composition/session-gateway.ts` (+ its tests)
- `packages/claxedo-server/src/hosts/workgraph/session-intake.ts` (+ tests)
- `packages/claxedo-server/src/hosts/workgraph/local/execution-capabilities.ts` (+ tests)
- `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` (composition wiring only)
- `packages/claxedo-server/src/deployments/self-hosted-node/capabilities.ts`
- `packages/workgraph/src/runtime-adapter/*` ONLY if a contribution option is
  missing (verify first — the connection contribution already exists)
- New test files beside the files above

**Out of scope** (do NOT touch, even though they look related):

- `createSessionV2WorkGraphGateway` internals — the OpenCode harness keeps its
  durable V2 rail in this plan; unifying it is deferred (see Maintenance
  notes).
- `packages/claxedo-server/src/hosts/workgraph/hosted/**` — the hosted path is
  already engine-free.
- `packages/claxedo-server/src/hosts/workgraph/composition/agent-tools.ts` —
  engine application tools for interactive OpenCode sessions; owned by plan
  2026-08-19-003.
- `packages/claxedo-server-core/src/opencode/engine.ts` — owned by plans 002/003.
- Anything under `packages/opencode` or other vendored engine packages.

## Implementation units

### U1 — Connection-bound Runs on every harness

**U1.1** In `capabilities.ts`, extend `selfHostedCapabilities` input with a
`workGraphConnectionBroker: WorkGraphConnectionOperationBroker` (exported from
`@claxedo/workgraph/runtime-adapter`) and pass it through:

```ts
runtimeRouteContributions: workGraphRuntimeRouteContributions({
  run: { broker: input.workGraphRunBroker },
  connection: { broker: input.workGraphConnectionBroker },
}),
```

First read `connectionContribution` in
`packages/workgraph/src/runtime-adapter/index.ts` to confirm the option name
and whether a contribution mounted WITHOUT a broker currently returns 503 on
bind (expected). If the connection contribution requires a `brokerOrigin` /
central-token flow that cannot be satisfied by an in-process broker, STOP.

**U1.2** In `app.ts`, build the local connection broker next to the existing
run broker composition (near lines 1432-1477):

- Add a `localWorkGraphConnections` registry mirroring `localWorkGraphRuns`:
  keyed by `sessionId`, holding `{ identity, context, ownerPartition,
  connectionIds, tools }`, populated/released by the gateway (U1.3).
- Implement the broker with `createConnectionOperationBroker` (already used in
  `session-gateway.ts:559-564`) whose `bindings.resolve` looks up the registry
  entry for the operation's `identity.sessionId` and rejects on identity
  mismatch — same trust posture as `requireLocalMasterIdentity`.
- Reuse the existing PR receipt pipeline options (`authorizePullRequest`,
  `pullRequestEffects`, `recordPullRequest`) exactly as the V2 gateway wires
  them (`session-gateway.ts:565-610` region) so the fail-closed PR
  confirmation gate is preserved verbatim on the new path.

**U1.3** In `createHarnessWorkGraphGateway.admit`:

- Delete the `connectionIds.length > 0` throw (lines 251-253).
- After the run-binding POST (lines 308-319), when
  `input.profile.connectionIds.length > 0`, validate the same preconditions the
  V2 gateway enforces (`options.connections` present, owner context present,
  team owner partition resolvable, explicit connection tools — mirror
  `session-gateway.ts:540-549`), register the binding in
  `localWorkGraphConnections` (via a new gateway option, symmetrical to
  `runContexts`), and POST to the runtime:

  ```
  POST /api/workgraph/connection-binding
  { version: 1, identity, connectionIds, tools, brokerUrl: "http://127.0.0.1" }
  ```

  with the same `request(binding, path, init)` helper used for run-binding.
- Extend `cleanupRunBinding` (line 235) to also DELETE
  `/api/workgraph/connection-binding/:sessionId` and release the registry
  entry.

**Verify**:
`cd packages/claxedo-server && node ./node_modules/vitest/vitest.mjs run src/hosts/workgraph` → pass, including new tests (see Test plan).
`grep -n "currently require the OpenCode harness" src/hosts/workgraph -r` → no matches.

### U2 — Session intake for every harness

**U2.1** In `session-intake.ts`, replace the hard `opencodeRequest` +
`OPENCODE_INTERNAL_BASE` coupling with a reader port:

```ts
type IdleSessionReader = (sessionId: string, directory: string) => Promise<IdleSessionProjection>
```

Keep `readIdleSession` as the engine-backed implementation of that port
(unchanged behavior, same file or an adjacent export), and add a
runtime-backed implementation that issues the same two reads
(`/session/:id`, `/session/:id/message?limit=100`) against a caller-supplied
`(directory, request) => Promise<Response>` — the exact `sessionRequest` shape
already used by the harness gateway. The message-shape parsing
(`messageText`, line 93) is the compat shape both surfaces serve; verify with
one runtime-backed test before assuming.

**U2.2** In `app.ts` intake wiring (lines 1738-1755), add a SECOND
subscription alongside the existing `globalBus` one: subscribe the
embedded-runtime session tap to intake. The tap already exists —
`onSessionMetaEvent` (line 1309) receives every embedded-runtime harness
session's compat events. Route `session.status`/idle events from that tap into
the same `intake.onIdle` flow, using the runtime-backed reader with
`workgraphRuntime(event.directory)`-style access (reuse the existing
`sessionRequest` closure; do not create a new runtime-acquisition path).
Guard against double-projection for OpenCode sessions (they surface on BOTH
buses when `opencodeCompat` is on): dedupe on `sessionId` at the intake
boundary, or filter engine-originated session ids from the tap path —
whichever `createSessionIntakeService`'s idempotency already guarantees;
confirm by reading `packages/workgraph/src/**/session-intake*` service code
first, and write the dedupe test either way.

**Verify**: new tests pass; existing intake tests unchanged and passing.

### U3 — Capabilities catalog: connection tools everywhere, engine read scoped

**U3.1** In `local/execution-capabilities.ts`, drop `connectionTools: false`
from the session-composer harness entries and the Pi entry (lines 79, 86) so
connection tools are advertised uniformly (the port's `connectionToolIds`
already carries the ids, line 131). Check
`packages/claxedo-server/src/hosts/workgraph/execution-capabilities.ts`
(`createExecutionCapabilitiesPort`) for what `connectionTools: undefined`
means before deleting — if absence does not default to "available", set
`connectionTools: true` explicitly.

**U3.2** Leave the OpenCode catalog reads (`runtimeJson` → `/agent`,
`/api/model`, `/experimental/tool/ids`) on `opencodeRequest` in this plan —
they describe the OpenCode harness itself and are re-homed by plan
2026-08-19-003. Add a comment marking that ownership so nobody "fixes" it
twice.

**Verify**: `cd packages/claxedo-server && node ./node_modules/vitest/vitest.mjs run src/hosts/workgraph` → pass. A composer-catalog test asserts every harness entry now advertises connection tools.

## Test plan

Model new tests on the existing patterns in
`packages/claxedo-server/src/hosts/workgraph/**/*.test.ts` (vitest, in-process
Hono apps, no network). Cover at minimum:

1. **U1 happy path**: admit a Run with `connectionIds` on a non-opencode
   harness → session created via `sessionRequest`, connection-binding POST
   observed with the exact bind schema, run completes, cleanup DELETEs the
   binding and releases the registry entry.
2. **U1 trust**: a connection operation whose identity does not match the
   registered binding is rejected by the broker.
3. **U1 PR gate**: a non-draft `connection_code_host_open_pr` on a public repo
   without the receipt pipeline configured is denied
   (fail-closed parity with `session-gateway.ts:571-576`).
4. **U1 regression**: admit with `connectionIds` on the `opencode` harness
   still routes through the V2 gateway unchanged.
5. **U2**: an idle `session.status` compat event from the embedded-runtime tap
   for a claude-harness session produces an intake projection with title,
   summary, and directory; the same session id arriving on both buses projects
   once.
6. **U3**: capability catalog lists connection tools for all harness entries.

## Done criteria

All must hold:

- [ ] `bun turbo typecheck` exits 0.
- [ ] `cd packages/claxedo-server && bun run test` exits 0 (full suite).
- [ ] `grep -rn "currently require the OpenCode harness" packages/claxedo-server/src` → no matches.
- [ ] `grep -rn "connectionTools: false" packages/claxedo-server/src/hosts/workgraph/local` → no matches.
- [ ] New tests from the Test plan exist and pass.
- [ ] `git status` shows no modified files outside the in-scope list.
- [ ] Status row updated in `docs/plans/2026-08-19-000-opencode-just-another-harness-index.md`.

## STOP conditions

Stop and report (do not improvise) if:

- The excerpts in "Current state" don't match live code (drift since `c97fe21`).
- `connectionContribution` in `packages/workgraph/src/runtime-adapter` cannot
  operate with an in-process broker (e.g. it requires a signed central-token
  round trip with no local mode) — report the gap instead of building a
  parallel mechanism.
- The compat `session.status` idle event does not flow through the
  embedded-runtime `onCompatEvent` tap for ACP/native-SDK sessions (check
  `packages/agent-sdk-runtime/src/compat-events.ts` and `sse.ts`) — U2 needs a
  different event source and that choice belongs to a human.
- Connection tools cannot reach a non-opencode agent because the runtime
  contribution only exposes HTTP routes and no MCP/tool surface for that
  harness — verify how RUN tools reach harness sessions today (they use the
  same contribution mechanism) before concluding this; if run tools turn out
  to be broken for harness sessions too, that is a finding to report, not to
  fix silently here.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Deferred**: unifying the OpenCode V2 rail onto
  `createHarnessWorkGraphGateway` (deleting `createSessionV2WorkGraphGateway`
  and the engine's per-session dynamic tool injection). Do it only after plan
  2026-08-19-003 lands and the engine is reached exclusively through the
  OpenCode adapter; at that point the "Routes OpenCode through durable Session
  V2" split comment at `session-gateway.ts:196` becomes the deletion marker.
- Reviewers should scrutinize the trust boundary in U1.2: the broker must
  never resolve a binding from agent-supplied identity alone.
- If a future harness gains native dynamic tool registration (as the engine
  has), resist per-harness special cases — extend the contribution mechanism
  instead.
