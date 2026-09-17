# Two event streams: `cp/events` for the control plane, `wr/events` per workspace runtime

Status: proposed 2026-09-17, reviewed adversarially the same day (findings
folded in below), not started. Supersedes the lane-specific repairs in
`2026-09-17-001-fix-lost-part-frames-strand-running-rows.md` (its hydrator
fix and history-resync request stay; its per-lane gap hooks, terminal sets
and heartbeat patch collapse into one of each here).

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
transcript, and the live runs of 2026-09-17 saw none do it: against the
standalone local-server the client sat at 3,847 chars while the server held
17 KB; against the desktop daemon every text jump coincided with a REST read
(the seven accepted-prompt polls, then the plan-001 resync). The proven
defect behind the "Running" rows is therefore plan 001's D.2 — a history
read could not advance a part the client already held — and the transport
repairs in that plan rest on an unproven premise. Phase 0 (a wire capture
on the installed desktop) decides whether `wr/events` has to GAIN parts or
merely become reachable.

What already exists and the first draft of this plan missed: the runtime
runs `createClientPresentationProjection` itself, per turn
(`workspace-runtime/src/session/service.ts:404`), and publishes the result
on the hub's compat channel — that channel IS the presentation stream this
plan wants on `wr/events`, and today it is served only by P6 and P7, which
route ownership shadows on the local daemon. §2 is a re-route, not a new
projection.

## Goal

Two streams, each with one contract and one reader:

- **`cp/events`** — the control plane's stream. Carries NOTICES: something
  in the session inventory, a workspace, a worktree, a provision, a
  document, a share grant, or the account changed; the reader re-reads.
  Never a session's content. One route (`/api/cp/events`), one handler
  shared by the local daemon and the hosted shell, one frame shape. Signed
  clients read it through the account bridge; the local daemon serves it
  over the local WebSocket. This is what hosted does today
  (`LiveSyncRoom` nudges); local converges on it.
- **`wr/events`** — one per workspace runtime, reached through the relay
  for `cloud`/`user-hosted`. Carries everything a runtime produces for its
  sessions: presentation frames (message/part/delta, tool state, todo,
  permission/question, status/idle/error), diagnostics, subagent and goal
  frames, pty/process frames. The runtime is the single projector from
  `AgentRuntimeEvent` (it already is, for the store). Two arms, decided by
  WHO is asking, not by deployment:
  - the workspace's owner (workspace access) → one workspace-wide
    connection: every session and every session-less frame;
  - a share grantee (session share, no workspace access) →
    `wr/events?sessionID=…`, that session only, under the session lease
    the runtime already mints. Sharing keeps streaming live from the
    runtime; nothing about it changes.

**Local machine:** the local daemon is the control plane AND hosts its
workspace runtimes in-process. It serves `cp/events` for the shell and
`wr/events` per embedded runtime under the same route ownership the proxy
already applies (`/api/wr/*` → runtime). The desktop opens `cp/events`
once and `wr/events` once per open local workspace — the same two
connections a signed web client opens, minus the relay hop. Session
lifecycle stops riding the runtime bus into the central stream (today
`claxedoBus` is the runtime bus under another name, `server-core bus.ts:141`,
which is the double delivery `claxedo-event-targets.ts:122` dodges); the
local sidebar learns of a new session the way hosted does, by a notice and
a read.

Everything else is deleted: no aliases, no raw `AgentRuntimeEvent` lane on
the wire (P5 folds into `wr/events`), no client-side projection, no URL
rewrite, no test-only URL builders. One replay ring per runtime scope, one
terminal policy, one gap notice, one watchdog implementation, one resync
request.

Two properties the plan is not done without:

- **Proven end to end, by tests that run.** Every flow this plan claims —
  a turn streaming on `wr/events` on each deployment, an owner's
  workspace-wide stream and a grantee's session-scoped one through the
  relay, a `cp/events` notice landing a new session in the sidebar, a gap
  notice repairing a stalled stream, a cursor-less first open — is
  exercised by an e2e spec against the real handlers (Tier R, not the
  whole-server mock), and the spec is green in CI. Unit tests on the
  handlers and the reader support that; they do not replace it.
