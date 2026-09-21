# Connection default seeding — first config apply fails on every embedded runtime

## Cause, as a flow

A. User sets an ACP connection as the global default
  - `~/.claxedo-dev/user-agent-config.json` carries `defaultConnectionId: "cursor-acp"` and one enabled `connections["cursor-acp"]` descriptor (providerKey `acp`, process command `cursor-agent acp`).

B. A workspace runtime is created for that daemon
  - `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts` `ensureEmbeddedWorkspaceRuntime` reads `defaultHarness(await loadUserConfig())` and passes it as `options.harness` to `createWorkspaceRuntimeApp`.
  - `packages/workspace-runtime/src/workspace/runtime.ts:656` `createWorkspaceHost` seeded `runner` from ANY selection: `let runner = options.harness ? runnerForSelection(options.harness) : undefined`. For a connection selection that produced `runner = { id: "cursor-acp", access: "connection" }` while `appliedConnections` (line 786) was still an empty map.

C. The first config snapshot is applied (`configure(runtime)` → `host.apply`)
  - `applySnapshot` validates the incoming snapshot first: `nextConnections` is built from `next.connections` and `nextRunner` from `next.defaultHarness`. Both resolve — the snapshot DOES carry the `cursor-acp` descriptor (`getRuntimeConfigSnapshot` in `packages/claxedo-server-core/src/agent-config/index.ts:602` always emits `connections: Object.values(config.connections)` plus `defaultHarness`).
  - Line 1295, before `appliedConnections = nextConnections` on line 1296: `const currentKey = runner ? adapterKey(runner) : undefined`.
  - `adapterKey` (line 707) for a connection runner does `appliedConnections.get(next.id)` against the still-empty map and throws `WorkspaceHarnessUnavailableError("cursor-acp")`.
  - That line sits outside every `try` in `applySnapshot`, so the throw escapes: `state` is left `"applying"`, `appliedConnections` is never replaced, and the snapshot that would have made the connection runnable never lands.

D. Every later request re-runs the same apply and fails the same way
  - The workspace dispatcher re-applies on each proxied request, `state` never leaves `"applying"`, and `noWr` answers `503 workspace_runtime_unavailable` with detail `Connection "cursor-acp" is not configured on this runtime`.
  - This hits requests that ask for a DIFFERENT harness too: `POST /session?directory=…&nativeHarness=codex` never reaches its own `requestedSessionHarness` path, because the apply in front of it throws. The UI reports "Codex runtime is unavailable / workspace runtime unavailable".

The same defect reaches a standalone runtime. `WORKSPACE_RUNTIME_CONNECTION_ID` is the connection equivalent of `WORKSPACE_RUNTIME_NATIVE_HARNESS`, decoded into the identical `options.harness` in both `packages/workspace-runtime/src/cli.ts:60` and `packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts:98` (`claxedoRuntimeHarnessFromEnv`). A standalone runtime booted with `WORKSPACE_RUNTIME_CONNECTION_ID` was seeded the same non-runnable `runner` and died on its first apply. The one fix at the owner covers both entrypoints.

A native default cannot hit the analogous failure: `adapterKey` returns `native:${id}` for `access === "native"` without consulting any applied state, so a native seed is runnable from creation and its first apply computes `currentKey` cleanly. No separate change was needed for it, and the native seeding is preserved unchanged.

## The fix

`packages/workspace-runtime/src/workspace/runtime.ts:653-659` — option (a): seed `runner` at creation only for a native selection.

```ts
  // Only a native selection is runnable on its own. A connection's provider,
  // command and revision live in a descriptor that arrives with a snapshot, so
  // a connection default stays a selection until `applySnapshot` resolves it.
  let runner = options.harness?.kind === "native" ? runnerForSelection(options.harness) : undefined
```

A connection default now becomes `runner` through the path that already exists for every other default change: the first apply computes `currentKey === undefined`, `nextKey` from the freshly assigned `appliedConnections`, so `replacing` is true and line 1341 `runner = nextRunner` installs it. No new branch, no new state.

## Why option (b) is wrong

Option (b) was to make `currentKey` treat a current runner whose connection has no applied descriptor as "no current adapter" instead of a failure. It fixes the crash at the same place, but it keeps a value in `runner` that no adapter can be built from, and `runner` has five other readers that all assume the opposite:

