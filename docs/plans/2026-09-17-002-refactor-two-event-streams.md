# Two event streams: `cp/events` for the control plane, `wr/events` per workspace runtime

Status: proposed 2026-09-17, reviewed adversarially the same day (findings
folded in below); landed the same day on `refactor/two-event-streams`
(worktree `~/test/opencode-streams`, from `dev` `98d2930eef`); the review
rounds are recorded under "Execution". Supersedes the lane-specific repairs in
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
(the daemon's; a signed desktop the hosted control plane's too, through the
account bridge) and `wr/events` for the workspace the route names — the
same connections a signed web client opens, minus the relay hop. Session
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

- `cp/events`: notices only — `worktree.*`, `provision`,
  `document.changed`, `session.share.changed` (the `ControlPlaneEvent`
  union in `server-core/platform/runtime/lib/bus.ts`). Terminal policy:
  all of them (each is a settlement nothing re-states). The `globalBus`
  envelope form (`{directory, payload}`) is retired from this stream.
  `session.lifecycle` is NOT a notice (a deviation from the first draft,
  decided while landing): it is the runtime's own create protocol —
  `creating` / `created` / `failed` with the composer's `draftId`, which
  `features/session/submit/create-with-lifecycle.ts` reconciles the HTTP
  create against — so only the runtime that ran the create can publish it,
  and it rides that workspace's `wr/events` as a control frame. A control
  plane could only ever re-announce `created` after its projection pull,
  without the draft or the failure. The stream a frame rides is decided by
  who produces it. On a route with no workspace (Tasks, Marketplace, a home
  route with nothing to reopen) no `wr/events` is open, so the control
  plane's own inventory rings instead:
  `session.inventory.changed` (workspace-scoped, no session named) is
  published by the session-meta store's writers when a workspace's
  projection gains or loses a row — a create from a second window, the
  CLI, an MCP- or Telegram-driven client, or a delete — and the reader
  refetches the list and inventory, which apply access. A retitle rings
  nothing; that is the runtime's `session.updated` on `wr/events`.