- **Nothing else left, and the two that remain are coherent.**
  "Simplified to two streams" means no route, handler, bus alias, URL
  builder, rewrite, throttle case, proxy list entry, ownership entry, e2e
  mock route, fixture, type, constant, memory note or comment names or
  describes a third stream, a compat stream, an alias spelling, or a
  client-side projection of runtime events — and, stronger, that a
  reader of the code arrives at ONE account of the system: which stream
  carries what, who may open it, where each frame is produced, where it
  is consumed, and what happens when it is lost. A grep over retired
  names is the floor, not the proof; the proof is review. After the
  code lands, independent reviewers each read the whole event path end
  to end (producer → bus → handler → transport → reader → store) on
  every deployment, adversarially, with the brief "find any place where
  two mechanisms answer the same question, any responsibility that is
  split or duplicated, any comment or name that describes a stream that
  no longer exists, any frame whose owner is ambiguous". Every finding
  is fixed; then a second, fresh review of the fixed tree; the plan is
  done only when a round returns nothing (two rounds at minimum, per the
  house rule of review + re-review before reporting). The closure
  ceilings are lowered to the measured values, not left with the deleted
  modules' headroom.

## Design

### 1. Frame contracts

- `cp/events`: notices only — `session.lifecycle` (created/deleted/
  updated, the id and workspace, no content), `workspace.*`, `worktree.*`,
  `provision`, `document.changed`, `session.share.changed`, account/access
  changes. Terminal policy: all of them (each is a settlement nothing
  re-states). The `globalBus` envelope form (`{directory, payload}`) is
  retired from this stream.