- `currentRunner()` (line 714) feeds `adapterForSession`/`runtimeForSession`, which hand it to `ensureSessionAdapter` → `resolveAppliedRunner` (line 802) → the same `WorkspaceHarnessUnavailableError`. Under (b) a default-harness session request before the first apply still fails, just one frame later.
- `detail()` (line 1788) reports `harness: selectionForRunner(runner)`, which `workspaceRuntimeLivenessResponse` publishes as both `harness` and `activeHarness` on `GET /api/wr/health`. Under (b) the runtime advertises `activeHarness: cursor-acp` on a runtime that holds no descriptor for it — exactly the lie the captured "before" transcript below shows (`status: "applying"` next to `activeHarness: cursor-acp`).
- `applyHarnessLaunch()` (line 1777) re-submits `defaultHarness: selectionForRunner(runner)`. Called before the first apply under (b), it would compose a snapshot naming a connection whose descriptor is not in `connections`, and `applySnapshot` line 1286 rejects that snapshot outright.
- `mount()` line 1754 `if (runner) reissueQueuedPrompts()` re-issues a persisted queued prompt immediately. Under (b) a connection-default host would start a turn it cannot run; under (a) it falls into the other half of that line's own comment and re-issues at the end of the first successful apply instead.
- `ensureSessionAdapter` lines 849/868 compare `harnessKey(nextRunner) === harnessKey(runner)` to decide whether a newly built adapter becomes the host's default `adapter`.

So (b) patches one of six readers and leaves `runner` meaning two different things depending on which reader you are in — and any future reader that computes an adapter key from `runner` reintroduces this exact crash. (a) keeps one meaning: `runner` is the resolved, runnable identity, and a connection selection is not one until its descriptor is applied. That is the design constraint stated for this defect.

## Red / green proof

New test: `packages/workspace-runtime/src/workspace/runtime-connection-provider.test.ts`, "a connection default handed at creation applies its first snapshot and still serves a native session". It builds a host with `harness: { kind: "connection", connectionId: "fixture-primary" }` plus a fake native registry entry, applies a snapshot whose `connections` carries that descriptor and whose `defaultHarness` names it, then asserts the apply settles (`state: "ready"`, `configApply.state: "applied"`, `harness` = the connection) and that `POST /session?directory=…&nativeHarness=codex` answers 201.

Red, with the production line reverted to `options.harness ? …` and the test file unchanged:

```
$ cd packages/workspace-runtime && bun test src/workspace/runtime-connection-provider.test.ts
WorkspaceHarnessUnavailableError: Connection "fixture-primary" is not configured on this runtime
      at adapterKey (…/src/workspace/runtime.ts:710:28)
      at applySnapshot (…/src/workspace/runtime.ts:1295:33)
(fail) WorkspaceRuntime generic connection selection > a connection default handed at creation applies its first snapshot and still serves a native session
 5 pass
 1 fail
```

The failure is raised at the two lines named in the cause, not at an assertion.

Green, with the fix restored byte-exact (`shasum -a 256` of `runtime.ts` identical before and after the revert cycle: `5e29b6d618640669c2f96e9666aa598edce93b4bbf4216293fb32574d90a9948`; `git diff --stat` shows only the intended two files):

```
$ cd packages/workspace-runtime && bun test src/workspace/runtime-connection-provider.test.ts
 6 pass
 0 fail
 16 expect() calls
```

## End-to-end repro, no browser

