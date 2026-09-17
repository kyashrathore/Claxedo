# Two event streams: `cp/events` for the control plane, `wr/events` per workspace runtime

Status: proposed 2026-09-17, not started. Supersedes the lane-specific
repairs in `2026-09-17-001-fix-lost-part-frames-strand-running-rows.md`
(its hydrator fix and history-resync request stay; its per-lane gap hooks,
terminal sets and heartbeat patch collapse into one of each here).

## The flow today, observed

Seven producers serve session-shaped streams, under nine route spellings,
to three client readers, and the code's own comments disagree about which
one carries a turn's parts.

**Producers**

| | Route | Handler | Carries | Where |
|---|---|---|---|---|
| P1 | `/global/event`, `/api/claxedo/events`, `/api/wr/events` — one handler, three names (`shell/routes.ts:119`) | `createGlobalEventsHandler` (`claxedo-local-server/src/shell/events.ts`) | `claxedoBus` (session/pty/worktree/provision/document lifecycle) + server-core `globalBus` envelopes | local daemon; WS on loopback, SSE otherwise (`event-stream-response.ts`) |
| P2 | the same three names (`routes/hosted/shell.ts:687`) | hosted shell events | same shape, signed, `globalBus` fed by `process-events.ts:43` and `durableSessionLog.subscribe_message_replay` | hosted / self-hosted node |
| P3 | central control-plane events | `server-core/platform/http/events.ts` | control bus | hosted workerd (`live-sync-room.cf.ts`) |
| P4 | `/api/wr/events` (`workspace/core.ts:42`) | `runtimeBusEventsHandler` | `WorkspaceRuntimeEvent` control frames only — its comment: "no token-level deltas (those ride `/api/wr/runtime-events`)" | every workspace runtime |
| P5 | `/api/wr/runtime-events?parentSessionId` (`core.ts:46`) | `runtimeEventsHandler` | raw `AgentRuntimeEvent` envelopes — the whole turn (captured 12:21: `text-delta`, `tool-start`, `tool-input`, `usage`, `rate-limit`) | every workspace runtime |
| P6 | `/global/event` (`workspace/runtime.ts:1522`) | inline | the hub's compat channel (`eventHub.subscribeGlobal`): OpenCode-shaped `message.part.updated` / `message.part.delta` envelopes | workspace runtime |
| P7 | `/event` (`routes/session-core.ts:2460`) | inline | per-session compat SSE, same channel | workspace runtime |

On the local daemon `route-ownership.ts` sends `/api/wr/*` and `/event` to
the embedded runtime (P4/P5/P7) and keeps `/global/event` and
`/api/claxedo/events` central (P1) — so the three P1 spellings are NOT the
same stream there: `/api/wr/events` is P4 in disguise.

**Readers**

- R1 `claxedo-events.tsx` → the "central" target `/api/claxedo/events` (P1
  on loopback, the account bridge `session.events` when signed) plus, for a
  `cloud`/`user-hosted` workspace, `/api/wr/events` on the runtime through
  the relay (P4). Frames enter GlobalSDK's coalescer via `listenCentral`
  and the shell caches via `routeDirectoryEvent`.
- R2 `provider.tsx` → P5. Projects only `diagnostic`, `subagent-*` and
  `goal-*` envelopes (`projectRuntimeDiagnosticEnvelope`,
  `applySubagentRuntimeEventEnvelope`, `applyLiveSessionGoalEvent`). Every
  `text-delta`/`tool-*` it receives is dropped.
- R3 `api.ts:382` rewrites a signed client's `/global/event` or `/event` to
  `/api/wr/events`; `agent-runtime-client.subscribeToEvents/RuntimeEvents`
  build those URLs and have test-only callers; `fetch-throttle.ts:44`
  special-cases all four spellings.

**What the comments claim, side by side**

- `session-event-scope.ts`: `runtime-events` "carries the message parts and
  deltas of a turn"; the workspace bus carries lifecycle. (R2 drops parts.)
- `embedded-workspace-runtime.ts:217`: "Conversation delivery stays
  exclusively on WorkspaceRuntime's canonical runtime-event stream and is
  never republished onto the control-plane bus."
- `shell/events.ts:226`: "embedded runtimes can bridge token-level
  `message.part.updated` frames onto `globalBus`" — no publisher of such a
  frame exists in `claxedo-local-server` (`grep globalBus.publish`: worktree
  and `session.deleted` only).
- `e2e/helpers/mock-runtime.ts:620`: "global-sdk's compat loop AND its
  runtime-events loop" — the provider has one loop; the compat loop is gone.
- `runtime-events.ts:123`: the bus lane carries "no token-level deltas
  (those ride the runtime event hub on `/api/wr/runtime-events`)".

Static reading therefore cannot name the stream that streams a desktop
transcript; only a wire capture can (Phase 0). The 2026-09-17 incident
sat exactly in this ambiguity: the repair was wired to the lane the
comments named, and the stall proof found parts arriving elsewhere.