- `wr/events`: the compat presentation envelope the runtime already
  publishes on its hub channel (`createOpencodeCompatProjection` /
  `createClientPresentationProjection`, `service.ts:404`) plus the
  `WorkspaceRuntimeEvent` control frames (P4's bus) plus diagnostics,
  subagent and goal frames projected the same way. Terminal policy:
  `isTerminalCompatEvent` ∪ tool settlement (`settlesToolPart`) ∪ pty/
  process settlements ∪ subagent settlements. The store's journal is the
  same projection, so what the client sees is what the store holds.
- Scope on `wr/events` (`authorizeSessionEventScope`): try workspace
  authority first (`authorizeHost`, role ≥ viewer) → workspace-wide; else
  require `sessionID` and the session stream lease (`authorizeStream`) →
  session-scoped; else 400 as today. The policy marker `managed-private`
  keeps meaning "ask the control plane"; it stops meaning "every stream is
  a session".

### 2. Server

- `workspace-runtime/routes/events.ts` becomes the one `wr/events` handler
  over one source: the hub's compat channel (`eventHub.subscribeGlobal`,
  today P6's source at `workspace/runtime.ts:646`) merged with the control
  bus (`workspaceRuntimeBus`, today P4's). `runtime-events.ts` (P4's
  handler), the inline `/global/event` (P6) and `/event` (P7) are deleted;
  `runtimeEventsHandler` (P5) leaves the wire — the hub keeps
  `publishRuntime` for in-process consumers (adapters, transcripts,
  subagent admission), it is no longer a wire format. Diagnostics, subagent
  and goal envelopes are projected where the turn driver already projects
  everything else, so the hub's compat channel carries them.
- Retention is per runtime scope (`createIdentityAwareEventSource` already
  keeps one ring per principal scope), sized for whole-part payloads with
  the terminal reserve for settlements — one setting, recorded once, not
  shared with `cp/events`. This keeps `shell/events.ts:226`'s warning (a
  central ring pinning a long turn's parts for the process lifetime) true
  by construction: the central ring holds notices only.
- `claxedo-local-server/shell/events.ts` becomes the `cp/events` handler,
  mounted once at `/api/cp/events`; the hosted shell mounts the same
  handler over `LiveSyncRoom`. Its `globalBus` subscription goes;
  `process-events.ts:43` and `subscribe_message_replay(globalBus)` are
  re-pointed at the runtime's channel for the sessions they belong to.
  `publishSessionLifecycle` publishes a notice to the control-plane bus,
  not a frame to the runtime bus.
- `route-ownership.ts` / `product-route-families.ts`: `/api/cp/events` →
  control plane; `/api/wr/events` → runtime. The four old spellings are
  removed from ownership, the request guard, and the relay proxy's
  `streaming()` list.
- `attachSseFanout` and `createSseReplayBuffer` stay as the one transport
  implementation for both handlers (with the overflow gap notice from plan
  001).

### 3. Client

- One reader implementation (`claxedo-events.tsx`'s loop, which already
  reads `id:`, resumes with `Last-Event-ID`, resets its watchdog on any
  frame, and raises `session-history-resync` on `stream.replay-gap`),
  instantiated per target: the `cp` target and one `wr` target per open
  workspace. `claxedo-event-targets.ts` loses the `local`-kind exclusion
  (local workspaces now have a `wr/events` of their own) and the
  `sessionAuthority` branch for the owner: an owner opens the workspace
  stream without a session id everywhere; the session-scoped form stays
  for a grantee reading a shared session.
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
   turn per deployment with every open stream logged (route, frame-type
   counts, reconnect count) and the mid-turn history polls disabled for
   the run, so a transcript that advances proves a stream did it. Written
   into this plan before Lane A starts. If the desktop shows no stream
   carrying parts, the first cut is simply un-shadowing the hub channel
   on `/api/wr/events` (§2) — and plan 001's "frames lost on the wire"
   narrative is corrected to "no wire".
2. `wr/events` = hub channel + control bus, with the two-arm scope; client
   `wr` reader applies it; P5 deleted from the wire; R2 deleted. Verified
   by the Phase 0 capture repeated: transcript streams, no polls needed.
3. `cp/events` route introduced as notices; session lifecycle moved to a
   notice; old spellings answered by the new handler for one release, then
   removed with their ownership entries.
4. P6/P7 deleted (the OpenCode engine's native passthrough, if still
   wanted, stays inside the harness adapter — memory
   `project_opencode_native_events` — never as an HTTP stream).

## What this keeps and what it deletes from 2026-09-17-001 (`71504ab131`)

| Plan 001 piece | Here |
|---|---|
| §1 hydrator: `resolveStoredParts` hands the server row through; `mergeChatPart` decides — the change that healed the "Running" rows | Kept unchanged; it is what lets any re-read advance a part |
| §2 `session-history-resync` request + the controller effect | Kept; the one resync trigger, raised by the one reader on `stream.replay-gap` |
| §2 the hook in `claxedo-events.tsx` | Kept; that loop is the surviving reader |
| §2 `provider.tsx` no-abort-on-gap, heartbeat → watchdog, `resetRuntimeReplayGapState`, the `event-router` diagnostic → resync | Deleted with the runtime lane |
| §3 `attachSseFanout` overflow gap notice | Kept; one transport for both streams |
| §3 `settlesToolPart` (central) / `isTerminalRuntimeEvent` tool settlements (runtime) | The first becomes `wr/events`' terminal policy; the second is deleted with P5 |
| 001's open DoD row (central-lane gap → resync, live) | Absorbed by Phase 0 and the stall e2e spec, polls disabled |
| 001's non-goal: cursor-less first open loses the reply | A DoD row here |

001's transport narrative (frames lost on the wire) is not carried as a
diagnosis; Phase 0 either confirms it or records "no wire".

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
      turn, the frame-type counts on each, and — with mid-turn history
      polls disabled — whether the transcript advanced. Progress:
- [ ] Desktop local: exactly two stream connections per open workspace in
      DevTools (`/api/cp/events`, `/api/wr/events?…`); with polls
      disabled, a turn's parts, tool states, todo, permissions,
      diagnostics, subagent and goal frames all observed on `wr/events`
      (counts > 0 per type exercised); nothing session-shaped on
      `cp/events`; a new session appears in the sidebar from a
      `cp/events` notice. Progress:
- [ ] Signed web with a cloud workspace: the owner opens ONE `wr/events`
      through the relay with no session id and sees every session and the
      pty frames; a share grantee in another account opens
      `wr/events?sessionID=…` for the shared session and nothing else,
      and an unscoped attempt by the grantee is refused. Progress:
- [ ] Repository: no route named `/global/event`, `/event`,
      `/api/claxedo/events` or `/api/wr/runtime-events` in any package,
      ownership table, guard, throttle, proxy list, e2e mock or comment;
      `provider.tsx` has no stream loop; `agent-runtime-client` has no
      `subscribeTo*`; `claxedo-event-targets.ts` has no `local`-kind
      exclusion. Progress:
- [ ] The 2026-09-17-001 scenario (daemon `kill -STOP` ≤ 36 s across a
      tool's completion) re-run on the installed build with polls
      disabled: one gap notice on `wr/events`, one resync, the row reads
      "Ran …" within it. Progress:
- [ ] A cursor-less FIRST open during a stall (plan 001's non-goal): the
      reader's bootstrap heartbeat carries the cursor and the reader's
      first `session-history-resync` fires after the stream opens, so the
      reply's `message.updated` is read rather than lost. Progress:
- [ ] E2E, real handlers (Tier R harness, not `mock-runtime.ts`): one spec
      per claimed flow — desktop-local turn streams on `wr/events`;
      owner workspace-wide + grantee session-scoped through the relay
      (grantee's unscoped attempt refused); `cp/events` notice → sidebar
      row; stall → gap notice → resync → row settles; cursor-less first
      open → resync reads the reply. All green in CI on the merge commit.
      Progress:
- [ ] Nothing else left (floor): a grep over the retired names —
      `/global/event`, `/event`, `/api/claxedo/events`,
      `/api/wr/runtime-events`, `runtimeEventsHandler`,
      `runtimeBusEventsHandler`, `createGlobalEventsHandler`'s three
      mounts, `signedRuntimeEventInput`, `subscribeToEvents`,
      `subscribeToRuntimeEvents`, `projectRuntimeDiagnosticEnvelope`,
      `resetRuntimeReplayGapState`, `runtime-event-projection`,
      `global-sdk-event-fetch`, `heartbeat-watchdog`, `reconnect-backoff`,
      `CLAXEDO_EVENTS_RELAY_PATH`, the `globalBus` envelope form on the
      central stream, "compat loop", "compat stream", "three spellings" —
      returns zero hits across `packages/*/src`, `packages/*/e2e`,
      `packages/*/scripts`, `script/`, `docs/` (outside this plan and plan
      001) and the memory index. Progress:
- [ ] System coherent (proof): consistency reviews of the landed tree, each
      by a reviewer who did not write the code, each covering the full
      producer → bus → handler → transport → reader → store path on desktop
      local, signed web + cloud, and user-hosted, with the adversarial
      brief above. Round 1 findings fixed; round 2 on the fixed tree;
      further rounds until a round returns zero findings. Each round's
      findings, fixes and the zero-finding report are recorded here with
      the commit they reviewed. Progress:
- [ ] One written account of the system exists and matches the code: the
      module comments on the two handlers, the two reader targets and
      `session-event-scope.ts` describe the same two streams, the same
      owner/grantee arms and the same notice/frame split, in present tense,
      with no history narration; the review rounds above confirm no other
      description of the event system survives anywhere. Progress:
- [ ] Tests: one handler suite per stream (replay, gap, terminal reserve,
      overflow notice, owner vs grantee scope); one reader suite (cursor,
      watchdog on heartbeat, gap → resync); route-ownership snapshot;
      `bun run test:architecture-ratchets` with the closure ceilings
      LOWERED to the measured values. Progress:

## Non-goals

- Changing the harness adapters or the store's journal projection.
- Changing how a share is granted or who may read a shared session: the
  control plane's `session_share_grants` and the runtime's session lease
  stay as they are. Only the owner's stream stops being session-scoped.
- The relay itself.
- Daemon stall causes (plans 2026-09-16-001/002).

## Execution

Phase 0 is serial. Then three lanes with disjoint files, one adversarial
review each and one re-review per lane, the integration pass on the
installed build, and then the whole-system consistency rounds from the DoD
(reviewers who wrote none of the lanes; repeat until a round is clean):

- **Lane A — server `wr/events`** (workspace-runtime routes + hub, the
  server-side projection, local-server proxy list).
- **Lane B — server `cp/events`** (shell events handler, hosted shell,
  route ownership, guard, process-events re-pointing).
- **Lane C — client** (one reader, targets, deletions, e2e mock).