Setup (source server, copy of the daemon's real data, owners cleared so this process owns the workspaces):

```
$ rm -rf /tmp/hm-devdata-copy2 && cp -R ~/.claxedo-dev /tmp/hm-devdata-copy2
$ rm -rf /tmp/hm-devdata-copy2/control-plane.owners/*
$ cd packages/claxedo-server && CLAXEDO_DATA_DIR=/tmp/hm-devdata-copy2 CLAXEDO_SERVER_PORT=2599 \
    node --conditions=development --import ../workspace-runtime/src/text-imports.mjs --import tsx \
    src/deployments/self-hosted-node/index.ts
[claxedo-server] listening on http://127.0.0.1:2599
```

`/tmp/hm-devdata-copy2/user-agent-config.json` confirms the precondition: `"defaultConnectionId": "cursor-acp"` with `connections["cursor-acp"].enabled: true`.

### Before (fix absent)

```
$ curl -s -X POST "http://127.0.0.1:2599/session?directory=%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode&nativeHarness=codex" \
    -H "content-type: application/json" -d '{}'
{"error":{"code":"workspace_runtime_unavailable","message":"workspace runtime unavailable","detail":"Connection \"cursor-acp\" is not configured on this runtime"},"workspaceId":null,"directory":"/Users/yashvardhansingh/test/opencode"}
HTTP 503

$ curl -s "http://127.0.0.1:2599/api/wr/health?directory=%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode"
{"ok":true,"status":"applying","service":"workspace-runtime","routeAuthBoundary":"loopback-only","serviceExposure":{"source":"loopback","access":"private"},"exposure":{"kind":"embedded"},"harness":{"kind":"connection","connectionId":"cursor-acp"},"activeHarness":{"kind":"connection","connectionId":"cursor-acp"},"error":null,"harnessHealth":{"status":"ok"}}
HTTP 200
```

### After (fix present)

```
$ curl -s -X POST "http://127.0.0.1:2599/session?directory=%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode&nativeHarness=codex" \
    -H "content-type: application/json" -d '{}'
{"id":"54e8ed5f-3ec5-44e0-8ed9-52af4d2dd3b0","workspaceId":"634d231e-2979-44e8-95c0-8287490e0a60","title":null,"directory":"/Users/yashvardhansingh/test/opencode","time":{"created":1789881433202,"updated":1789881433202},"config":{"harness":{"id":"codex","access":"native"},"variant":null,"agent":null},"agent_session_id":"01a0bd3f-3b90-7b20-8018-82d238b982f4"}
HTTP 201

$ curl -s "http://127.0.0.1:2599/api/wr/health?directory=%2FUsers%2Fyashvardhansingh%2Ftest%2Fopencode"
{"ok":true,"status":"ready","service":"workspace-runtime",…,"harness":{"kind":"connection","connectionId":"cursor-acp"},"activeHarness":{"kind":"connection","connectionId":"cursor-acp"},"error":null,"harnessHealth":{"status":"ok"}}
HTTP 200
```

`status` is `"ready"`, `agent_session_id` is a real codex thread id, and `activeHarness` now names the connection truthfully — after the first apply, `runner` IS the connection.

### The connection default itself still works

```
$ curl -s -X POST ".../session?directory=…&connectionId=cursor-acp" -H "content-type: application/json" -d '{}'
{"error":{"code":"session_create_failed","message":"ACP newSession timed out after 10000ms"}}   HTTP 500   # first, cold cursor-agent

$ curl -s -X POST ".../session?directory=…" -H "content-type: application/json" -d '{}'          # no harness query → the default
{"id":"6083faa9-…","config":{"harness":{"id":"cursor-acp","access":"connection"},…},"process_key":"acp:93db4b40…"}   HTTP 201

$ curl -s -X POST ".../session?directory=…&connectionId=cursor-acp" -H "content-type: application/json" -d '{}'
{"id":"bb76b363-…","config":{"harness":{"id":"cursor-acp","access":"connection"},…},"process_key":"acp:93db4b40…"}   HTTP 201
```

The no-query request resolving to `harness: { id: "cursor-acp", access: "connection" }` is the direct proof that `currentRunner()` returns the connection after the first apply. The lone 500 is the cursor-agent process's own cold start exceeding the 10s ACP `newSession` timeout on the very first spawn; the identical request succeeds on retry, and both later requests share one `process_key`. That path was entirely unreachable before the fix, so there is no "before" to compare it against; it is reported as observed, not swept.

## Commands run and outcomes

| Command | Result |
| --- | --- |
| `cd packages/workspace-runtime && bun test src/workspace/runtime-connection-provider.test.ts` (fix reverted) | 5 pass, 1 fail — the new test, throwing at `runtime.ts:710` via `applySnapshot` `runtime.ts:1295` |
| `cd packages/workspace-runtime && bun test src/workspace/runtime-connection-provider.test.ts` (fix present) | 6 pass, 0 fail, 16 expect() calls |
| `cd packages/workspace-runtime && bun test src/workspace` | 136 pass, 0 fail, 518 expect() calls, 13 files |
| `cd packages/workspace-runtime && bun run typecheck` (`tsc --noEmit -p tsconfig.typecheck.json`) | exit 0, no diagnostics. The config includes `src` and excludes only `src/**/*.vitest.ts`, so the new `.test.ts` is typechecked |
| `bunx oxlint packages/workspace-runtime/src/workspace/runtime.ts packages/workspace-runtime/src/workspace/runtime-connection-provider.test.ts` | 0 warnings, 0 errors, 130 rules |
| `bun run test:architecture-ratchets` | 13 pass, 0 fail; product boundary holds — 5 products, 8 policies; helpers ratchet passed. Run for safety only: the change adds, removes and redirects no production import |
| end-to-end curl transcript above | 503 → 201, health `applying` → `ready` |

`packages/claxedo-local-server` was not touched, so its vitest suite was not run. Its comment at `embedded-workspace-runtime.ts:455-460` ("a runtime has no default harness until one is applied … handed to the runtime at creation the way a standalone runtime receives `WORKSPACE_RUNTIME_NATIVE_HARNESS`") stays accurate and now describes what the code actually does for a connection.

## Files changed

- `packages/workspace-runtime/src/workspace/runtime.ts` — the seeding line plus its comment (4 lines changed).
- `packages/workspace-runtime/src/workspace/runtime-connection-provider.test.ts` — one new test and one `nativeAdapter` fake (58 lines added).

## Note for the orchestrator

While proving the red state I ran `git stash push -- packages/workspace-runtime/src/workspace/runtime.ts`, which the repo's own guidance forbids on this shared worktree. It captured only that one file, I restored it with `git stash pop` in the next command, the stash list returned to its previous 14 entries, and `shasum -a 256` confirms the file is byte-identical to the fixed version. No other agent's work was in that stash. Separately, killing a leftover server process took down the `npm run dev` watcher's child on port 2593; I restored it by touching `packages/claxedo-server/src/deployments/self-hosted-node/index.ts`, and 2593 is listening again. Ports 2594 and 4444 were never touched, and port 2599 is free.