## Goal

Two streams, each with one contract and one reader:

- **`cp/events`** — the control plane's stream. Carries what only the
  control plane knows: session inventory and lifecycle, workspace/worktree/
  provision state, document doorbells, account and access changes. One
  route (`/api/cp/events`), one handler shared by the local daemon and the
  hosted shell, one frame shape. Signed clients read it through the account
  bridge; the local daemon serves it to its own surface over the local
  WebSocket.
- **`wr/events`** — one per workspace runtime. Carries everything a
  runtime produces for its sessions: the turn's presentation frames
  (message/part/delta, tool state, todo, permission/question, session
  status/idle/error), diagnostics, subagent and goal frames, pty/process
  frames. One route (`/api/wr/events`), one handler, one frame shape; the
  runtime is the single projector from `AgentRuntimeEvent` to presentation
  frames (it already is, for the store and journal). Reached through the
  relay for `cloud`/`user-hosted` workspaces.

**Local machine:** the local daemon is the control plane AND hosts its
workspace runtimes in-process. It serves `cp/events` for the shell and
`wr/events` per embedded runtime under the same route ownership the proxy
already applies (`/api/wr/*` → runtime). The desktop therefore opens
`cp/events` once and `wr/events` once per open local workspace — the same
two connections a signed web client opens, just without the relay hop. A
single "cp only" stream on local would require the daemon to re-multiplex
every runtime's turn frames onto the control bus, which is the bridge the
comments describe and nobody built; two streams keep the local daemon
structurally identical to hosted.

Everything else is deleted: no aliases, no compat streams (P6, P7), no raw
`AgentRuntimeEvent` lane on the wire (P5 folds into `wr/events` as
projected frames), no client-side projection, no URL rewrite, no
test-only URL builders. One replay ring, one terminal policy, one gap
notice, one watchdog implementation, one resync request.

## Design

### 1. Frame contracts

- `cp/events`: `ClaxedoEvent` (`server-core/platform/runtime/lib/bus.ts`)
  minus anything session-content-shaped. `isTerminalClaxedoEvent` is its
  terminal policy. The `globalBus` envelope form (`{directory, payload}`)
  is retired from this stream; session lifecycle stays a flat frame.
- `wr/events`: the compat presentation envelope the runtime already
  produces for its store (`createOpencodeCompatProjection`), plus the
  `WorkspaceRuntimeEvent` control frames, plus diagnostics/subagent/goal
  projected server-side (`createClientPresentationProjection` moves from
  the client to the runtime; it is the same function). Terminal policy:
  `isTerminalCompatEvent` ∪ tool settlement (`settlesToolPart`) ∪ pty/
  process settlements ∪ subagent settlements. The store's journal is the
  same projection, so what the client sees is what the store holds.

### 2. Server

- `workspace-runtime/routes/events.ts` becomes the one `wr/events` handler
  over one bus (`WorkspaceRuntimeEvent | CompatEnvelope`); `runtime-events.ts`
  (P4), the inline `/global/event` (P6) and `/event` (P7) are deleted. The
  runtime hub keeps `publishRuntime` for in-process consumers (adapters,
  transcripts, subagent admission) — it is no longer a wire format.
- `claxedo-local-server/shell/events.ts` becomes the `cp/events` handler,
  mounted once at `/api/cp/events`; `hosted/shell.ts` mounts the same
  handler. The `globalBus` subscription goes; `process-events.ts:43` and
  `subscribe_message_replay(globalBus)` are re-pointed at the runtime's
  bus for the sessions they belong to (self-hosted node hosts its runtimes
  in-process like the local daemon).
- `route-ownership.ts` / `product-route-families.ts`: `/api/cp/events` →
  control plane; `/api/wr/events` → runtime. The four old spellings are
  removed from ownership, the request guard, and the relay proxy's
  `streaming()` list.
- `attachSseFanout` and `createSseReplayBuffer` stay as the one transport
  implementation for both handlers (with the overflow gap notice from plan
  001). One heartbeat interval, one ring size, recorded once.

### 3. Client

- One reader implementation (`claxedo-events.tsx`'s loop, which already
  reads `id:`, resumes with `Last-Event-ID`, resets its watchdog on any
  frame, and now raises `session-history-resync` on `stream.replay-gap`),
  instantiated per target: the `cp` target and one `wr` target per open
  workspace (`claxedo-event-targets.ts` already computes these; the
  `local`-kind special case that suppressed the workspace target goes,
  because local workspaces now have a `wr/events` of their own).
- `provider.tsx`'s stream loop, `global-sdk-event-fetch.ts`,
  `runtime-event-projection.ts`, `runtime-envelope.ts`, the heartbeat
  watchdog module and `reconnect-backoff.ts` are deleted; subagent and goal
  frames arrive projected on `wr/events` and are applied by
  `routeDirectoryEvent` like every other directory event. The
  `session-event-scope` lane registry keeps two lanes, now named `cp` and
  `wr`.