- `wr/events`: the compat presentation envelope the runtime already
  publishes on its hub channel (`createOpencodeCompatProjection` /
  `createClientPresentationProjection`, `service.ts:404`) plus the
  `WorkspaceRuntimeEvent` control frames (P4's bus) plus diagnostics,
  subagent and goal frames projected the same way. Terminal policy:
  `isTerminalCompatEvent` ∪ tool settlement (`settlesToolPart`) ∪ pty/
  process settlements ∪ subagent settlements. The store's journal is the
  same projection, so what the client sees is what the store holds.
- Scope on `wr/events` (`authorizeSessionEventScope`): try workspace
  authority first (`authorizeHost`, role ≥ viewer) → the stream opens
  unscoped, on a WORKSPACE stream lease (session `"*"`) the control plane
  mints for the read, which the runtime holds per connection, presents for
  every session first seen on it (the request's own relay host token
  expires within a minute) and rolls on the delivery policy's renewal
  cadence; else require `sessionID` and the session stream lease
  (`authorizeStream`) → session-scoped; else 400 as today. On an unscoped
  stream every admitted principal — the workspace's owner included — is
  served the workspace's session-less frames and, through the per-session
  delivery policy, only the sessions the session authority grants it (an
  org owner or admin sees everything only because `hasPrivateAccess`
  grants it, per session). Workspace access alone unlocks no session
  (decided while landing: `host_read` admits every workspace share, so an
  admitted-means-everything arm leaked private sessions to a viewer; a
  round-1 owner bypass leaked them the same way and was removed). The
  refusal of the unscoped arm is named — 403 `workspace_event_stream_denied`
  — and the reader narrows to `?sessionID=` on that code alone, never on a
  relay's or the token mint's 403. The
  policy marker `managed-private` keeps meaning "ask the control plane"; it
  stops meaning "every stream is a session".

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
  keeps one ring per principal scope; a session-scoped connection's scope is
  its own, numbering only that session's frames), sized for whole-part
  payloads with the terminal reserve for settlements — the SDK ring's
  defaults (256 + 64, `agent-sdk-runtime/src/sse.ts`), not shared with
  `cp/events`. This keeps `shell/events.ts:226`'s warning (a
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
  instantiated per target: the `cp` target(s) and the `wr` target of the
  routed workspace. `claxedo-event-targets.ts` loses the `local`-kind exclusion
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
3. `cp/events` route introduced as notices; the inventory change became a
   notice while the create protocol stayed on `wr/events` (§1); the old
   spellings were removed outright with their ownership entries (landed:
   nothing answered them for a release).
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
      polls disabled — whether the transcript advanced. Progress: NOT
      captured on the installed desktop. Its role is taken by the Tier R
      spec "a turn's frames ride wr/events; cp/events carries no session
      frame" (real local stack, scripted Claude): `wr/events` opened
      unscoped, resumed by cursor; `message.updated`, `message.part.updated`,
      `message.part.delta` (the reply's text), `session.idle` on it;
      `cp/events` carried heartbeats and one `session.inventory.changed`.
      Signed web + cloud and user-hosted were not captured on a wire.
- [ ] Desktop local: exactly two stream connections on a workspace route in
      DevTools (`/api/cp/events`, `/api/wr/events?…`); with polls
      disabled, a turn's parts, tool states, todo, permissions,
      diagnostics, subagent and goal frames all observed on `wr/events`
      (counts > 0 per type exercised); nothing session-shaped on
      `cp/events`; a new session appears in the sidebar from a
      `cp/events` notice. Progress: the two connections and the frame
      types are the Tier R spec above (polls were not disabled; the
      assertions are on the wire, not on the transcript's source); the
      sidebar row from a `cp/events` notice is the Tier R spec "a session
      created elsewhere reaches the rail of a route with no workspace from a
      cp/events notice" (session created over HTTP while the browser sits on
      `/tasks`; `/` itself reopens the seeded project's route).
      Not checked in DevTools on the installed desktop build.
- [ ] Signed web with a cloud workspace: the owner opens ONE `wr/events`
      through the relay with no session id and sees every session and the
      pty frames; a share grantee in another account opens
      `wr/events?sessionID=…` for the shared session and nothing else,
      and an unscoped attempt by the grantee is refused. Progress: proven
      against the real relay-host-token policy in
      `two-user-runtime-transport.acceptance.test.ts` (owner and
      participant read the workspace arm and see the private session; a
      workspace-only share sees the session-less frames only; the grantee
      reads `?sessionID=` under a lease and resumes by cursor across a
      re-minted host token; revocation ends the stream). Not exercised
      through a browser on signed web; `web-signed-org-team-multiplayer`
      asserts workspace-admitted members only.
- [ ] Repository: no route named `/global/event`, `/event`,
      `/api/claxedo/events` or `/api/wr/runtime-events` in any package,
      ownership table, guard, throttle, proxy list, e2e mock or comment;
      `provider.tsx` has no stream loop; `agent-runtime-client` has no
      `subscribeTo*`; `claxedo-event-targets.ts` has no `local`-kind
      exclusion. Progress: DONE — the round-2 sweep (`bcdf50329e`) and the
      round-3/4 reviewers' greps; the remaining `/global/event` hits are the
      upstream OpenCode engine's own SSE spoken by its harness adapter. The
      app's `ClaxedoWorkspaceEvent` SDK-event union (`claxedo-api-types.ts`)
      lost its `properties`-shaped `pty.*` and `session.share.changed` arms
      in round 7 (no producer, and no consumer once the terminal provider's
      SDK-mode fallback went in round 6); its four engine-named arms
      (`file.watcher.updated`, `project.updated`, `vcs.branch.updated`,
      `global.disposed`) stay, with consumers and no producer — the
      recorded file-watcher follow-up.
- [ ] The 2026-09-17-001 scenario (daemon `kill -STOP` ≤ 36 s across a
      tool's completion) re-run on the installed build with polls
      disabled: one gap notice on `wr/events`, one resync, the row reads
      "Ran …" within it. Progress: the Tier R spec "Claude tool completion
      reconciles after the browser reconnects and reloads" cuts the browser's
      network across a real tool's completion; the stream reopens by cursor
      and the settlement or the gap notice arrives on it (polls not
      disabled; not re-run on the installed build).
- [ ] A cursor-less FIRST open during a stall (plan 001's non-goal): the
      reader's bootstrap heartbeat carries the cursor and the reader's
      first `session-history-resync` fires after the stream opens, so the
      reply's `message.updated` is read rather than lost. Progress: unit-
      proven — `claxedo-events-cursor.vitest.tsx` (a cursor-less open
      requests `stream-open` before the bootstrap cursor is adopted; a
      resumed open does not) and `routes/events.test.ts` (cursor-less
      connection served nothing from the ring, bootstrap heartbeat carries
      the cursor). Not re-run as the stall scenario on the installed build.
- [ ] E2E, real handlers (Tier R harness, not `mock-runtime.ts`): one spec
      per claimed flow — desktop-local turn streams on `wr/events`;
      owner workspace-wide + grantee session-scoped through the relay
      (grantee's unscoped attempt refused); `cp/events` notice → sidebar
      row; stall → gap notice → resync → row settles; cursor-less first
      open → resync reads the reply. All green in CI on the merge commit.
      Progress: three Tier R specs on the real local stack are green
      locally (`8c34ab1ddb`): desktop-local turn on `wr/events`;
      `cp/events` notice → sidebar row; outage → reopen by cursor →
      settlement/gap on the reopened stream. Owner/grantee through the
      relay is the acceptance test above, not a browser spec. Not run in
      CI yet — the branch is unpushed.
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
      `packages/*/scripts`, `script/`, `docs/` (outside this plan, plan 001
      and dated verification records) and the memory index. Progress: DONE
      for the listed names in code (the round-3, -4 and -7 reviewers'
      greps); the retired spellings survive in `e2e/e2e-decisions.md`,
      `docs/plans/2026-09-09-003-session-transcript-defect-log.md` and two
      `docs/verification/session-rendering/` reports, all dated records of
      what was true when written.
- [ ] System coherent (proof): consistency reviews of the landed tree, each
      by a reviewer who did not write the code, each covering the full
      producer → bus → handler → transport → reader → store path on desktop
      local, signed web + cloud, and user-hosted, with the adversarial
      brief above. Round 1 findings fixed; round 2 on the fixed tree;
      further rounds until a round returns zero findings. Each round's
      findings, fixes and the zero-finding report are recorded here with
      the commit they reviewed. Progress: rounds 1–10 recorded under
      "Execution → Review rounds" with their commits (each round's full
      reports from round 7 on are kept under `docs/plans/reviews/`); no
      round has yet returned zero findings — round 11 runs on the round-10
      fixes.
- [ ] One written account of the system exists and matches the code: the
      module comments on the two handlers, the two reader targets and
      `session-event-scope.ts` describe the same two streams, the same
      owner/grantee arms and the same notice/frame split, in present tense,
      with no history narration; the review rounds above confirm no other
      description of the event system survives anywhere. Progress: the
      handler headers (`routes/events.ts`, `shell/events.ts`), the reader
      header (`claxedo-events.tsx`), `claxedo-event-targets.ts`,
      `session-event-scope.ts`, `user-hosted-workspaces.md` §F and the
      runtime README were aligned in `bcdf50329e` and re-aligned after
      rounds 3 and 4 (two control planes on a signed desktop; the routed
      workspace's stream, not one per open workspace).
- [ ] Tests: one handler suite per stream (replay, gap, terminal reserve,
      overflow notice, owner vs grantee scope); one reader suite (cursor,
      watchdog on heartbeat, gap → resync); route-ownership snapshot;
      `bun run test:architecture-ratchets` with the closure ceilings
      LOWERED to the measured values. Progress: `routes/events.test.ts`
      (23), `event-delivery.test.ts` (28), local `shell/events.test.ts` (13)
      + `event-stream-response.test.ts`; reader suite
      `claxedo-events-cursor.vitest.tsx` (18) + `claxedo-event-targets.test.ts`;
      ceilings lowered in `2c10b5aaa4` (app-local 1077, renderer 1120,
      self-hosted 124, desktop main 90) and unchanged since.

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
  server-side projection, local-server proxy list). Landed:
  `4530b4d2de` on `refactor/two-event-streams`.
- **Lane B — server `cp/events`** (shell events handler, hosted shell,
  route ownership, guard, process-events re-pointing). Landed:
  `740f83b087`.
- **Lane C — client** (one reader, targets, deletions, e2e mock). Landed:
  `9d80c764f8`; the trace sweep across every other package, the docs and
  the closure ceilings: `2c10b5aaa4`.

Landing notes (2026-09-17, worktree `~/test/opencode-streams`):

- Phase 0 was not run as a wire capture on the installed desktop: the
  static reading in "The flow today, observed" stands as the premise, and
  the capture's role is taken by the Tier M and Tier R specs below, which
  assert the routes opened and the frames they carried.
- `session-event-scope` keys each workspace's stream by `wr:<workspaceId>`
  rather than by a two-lane registry, so two open workspaces do not
  overwrite one entry.
- The gap repair pull (`scheduleSessionProjectionPull` with reason
  `sse-gap`) moved from the ingress' `runtime.diagnostic` route into
  `resetStreamGapState`, the one place a stream's gap is answered.
- The Tier M mock's `emitRuntime` projects raw harness frames through
  `createClientPresentationProjection` on the mock's side, as a host does,
  and publishes the result on `wr/events`; raw runtime frames never reach
  the mocked wire either.

### Review rounds

Reviewers wrote none of the code they reviewed (Opus; Fable was
rate-limited). Each round covered producer → bus → handler → transport →
reader → store on desktop local, signed web + cloud, and user-hosted.

**Round 1** (tree `cec5802f66`, three reviewers: server, client, traces).
Findings, all fixed in `bb19ca222e`: pty/subagent/goal frames reached the
unscoped arm unscoped; `session.updated`/`session.deleted` twice on
`wr/events` (a bus bridge beside the hub); a frame published while a
second connection was opening delivered twice; the events source never
closed; `sessionParents` absent on the CLI runtime; `parentID` lost on
delete; the owner bypass served a workspace share every private session
(`host_read` admits shares); a cp gap resynced sessions (gaps are per
stream now); the multiplayer Tier R taps were vacuous; `/api/cp/events`
reachable over the host tunnel; a dozen stale comments.

**Round 2** (tree `bb19ca222e`, three reviewers). Findings and fixes:

- Server (`3288a1d97d`, `99abf9288f`, `9bdf6e5c2d`): the round-1 dedupe held
  only for a synchronous policy — every managed policy is async, so a frame
  in flight when a connection attached was decided twice and delivered
  twice (now: per-connection delivered set, one ring id, and a connection
  that attached mid-decision is decided for the frame); the same double
  delivery on the local `cp/events` handler; `process.status: streaming`
  per delta named a private session to every workspace reader (removed; no
  consumer); `wr/events` forwarded the whole process-global bus, so a
  daemon with several open workspaces cross-delivered pty/process frames
  (filtered to the runtime's own directory and its ptys' cwd — round 3
  widened this to the workspace's registered worktrees); the
  signed self-hosted node's embedded policy had no `authorizeHost` and
  answered 400 (now grants by the stamped role); the replay scope was keyed
  by the per-request relay host token, so any reconnect after the relay's
  30 s mint cache was a stranger's (now keyed by the runtime access token
  `parent_jti`; the acceptance test reconnects on a fresh mint); a cursor
  past a ring's head was "nothing to replay" (now a gap); the deleted lane's
  per-subscriber delivery contract, `queryName`, `unknownEventSessionId`
  and the bus `heartbeat` member survived (removed).
- Control plane (`99abf9288f`, `9cafe58ea7`): `machine-dispatch.ts` still
  read `/event?sessionID=` — a live consumer masked by its unit fake; now
  `wr/events?sessionID=`, proven by a test that drives dispatch through the
  embedded runtime app (the old path 404s in it).
- Client (`99abf9288f`, `b3e6364833`, `5a9fc39272`): the `wr` key carried
  the route's spelling of the workspace, so `/w/<id>` → `/s/<id>` reopened
  the stream cursor-less (keyed by workspace now); the 403 fallback narrowed
  on any 403 (now only on the runtime's `workspace_event_stream_denied`);
  the home route learned of no session created elsewhere (the inventory
  notice above); a stream-open resync fired for every later pane mount;
  `eventDirectoryForLiveSession`, `EVENT_STREAM_STALL_MS` and a window
  global had no production reader; two listeners closed a deleted session's
  surfaces; the mock's session arm did not scope subagent children.
- Traces and docs (`bcdf50329e`): public docs, the perf harness, the hosted
  drill scripts, a Tier R fixture option, product-boundary policy notes,
  the Vite proxy, README, the MCP inventory, and every "central stream"
  comment; the owner-arm account now agrees across the handler header, the
  runtime README, the tech docs and the reader.

Also fixed on the way: the e2e mounts test read a binding the round-1
commit had rewritten (CI-red at `bb19ca222e`); `persist_message_event`
(the hosted replay log's writer) lost its producer with the deleted lane
and keeps its readers — the log is the hosted session-pull store, not an
event stream, and retiring it is a separate change.

**Round 3** (tree `8c34ab1ddb`, two reviewers). Findings and fixes
(`15cd0927b6`):

- The round-2 bus filter admitted only the workspace directory, so every
  cloud session's lifecycle and pty frames (per-session worktrees live under
  the storage root) were dropped from its own stream — now a runtime admits
  the worktrees registered to its workspace and frames naming its workspace
  id.
- A connection attaching behind two pending frames received them out of ring
  order (its cursor then replayed a duplicate) — now decided inline before
  the next queued frame, in both handlers.
- A scope restored from its tombstone after the retained ring rolled past
  the tombstone's cursor was contiguous over a hole — now a gap.
- The self-hosted node's cookie-authenticated readers carried no bearer and
  were keyed per connection, so no cursor ever resumed there — embedded
  identities are keyed by actor.
- A control-plane fault (500/404/429) reached the runtime as a 403 and
  narrowed the reader to the session arm — now the authority is unavailable
  (503).
- A signed desktop read only the hosted control plane, so the daemon's
  notices for local workspaces (the inventory change, a worktree landing)
  never reached it — the reader opens both, the daemon's over loopback and
  the hosted one through the account bridge, keyed by transport.
- A deleted session's surfaces were matched by the runtime's host path —
  now by the frame's address; the producer-less `session.created` wire arm
  went, and the sandbox auto-tab reads `session.lifecycle` created; the
  inventory notice appears in every account of the cp notices; a dozen
  stale comments.

**Round 4** (tree `15cd0927b6`, two reviewers). Findings and fixes (the
commit after this one):

- BLOCKER: the unscoped arm authorized every session first seen on a
  connection with the connection's own relay host token, which expires in
  60 s; from then on every new session's first frame ended the stream and
  was lost. Now `host_read` mints a WORKSPACE stream lease (session `"*"`)
  the runtime holds per connection, presents for every first-seen session
  and rolls on the renewal cadence; the acceptance test opens the owner arm
  on a one-second host token and the session's first frame lands after it
  expired. A `terminate` decision now marks the scope holed, so the
  reconnect resyncs instead of resuming over the missing frame.
- Every frame of a session the reader may not read was one authority round
  trip; a busy private session filled the scope's queue and tore every
  connection down — refusals are cached for the renewal cadence.
- Ring numbering starts from the clock (a runtime restart's fresh ring no
  longer looks resumable to a second reader carrying the old numbering);
  the local cp scope clears its "unknown numbering" flag on attach; an
  `agent.lifecycle` naming another workspace is dropped.
- With two control planes, `centralConnected` is the level (any control
  plane up) and `controlPlaneReconnects` the edge the level cannot show (a
  control-plane stream returning while the other held the level), so the
  documents index revalidates on either flap and never twice for one; a
  closed target releases its tracker and never reconnects; the sandbox
  auto-tab's terminal arm, dead since the coalescer dropped control frames,
  reads `pty.created` off the emitter; a gap or failure names its control
  plane. (`5b8ce3b9db` split the level from the edge after `0f837193d8`
  had made the level demand both planes.)

**Round 5** (tree `5b8ce3b9db`, two reviewers). Findings and fixes (the
commit after this one):

- BLOCKER (server): renewal re-asked every session in the connection's
  grants map, refused ones included, so on the unscoped arm one private
  session of another member's — cached as a refusal — ended the whole
  stream at the next 5 s cadence. Renewal now re-asks only the sessions
  the connection was DELIVERED (a refusal there is a revocation); a
  refused session is re-asked only when its hold lapses and it next
  frames. Tested directly against `sessionEventDeliveryPolicy`.
- MAJOR (server): the workspace lease's expiry was the plane's clock; the
  runtime now clamps it to its own clock at hold and roll
  (`SESSION_STREAM_LEASE_TTL_MS`), so a lease is never presented after the
  plane's expiry.
- MINOR (server): a `terminate` decision on a scope created attached never
  marked it holed; the hole is now unconditional on any scope's next
  cursor-carrying reopen. The authority test's "an editor's `*` lease
  passes `host_admin`" held only because the fake ignored `minimumRole`;
  it now asserts the access-token check carried `admin` and that a
  downgraded token is refused there.
- MAJOR (client): the sandbox auto-tab's pty arm filed a terminal under the
  runtime root the stream stamped on the frame, not the pty's cwd, so a
  sandbox terminal never opened a tab; a pty frame is now addressed by its
  `info.cwd`. Scope: the arm reads the routed workspace's stream only, so a
  sandbox terminal of a workspace not routed opens no tab — recorded, not
  fixed (the pre-refactor coalescer had the same reach).
- MINOR (client): a single-control-plane reconnect fired the documents'
  revalidation twice (the level's own edge and the counter); the counter
  now counts only returns the level never showed, and the consumer path is
  tested (`document-index.vitest.tsx`). The reader's failure path skips a
  closed target (its transport may reject the aborted body with something
  other than `AbortError`). `SessionConnectionLine` no longer reads the
  `cp` stream's health for a session whose workspace is unresolved — no
  session frame rides `cp`; it renders nothing until the workspace is
  known.
- Docs and comments: the `cp/events` header names the self-hosted node;
  the `wr/events` header, the runtime README and this plan carry the
  workspace lease; the refusal-code constant no longer splits
  `authorizeSessionEventScope` from its docblock; `claxedo-event-targets.ts`
  names both control planes; the unused `PtyInfo` re-export through
  server-core and claxedo-server is gone; the connectivity test tracks
  `"wr"`; test titles and a spec variable renamed.
- Recorded follow-ups (not fixed): a signed plane without a lease signing
  key mints no lease for any stream (`decideStream` answers 503), so its
  runtimes serve no managed stream past a session's first frame — the
  workspace read itself is granted; `host_read` mints a lease on every call,
  renewal included. The hosted worker publishes no
  `session.inventory.changed`.

**Round 6** (tree `38e24692cf`, two reviewers). Findings and fixes (the
commit after this one):

- MAJOR (server): round 5's renewal filter skipped refused sessions but not
  one whose FIRST decision was still in flight, so a renewal tick landing
  during that round trip read the refusal as a revocation and ended the
  stream. Grants now carry `granted`; renewal re-asks granted sessions only,
  and a refusal of a never-granted session — 403, 401, 503 or a thrown
  authority — is an omit held for one cadence, never a terminate. A granted
  session whose renewal stalls past its lease expiry is closed on the
  runtime's clock.
- MAJOR (server): the session-scoped arm still authorized its first frame
  on the request's relay host token; the scope's session lease now seeds
  the grant (`holdSession`), and the delivery policy is the ONE renewer of
  both arms — the separate lease watch (`watchSessionEventLease`, its seven
  tests) is deleted. The session-scoped connection reads in a scope of its
  own (`sessionScope` on the principal), whose ring numbers only that
  session's frames, so a cursor from it is contiguous and a scope rebuilt
  after the reader was away has no hole where a workspace frame its wire
  never carried was numbered; the wire-side `allows` filter and
  `scopedReplay` are gone with it. Revocation of a granted session is
  observed at the renewal cadence (the acceptance test runs it at 200 ms),
  not on the session's next frame.
- MAJOR (server): a client gone during the authority round trip or the
  ring's startup was never released — Hono reports an abort only to a hook
  registered before it and its writes swallow errors — so its subscription
  and renewal round trips lived until the runtime disposed. Both handlers
  now register on the stream AND the request's own signal, and check both
  after attaching; the `wr` route test aborts mid-open and asserts no
  authority call follows, the `cp` test the same with a per-frame
  visibility check.
- MAJOR (server): deleting a session ended every workspace-arm reader that
  held it (the plane answers a deleted session 403, which renewal read as a
  revocation). The runtime forgets the session's grants on its
  `session.deleted` frame.
- MINOR (server): `session.lifecycle` `creating`/`failed` frames carry no
  session and reached every admitted principal — another member's draft id
  and failure message. They now carry the creator's `actorId` and the
  delivery policy delivers a session-less frame naming an actor to that
  actor alone.
- MINOR (server, docs): the heartbeat contract names the three cadences
  (wr 10 s, local cp 5 s, hosted cp 30 s against the reader's 45 s); the
  no-signing-key account is corrected in code and above; the hosted room's
  narrower notice set is stated on `ControlPlaneEvent` and the local
  handler; the plan's retention sentence names the SDK defaults.
- MAJOR (client): agent-status reconciliation was keyed on the aggregate
  `connected()`, which never drops while `cp` holds it up, so a `wr`-only
  outage across a `pty.exited` left a terminal pinned busy. The tracker now
  keeps a level and an edge per kind (`workspaceConnected` /
  `workspaceReconnects` beside the `cp` pair) and the reconciliation reads
  the `wr` pair.
- MINOR (client): the desktop's cloud wire — the daemon's
  `localWorkspaceRelayProxy` at `/workspaces/<id>/api/wr/events`, owner
  token minted by the daemon, cursor forwarded (round 7: and resumed, once
  the scope was keyed by the actor) — is documented on the target
  module and tested at the fetch seam. The retired `origin` parameter of
  the emitter's handlers (whose only meaning was the two-lane overlap) is
  removed; the terminal provider's "vanilla mode" `sdk.event` fallback,
  dead since pty frames stopped carrying `properties`, is deleted and its
  fixtures feed the emitter's shape; the rail's status comments state the
  real reason a background row follows the batch read (nothing resyncs its
  live entry across a gap, and a row of a workspace not routed has no
  stream); stale docblocks and a test's stream-id spelling corrected.
- Recorded follow-ups (not fixed): `presentation-frames.ts` still admits
  `file.watcher.updated`, `project.updated`, `vcs.branch.updated` and
  `global.disposed` and their consumers (`tab-file.tsx`,
  `global-event-projector.ts`, `files/watcher.ts`,
  `review-vcs-invalidation.ts`, `session-list-events.ts`) still expect them,
  while no producer publishes any of them on either stream — the engine's
  own event names, already recorded as the unresolved file-watcher gap; the
  rail's background-row status policy discards live `session.status` it now
  holds for the routed workspace's sessions.

**Round 7** (tree `daeb9114c0`, two reviewers). Findings and fixes (the
commit after this one):

- MAJOR (server): round 6's held omit for a transient authority fault on a
  never-granted session dropped the frame in silence — every session is
  "never granted" again on a reconnect's fresh grants map, so a plane blip
  on a first frame after reconnect lost the frame with no gap. Now: a 403
  of THIS session is the held omit; the authority being away (503, a thrown
  call) leaves a GRANTED session's lease standing until it expires (the
  round-6 hard-expiry clock bounds a stall) and, on a session never
  granted, ends the stream so the reconnect reads the hole as a gap; a 401
  ends it. The workspace lease's renewal follows the same rule.
- MAJOR (server): the same fault at renewal on a granted session
  terminated every stream in every workspace within one cadence — a
  resync storm against the plane that just faulted. Covered by the rule
  above; tested at both leases.
- MAJOR (server): the desktop's and a self-hosted node's proxy path mints a
  runtime access token per request, and the replay scope was keyed by that
  token, so every `wr/events` reconnect through the proxy landed in a fresh
  scope (any cursor a gap) and every token expiry (≤15 min) tore the stream
  down. A verified actor's scope is now the actor's at its role
  (`scopeKey`): re-minted tokens, two tabs and the proxy's per-request
  token share one ring and resume each other's cursors; a role change opens
  a ring of its own. Only a principal without an actor is still keyed by
  its credential.
- MINOR (server): the `session.deleted` forget ran at publish time, so a
  deletion queued behind another session's in-flight first-frame round trip
  was decided after its grant was gone; it is now forgotten per connection
  once that connection has decided the frame, and a session-scoped
  connection whose session is gone ends at its next renewal.
- MINOR (server): `remote-session-authority.ts` mapped 429/5xx to a 403
  `session_private` on every non-host call; only 401/403/409 are the
  authority's answers, the rest are 503.
- MINOR (server): `eventSessionId` failed open for an unenumerated
  presentation type (workspace-wide delivery by omission); the default now
  reads the session off `properties`.
- NIT (server): the source's unused `open().decide` is gone; the docs-floor
  row names the dated records that still carry retired spellings.
- MINOR (client): narrowing to `?sessionID=` kept the workspace ring's
  cursor, which the session's own ring (round 6) reads as a gap → needless
  repair pull; the cursor is dropped on narrowing. The Tier M mock's
  one-numbering divergence is stated on the mock.
- MINOR (client): a share grantee on the workspace's draft route reopened
  unscoped into a 403 loop with backoff, escalation and "Reconnecting…";
  refused with no session to narrow to, the target now waits and reopens
  session-scoped when a navigation names one.
- MINOR (client): `workspaceReconnects` could never increment — the
  provider closes a stale workspace stream before opening the next, so the
  `wr` level shows every return; the counter and its comments are removed,
  and the agent-status reconciliation reads the level (one reconcile per
  workspace switch, which is what heals a non-routed workspace's pane).
- MINOR (client): the `properties`-shaped `pty.*` / `session.share.changed`
  union arms are retired; comments contradicting the landed code are
  rewritten (session-event-scope's stacked docblocks, session-controller's
  workspaceId, the user-hosted spec's deleted `runtime-envelope` and its
  tautological contract-version assertion, the scope test's "both lanes",
  the desktop/host-connector "clients open no workspace stream", the cloud
  connection's "unscoped answers 400", session-list-events' history,
  workspace-connection's "provision SSE stream"); the reader header names
  what the desktop lost (a non-routed local workspace's pane settles on the
  switch reconcile or the rail batch); the account bridge no longer returns
  a Response over a body an abort tore down during the handshake.

**Round 8** (tree `856d7a8a81`, two reviewers; reports in
`docs/plans/reviews/2026-09-17-002-round8-{server,client}.md`). Findings
and fixes (the commit after this one):

- MAJOR (server): the tombstone rebuild turned every retained frame the
  authority could not decide (503, thrown, the startup deadline) into a
  silent skip and left the ring contiguous, so a cursor reconnect while the
  plane was still away resumed over the frame with no gap — round 7's
  "reconnect reads the hole" held only when the plane was back (a replay).
  The rebuilt ring is now holed on any such frame: the cursor reads as a
  gap and the reader re-reads. Route test with the plane away across the
  reconnect.
- MINOR (server): two connections of one actor share a ring; seeding a new
  connection's `authorizedSessions` from that ring turned a later 403 into
  a disconnect → reconnect → seeded → disconnect churn. The seeding is gone
  (renewal is what ends a revoked reader); the ≤ one-cadence replay of the
  other connection's granted frames to a revoked one is stated on
  `scopeKey`.
- MINOR (server): the `signed-unattributed` principal arm was unreachable
  (every relay host token and embedded identity carries an actor) and
  `replayKey` read only there — both removed with the `unattributed:` scope
  branch and the default policy's arm.
- MINOR (server): a subagent child's `session.deleted` was scoped to the
  child (its row is gone before publish, so the parent registry no longer
  knew it): the cascade now publishes the parent id on the frame, the
  handler reads it, and a child's deletion never drops the parent's grant.
- MINOR (server, docs): the handler header, the README and the target
  module state the two bounds — a connection lives at most one runtime
  access token lifetime (the daemon's proxy mints ten-minute ones) and
  reconnects by cursor into the actor-keyed scope; a self-hosted node's
  embedded policy admits the unscoped arm by stamped role with no lease and
  re-checks only session grants. The source docblock and the acceptance
  test no longer say the scope is the access token's.
- NIT (server): `eventSessionId`'s enumerated `session.*`/`message.updated`
  cases fall through to `properties.sessionID`; the round-7 scratch tests
  (unrunnable outside their scratchpad) are dropped from the repo.
- MAJOR (client): the reader header's claim that a non-routed local
  workspace's terminals were healed by the switch reconcile or the rail
  batch was false — the reconcile only idled terminals absent from `/pty`.
  `reconcileAgentStatuses` now reads, per workspace, the pty list and each
  live terminal's recorded lifecycle (`/api/wr/hook/terminal-session`) and
  applies it; a workspace whose host is away keeps its indicators instead
  of every workspace's being cleared. What is still lost while not routed
  — the completion sound, auto tab open/close — is stated on the header.
- MINOR (client): the session-scoped arm's refusal is now named by the
  runtime (`session_event_stream_denied`, cause carried) and the reader
  parks the target on it — no backoff, no escalation, no "Reconnecting…" —
  until the route names another session; the e2e mock speaks the same
  code.
- NIT (client): the mock's narrowing note names the suites that prove the
  cursor drop; stale `context/claxedo-events.tsx` paths and line-number
  history in `stream-sync-lifecycle.ts` and `workspace-connection.ts`
  rewritten; the desktop's `sessionAuthority` comments say a hosted-plane
  client registers regardless.

**Round 9** (tree `3d6a5559ab`, two reviewers; reports in
`docs/plans/reviews/2026-09-17-002-round9-{server,client}.md`). Findings
and fixes (the commit after this one):

- MAJOR (server): the round-8 hole was a boolean the first attach reset,
  so a second connection of the same actor reconnecting with the same
  cursor resumed over the undecidable frame. The scope now keeps a hole
  watermark (`holeBelow`: the ring position at its last hole, or the start
  of a ring that continues no tombstone), and any cursor at or below it is
  a gap whoever presents it; route test with a second tab.
- MINOR (server): the outage cycle (never-granted + away → terminate → hole
  → rebuild → gap → resync, once per session's first frame at the
  authority's timeout rate) is stated where the rule lives. The fresh-ring
  comment no longer says "numbers from 1"; `sessionAccessContext` no longer
  guards an actor both claim types require; `deletedSessionParent` reads
  the wire defensively.
- MAJOR (client): the round-8 heal cleared a live terminal's "done" mark on
  a recorded Idle, read only terminals already showing an indicator (so an
  agent that started or asked while unrouted was never shown) and skipped
  the first stream-up (persisted indicators never reconciled). The
  reconcile now reads every owned terminal, applies per workspace as read,
  is superseded by a later reconcile (no stale record over a fresher), runs
  on the first stream-up too, and clears `seen` only for a terminal that is
  gone. Tests for all four.
- MAJOR (client): a parked session re-granted never reopened. The share
  notice's `granted` phase reaches the reader, which reopens the parked
  target where it stands; a navigation that names the refused session
  afresh is one open per navigation. Tested.
- MAJOR (client): the Tier M rendering-matrix spec asserted the mock's old
  `session_access_denied` body; updated to the named refusal.
- MINOR (client): the reconcile shares the preview module's path builder
  and parser instead of a second copy; each connect attempt is bound to
  its own controller, so a retarget landing during a 403 body read cannot
  schedule a second stream for one target.
- NIT: the mock's narrowing note names the route test that proves the
  session ring's own numbering (added: two arms of one actor).
- Size budget: the reader had grown past the 800-line ceiling; the frame
  union and the emitter now live in `claxedo-event-frames.ts` (the reader
  re-exports them), and `batch-autotab.ts` subscribes to the emitter itself
  instead of through a `{name, details}` relay in `route-bridge.tsx`.

**Round 10** (tree `1270592b2c`, the branch rebased onto dev `d94e4250d9`;
two reviewers; reports in `docs/plans/reviews/2026-09-17-002-round10-{server,client}.md`).
Findings and fixes (the commit after this one):

- MAJOR (server): a scope that had rung no frame before it was evicted
  wrote a tombstone naming no retained position, and `hasGap(undefined)`
  is never a gap — so a grantee who opened on an idle session and dropped
  was restored as continuing after the retained ring rolled, and its
  bootstrap cursor resumed over everything that rolled out with no notice.
  The tombstone now records the retained position the scope had DECIDED
  through (delivered or omitted; not past a frame the authority could not
  decide) and carries its hole; a tombstone naming no position does not
  continue. The local `cp/events` handler had the same hole and takes the
  same rule; its attach-reset `unknownSequence` flag is the same watermark
  round 9 gave `wr/events`, so a second tab at the same cursor reads the
  gap too. Tests at both handlers, mutation-checked.
- NIT (server): a fresh ring's own start — the bootstrap cursor a reader is
  handed on an empty ring — resumed as a gap; only cursors below the start
  are foreign now. A restore that does not continue keeps its start over
  the hole, since that start IS the cursor its readers hold.
- MINOR (server): `createSessionRoutes` lost its `sessionBus` option, read
  by nothing since round 2, with `RuntimeSessionBusEvent` and the two
  tests asserting an empty bus.
- MINOR (client): a live `agent.lifecycle` frame landing during a
  terminal's recorded read was overwritten by the older record; each live
  terminal is now applied as its record arrives and only if its indicator
  did not move during the read.
- MINOR (client): a re-grant notice arriving while a session-scoped
  attempt was in flight was ignored and the attempt's stale 403 parked the
  target; the notice is remembered and the refusal reopens once instead. A
  control-plane gap re-probes every parked target once, since the notice
  may have fallen into the hole. Both tested, mutation-checked.
- NIT (client): the reader's dead re-exports are gone (the two tests import
  the frames module); the Tier M spec's comment says it proves the mock's
  body, naming the reader suite that proves the parking.

**Round 11**: see below.