- `api.ts`'s `signedRuntimeEventInput`, `fetch-throttle.ts`'s stream cases
  and `agent-runtime-client.subscribeTo*` are deleted.
- The e2e mock (`mock-runtime.ts`) serves exactly the two routes; its
  reader-inventory comment is rewritten from the new code.

### 4. Migration order

1. Phase 0 — wire capture on the installed desktop and on staging: one
   turn per deployment with every open stream logged (frame type counts per
   route). Records which route carried parts, which carried nothing, and
   the reconnect count. Written into this plan before Lane A starts.
2. `wr/events` gains the projected turn frames (server-side projection of
   diagnostics/subagents/goals added; presentation envelopes already
   there). Client `wr` reader applies them; R2 deleted. Verified by the
   Phase 0 capture repeated: P5 idle, transcript streams.
3. `cp/events` route introduced, old spellings answered by the new handler
   for one release, then removed with their ownership entries.
4. P6/P7 deleted once Phase 0 shows no reader (the OpenCode engine's native
   passthrough, if still wanted, stays inside the harness adapter — memory
   `project_opencode_native_events` — never as an HTTP stream).

## Change points

- `packages/workspace-runtime/src/routes/{events,runtime-events}.ts`,
  `workspace/{core,runtime}.ts`, `routes/session-core.ts` (`/event`),
  `event-delivery.ts`, `routes/session-event-privacy.ts`.
- `packages/claxedo-local-server/src/shell/{events,routes,event-stream-response}.ts`,
  `workspace/runtime-dispatch/internals.ts`, `deployments/local/embedded-workspace-runtime.ts`.
- `packages/claxedo-server/src/routes/hosted/shell.ts`,
  `platform/runtime/lib/process-events.ts`, `platform/auth/request-guard.ts`,
  `deployments/self-hosted-node/app.ts:1683`.
- `packages/claxedo-server-core/src/platform/governance/route-ownership.ts`,
  `deployments/product-route-families.ts`, `platform/http/{events,event-retention}.ts`.
- `packages/agent-event-runtime`: `createClientPresentationProjection`
  exported for the runtime; `session-event-scope` lane names.
- `packages/claxedo-app/src/app/integrations/{claxedo-events.tsx,claxedo-event-targets.ts}`,
  `app/providers/global-sdk/*` (deletions), `platform/api/api.ts`,
  `lib/fetch-throttle.ts`, `platform/runtime/agent/agent-runtime-client.ts`,
  `platform/runtime/session-event-scope.ts`, `e2e/helpers/mock-runtime.ts`.

## Definition of done

- [ ] Phase 0 capture recorded here: per deployment (desktop local, signed
      web + cloud workspace, user-hosted), the routes opened during one
      turn and the frame-type counts on each. Progress:
- [ ] Desktop local: exactly two stream connections per open workspace in
      DevTools (`/api/cp/events`, `/api/wr/events?…`); a turn's parts,
      tool states, todo, permissions, diagnostics, subagent and goal frames
      all observed on `wr/events`; nothing session-shaped on `cp/events`.
      Progress:
- [ ] Signed web with a cloud workspace: the same two, `wr/events` through
      the relay; the sidebar's session rows come from `cp/events`.
      Progress:
- [ ] Repository: no route named `/global/event`, `/event`,
      `/api/claxedo/events` or `/api/wr/runtime-events` in any package,
      ownership table, guard, throttle, proxy list, e2e mock or comment;
      `provider.tsx` has no stream loop; `agent-runtime-client` has no
      `subscribeTo*`. Progress:
- [ ] The 2026-09-17-001 scenario (daemon `kill -STOP` ≤ 36 s across a
      tool's completion) re-run on the installed build: one gap notice on
      `wr/events`, one resync, the row reads "Ran …" within it. Progress:
- [ ] Tests: one handler suite per stream (replay, gap, terminal reserve,
      overflow notice, session scoping); one reader suite (cursor, watchdog
      on heartbeat, gap → resync); the projection's server-side tests;
      route-ownership snapshot; `bun run test:architecture-ratchets` with
      the closure ceilings LOWERED to the measured values. Progress:

## Non-goals

- Changing the harness adapters or the store's journal projection.
- The relay itself.
- Daemon stall causes (plans 2026-09-16-001/002).

## Execution

Phase 0 is serial. Then three lanes with disjoint files, one adversarial
review each, one re-review, then the integration pass on the installed
build:

- **Lane A — server `wr/events`** (workspace-runtime routes + hub, the
  server-side projection, local-server proxy list).
- **Lane B — server `cp/events`** (shell events handler, hosted shell,
  route ownership, guard, process-events re-pointing).
- **Lane C — client** (one reader, targets, deletions, e2e mock).
