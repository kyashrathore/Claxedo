# A Pi session on its Durable Object: every latency between a press and the screen

Measured on 2026-10-18 against `8b2d1e949b`, for a person in India using the signed-in web app on staging (`app.claxedo.dev`, relay room in `apac`, session object and control plane in `enam`/IAD). The question was the owner's: a Pi session on its Durable Object should be indistinguishable from a local one. This folder holds the rig, the runs and the answer.

**Answer.** Once the stream is going, the cloud session *is* indistinguishable from the local one: a delta reaches the person every 100-107 ms in both (pi-durable commits partial messages at most every 100 ms), with 4-7 ms of jitter on the cloud path and 10-12 ms locally. What differs is the start of a turn. From the press to the first delta the cloud path costs 1.28-1.35 s against the local path's 0.98 s with the same vendor (600 ms to first token), and the gap is made of three things: 320 ms of ocean the person cannot avoid (India to the object and back), 180 ms of three serial control-plane calls the object makes before it calls the vendor (420 ms per call at staging's control-plane speed, so 1.2 s), and a relay whose caches expire every 10 s and then cost one or two more control-plane round trips before the prompt is even forwarded. The vendor itself is 220 ms *closer* to the object than to the laptop. The first two are measured below; the relay cliff is halved in this branch and the control-plane calls are a proposal for the control plane's owner.

## The live path, as the code runs it

A. The person presses send in the web app's composer.
- A.1 `sendPrompt` (`packages/claxedo-app/src/session/transcript/send.ts`) calls `showSent`, which upserts the optimistic user message (`promptEcho`) and marks the row as sending, synchronously, before any request leaves. **Press to optimistic echo: 0 ms** (one Solid batch).
- A.2 `server.sessions.prompt` → `deliverPrompt` (`src/server/sessions.ts`) → `transport.runtimeJson(route, "/session/<id>/prompt_async", POST promptBody)`. For a session hosted by its object the route carries `sessionHost`, so `runtimeRoutes` (`src/server/transport.ts`) calls `relay.fetch(workspaceId, path, init, sessionId)` (`src/server/relay.ts`): `POST ${relayUrl}/workspaces/<ws>/session/<id>/prompt_async?region=<homeRegion>` with `Authorization: Bearer <Runtime Access Token>` and a JSON body. The RAT came from the control plane's connection read (lane E's path). The browser's first POST to this URL pays a CORS preflight (Authorization + content-type), answered by the relay gateway at the edge and cached 86,400 s per URL (`corsPreflight`, `packages/workspace-relay/src/cloudflare.ts`).

B. Cloudflare edge, relay gateway Worker (`packages/workspace-relay/src/worker.ts`, `createWorkspaceRelayDurableObjectGateway`): decides the room's `locationHint` from the region query, the edge country or the `apac` floor (`relayRoomPlacement`, `relay-location.ts`; staging's `CLAXEDO_RELAY_LOCATION_HINT = "apac"`), then `namespace.get(idFromName(room)).fetch(...)`. The hint only matters at the room's first creation; the object never moves ([Cloudflare: data location](https://developers.cloudflare.com/durable-objects/reference/data-location/): "Durable Objects do not currently change locations after they are created"; hints are "a best effort and not a guarantee").

C. Relay room Durable Object (`createWorkspaceRelayDurableObjectRoom`, `cloudflare.ts`), in `apac`. `forwardCloudHttp` → `authorizeWorkspaceRelayRequest` (`server.ts`):
- C.1 `rat-verify`: the RAT's signature (cached per token).
- C.2 `rat-active`: the revocation lookup, `GET <control plane>/internal/relay/revocation`, cached 10 s per `jti` (`createCachedRevocationClient`, `resolver-clients.ts`). A room in `apac` asking a Worker pinned to IAD: ~220 ms of link plus the plane's own time.
- C.3 `target-resolve`: `GET /internal/relay/target`, cached 10 s per workspace/host/routing id (`createCachedTargetClient`). For this session the answer is `backing: "durable-object"`, `baseUrl: ""`.
- Before this branch C.2 and C.3 were awaited one after the other; now the target lookup leaves with the revocation check, and a `durable-object` target, whose host id names the object, is kept for 30 minutes (the RAT's longest life) instead of 10 s. Only the revocation check is left to expire on the 10 s cadence.
- C.4 `relayHostTokenFor` mints the 60 s Relay Host Token (cached).
- C.5 `forwardSessionHostHttp` (`session-host-forwarding.ts`): `SESSION_HOST.getByName(root, { locationHint: "enam" }).fetch(...)` with the RHT, cookies stripped, the response body passed through untouched. The room sits on the path of every byte of the stream: object (enam) → room (apac) → gateway (edge) → browser. For a person in India the room is on the way, so this adds processing, not an ocean.

D. `SessionDO.fetch` (`packages/session-host/src/session-do.ts`), in `enam`: `lifecycle.start()` (the Agents SDK `Lifecycle`, `blockConcurrencyWhile` on first use) → `serve` → `composeSessionHost(...).app.fetch` (`composition.ts`): `createRelayHostAuthMiddleware` verifies the RHT, then the shared session routes (`@claxedo/session-core`, `composeSessionRoutes`).
- D.1 `POST /session/:id/prompt_async` (`session-core/src/routes/session-core.ts`): `sessionOperationGuard(..., "prompt")` → `remoteWorkspaceSessionAccessPolicy.authorize` → **control-plane call 1**, `POST /api/runtime-authority/session-authorize {action: "write", writeClass: "agent_turn"}` over the `CONTROL_PLANE` service binding (enam → IAD).
- D.2 `createPromptAdmission` → `acquireManagedPromptLease` → `acquireSessionTurnLease` → **control-plane call 2**, `{action: "turn_acquire"}`; `TurnLeases` stores the lease in the object's SQLite.
- D.3 `runRuntimePromptTurn` → `runtime.turns.start` (`session-core/src/host/runtime.ts`, `startTurn`): `attachments.admit` (the attached Pi session), `transport.capabilities`, `store.startTurn` (the user message and the assistant stub, SQLite), publishes `message.updated`, launches `runTurn` detached and returns. `settleAdmission()` fires and the route answers **204**. Nothing after this is waited on by the answer.
- D.4 `runTurn` (`host/turn-runner.ts`) → `PiDurableTransport.send` (`packages/harness/src/transports/pi-durable/index.ts`): `placement.prepareTurn` → `DurablePiPlacement.prepareTurn` → `SessionHostTurns.delivery` → **control-plane call 3**, `POST /turn-delivery {turnLease}` (`session-host/src/turn-delivery.ts`), once per lease: the creator's provider accounts as direct secrets, plugins, provider definitions. Then `entry.configure(credentials)`, `conversation.configure({model, thinkingLevel})` (one pi-durable commit), a `config-update` event, and `PiHarness.submit` (`agents/harness/pi`): `_wake` (a `cf_agents_jobs` upsert + `setAlarm`), `conversation.submit` (a commit), `_wake` again.
- D.5 pi-durable's generation task builds the environment (`DurablePiPlacement.env` → `host.machine()`, answered from the held delivery, no network while no tool runs) and the prompt sections; `available_skills` reads nothing when the delivery carries no plugin roots. Then `models.streamSimple` → pi-ai's OpenAI/Anthropic SDK → **the vendor**, from `enam`, over the owner's direct key. No Boat, no broker.

E. Deltas. The vendor streams tokens. `streamResponse` (`@earendil-works/pi-durable/dist/harness/generation.js`) holds the partial and commits it as a trailing write at most every `PARTIAL_THROTTLE_MS = 100` ms, one commit in flight; the first token also waits the 100 ms. Each commit's publication reaches `watchEvents` (`harness/events.js`) → `PiSessionStream.batch` (`pi-durable/stream.ts`) → `piDurableEvents` translation (`translate/adapter.ts`, `messages.ts`: `message_update.text_delta` → `text-delta`) → `PiRun.queue` → `runTurn`'s `for await` → `router.project` → `deltaText` (`session-core/src/projection/client-presentation/text-parts.ts`) → one `message.part.delta` presentation event carrying only the delta → `createRuntimeEventHub` → the `/api/wr/events` SSE writer (`session-core/src/routes/events.ts`, `streamWorkspaceEventFrames` → `attachSseFanout` → `stream.writeSSE`, one HTTP chunk per frame, no coalescing, no compression) → the room's passthrough (C.5) → the gateway → the browser.
- E.1 The browser's stream: `placement-streams.ts` opens `GET /api/wr/events?sessionID=<id>` through `relay.fetch` (one stream per attached session; HTTP SSE, since the relay refuses WebSocket upgrades to a session host, `durable_object_websocket_unsupported`). `openEventStream` (`src/server/stream.ts`) parses frames per chunk inside a Solid `batch`; `event-intake.ts` → `serverEventFromFrame` → `partDelta` → `DeltaBuffer.add` (`session/transcript/deltas.ts`) concatenates deltas per part; `commitDeltasWhileShown` (`session/view/delta-frames.ts`) applies them on the next `requestAnimationFrame`. So the screen is already updated once per frame, never per token, and at most ~16 ms behind the socket.
- E.2 The object authorizes the stream once at open (`sessionEventDeliveryPolicy` → `authorizeStream`, a control-plane call) and renews every 5 s (`renewalIntervalMs ?? 5_000`, `event-delivery.ts`): one control-plane call per open stream per 5 s, off the delta path.

F. End of turn. pi-durable commits the terminal message and the submission's `done`; `PiRun.submission` settles `finish`; `runTurn` finalizes; `session.idle` goes out on the same stream 10 ms after the last delta leaves the object. Then, off the path the person sees: `turn_release`, the usage report and the session row publication (three more control-plane calls), and after the first completed turn a title request to the vendor.

Regions on the path: browser (IN) ⇄ edge (BOM/SIN) ⇄ room (apac) ⇄ object (enam) ⇄ control plane (IAD, D1 in ENAM) and object (enam) ⇄ vendor (US).

## The rig

`packages/session-host/e2e/latency/` boots one workerd (Miniflare) with the real relay Worker and room, a "pipe" Durable Object standing where the relay's `SESSION_HOST` binding points, a Node service behind it that holds every request `roomDoMs` and every response chunk `roomDoMs` on the way back (and stamps each chunk as it leaves the object), the real session-host Worker with the control plane stand-in from its tests behind `doCpMs + cpMs`, and the relay's resolver behind `2·roomDoMs + cpMs`. The client in Node sleeps `clientEdgeMs` before each request and delays every response chunk by `clientEdgeMs`. The vendor is the harness e2e scripted model server behind a proxy (`packages/harness/e2e/perf/vendor-proxy.ts`) that adds `vendorMs` each way and stamps each chunk the vendor emits. Links default to staging as seen from India: `clientEdgeMs 50, roomDoMs 110, doCpMs 5, cpMs 50, vendorMs 10`; the vendor answers its first token after 600 ms and then 40 chunks every 25 ms. All clocks are one Node `performance.now()`.

The local comparison (`packages/harness/e2e/perf/pi-local-latency.ts`) boots the real local daemon from the harness e2e stack with the same scripted vendor behind the same proxy, at 120 ms each way (a laptop in India to a US vendor), and the same client.

```sh
bun run --cwd packages/session-host perf:latency -- --scenario relay-warm,relay-cold-cache,direct,cold-object,cp-slow,no-links --turns 6 --out docs/perf/pi-durable-latency-2026-10-18/runs
bun packages/harness/e2e/perf/pi-local-latency.ts --turns 6 --out docs/perf/pi-durable-latency-2026-10-18/runs
```

Scenarios: `relay-warm` is staging as it is, with 1 s between turns; `relay-cold-cache` sets the relay's cache TTLs to 1 ms so every request pays the resolver; `direct` sends the same requests to the object over one 160 ms link with no relay; `cold-object` restarts workerd before every turn, so the object starts from storage; `cp-slow` is the control plane at 400 ms per request, which is what staging's 0.7-2.3 s per request from India implies once the 320 ms of link is taken off; `no-links` is every link at 0, the pure compute of the path.

## The per-hop budget, press to first delta on screen (p50, ms after the press)

| hop | relay-warm, serial lookups (run 1, `8b2d1e949b`) | relay-warm, this branch (run 2) | relay caches expired, before → after | direct (no relay) | cp 400 ms | no links |
|---|---:|---:|---:|---:|---:|---:|
| prompt leaves the room for the object | 53 | 56 | 328 → 328 (two lookups serial 540+ → one 270) | - | 54 | 5 |
| object answers the prompt (two control-plane calls, store writes) | 311 | 327 | 582 | - | 1011 | 32 |
| client sees 204 (accepted) | 470 | 490 | 1017-1057 → 743 | 471 | 1172 (1789 on a cache expiry) | 36 |
| vendor receives the request (third control-plane call, two pi-durable commits, two job writes) | 393 | 413 | 654 | 395 | 1446 | 38 |
| vendor's first byte (600 ms to first token + 10 ms link) | 1007 | 1033 | 1268 | 1011 | 2060 | 642 |
| first delta leaves the object (+10 ms link, +100 ms pi-durable partial throttle, commit, translate, SSE) | 1123 | 1150 | 1390 | - | 2175 | 758 |
| first delta at the client (+160 ms one way) | 1286 | 1325 | 1553 | 1289 | 2337 | 770 |
| press → idle | 2109 | 2202 | 2422 | 2252 | 3297 | 1614 |

Run 1 is `docs/perf/pi-durable-latency-2026-10-18/runs/do-run1-serial-relay-lookups.log` (per-turn lines; its summaries were lost to the cold-object crash fixed in run 2), run 2 is `do-run2-concurrent-relay-lookups.log` and its JSON, run 3 (`direct`, `no-links` with summaries) `do-run3-direct-no-links.log`. Run 2's relay-warm has one 796 ms acceptance among six: the revocation cache expired under it (one 270 ms round trip; before this branch the same expiry cost 540-1050 ms, run 1's turns 3 and 4 at 1073 and 1523 ms).

Streaming, every scenario: inter-delta at the vendor 25-27 ms (the scripted cadence), at the object 103-108 ms, at the client 102-107 ms; jitter (sd of the intervals within a turn) 4-6 ms at the object and 4-7 ms at the client; last delta → idle 10-12 ms. The relay and the links add a constant 160 ms to every delta and nothing to their spacing.

Cold object: the first request to a freshly started object (the event stream open here) takes 713 ms mean against 435 ms warm, of which 270 ms is the fresh relay room's own resolver lookups; the object's start from storage (constructor, Lifecycle start, `Harness.open`, `composeSessionHost`, `resumeDurableRuns`, extension install, `watchEvents`) is the remaining ~120 ms in workerd on this Mac. A turn that follows is no slower than a warm one (accepted 472, first delta 1287). An object that holds an open SSE stream never hibernates (an unfinished request blocks it, [Cloudflare: lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)), so the start is paid once per visit, not per turn.

### Local, same vendor at 120 ms each way

| | local daemon | cloud, this branch, warm |
|---|---:|---:|
| press → accepted | 16 | 490 |
| press → vendor request | 26 | 413 |
| press → vendor first byte | 756 | 1033 |
| press → client first delta | 983 | 1325 |
| inter-delta at client | 112 | 106 |
| jitter at client (sd) | 9.7-12.5 | 4-7 |
| last delta → idle | 0 | 11 |

(`runs/local-run1.log`, `runs/local-*.json`.) Local pays the vendor round trip from the laptop (240 ms) that the cloud path does not (20 ms); the cloud path pays 320 ms of link to the object and back and ~230 ms of object-side work before the vendor is called, 180 of them control-plane calls.

### The floor

For a person in India and a vendor in the US, with the object in `enam`: one way to the object (160) + the vendor round trip from the object (20) + the vendor's time to first token (600, the vendor's, not ours) + pi-durable's first partial commit (100) + one way back (160) = **1,040 ms** to the first delta; local's floor at the same geometry is 240 + 600 + 100 = **940 ms**. Cloud measured 1,325 ms warm, so **285 ms over the floor**: 180 ms of three serial control-plane calls (at `cpMs 50`; 1,230 ms at staging's 400) and ~105 ms of object-side work (two admission store writes, capabilities, two pi-durable commits, two job upserts with `setAlarm`, SSE and relay processing). Inter-delta is at its floor already (pi-durable's 100 ms).

## Experiments

Kept:
- **Relay room: revocation check and target lookup concurrently** (`authorizeWorkspaceRelayRequest`, `packages/workspace-relay/src/server.ts`). Both need only the RAT's claims. A request after both caches expired: 1,017-1,057 → 743 ms accepted (one 270 ms round trip instead of two). Test: `server.test.ts` "the revocation check and the target lookup leave together ...".
- **Relay room: a `durable-object` target is kept 30 minutes** (`createCachedTargetClient`, `resolver-clients.ts`): the host id names the object and the object never moves, so the target cannot change for a RAT; revocation keeps its 10 s cadence. On staging this turns the 10 s cliff from two round trips (apac ⇄ IAD, ~220 ms each plus the plane's time) into one. Test: "a session's own Durable Object is remembered past the cloud TTL ...". The README's claim that completed target answers were never retained was false since the 10 s cache landed; it is corrected.

Measured and not changed (owned elsewhere or by a ruling):
- **Three serial control-plane calls before the vendor is called** (D.1-D.4): `write` authorize, `turn_acquire`, `turn-delivery`, each `2·doCpMs + cpMs`. 180 ms at 50, 1,230 ms at 400. The authorize cannot simply be dropped: the plane's `turn_acquire` over a relay-host bearer records `action: "read"` and does not check the share's `agent_turn` class (`runtime-session-authority.ts`, `verifySessionProof`); the pre-authorize is what refuses a `follow` share. Proposal for the control plane's owner (lane `perf/api-request-latency`): let `turn_acquire` carry and enforce `writeClass: "agent_turn"`, and return the turn delivery with the lease, so the object makes one call where it makes three. Saves two round trips per turn: 120 ms at `cpMs 50`, 820 ms at 400.
- **Firing `turn-delivery` the moment the lease is acquired**, overlapping the admission tail: the gap is ~15 ms (acquire answered at 321, delivery asked at ~336). Not worth a second owner of the delivery.
- **One warm connection for send and stream**: the browser already multiplexes both over one HTTP/2 or HTTP/3 connection to the edge; the room → object hop is a stub call. Sending over a WebSocket to the object would skip the relay's per-request authorization (~10 ms warm, now ≤270 ms on a cache expiry) and the first POST's preflight, at the price of authorizing a long-lived socket once (the relay refuses WebSockets to a session host by design; the control plane's revocation would no longer cut a send path within 10 s). WebSocket Hibernation would let the object sleep between turns while the browser stays attached ([Cloudflare: WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/): billable duration "do not accrue during hibernation"; "In-memory state is reset"), which is a cost, not a latency, win, and would make every turn start pay the ~120 ms start. Not taken.
- **Coalescing deltas per animation frame**: already so in the app (`DeltaBuffer` + `commitDeltasWhileShown`), and the wire is already 10 Hz because pi-durable commits partials every 100 ms. Nothing to coalesce.
- **Per-event overhead**: one SSE chunk per `message.part.delta` frame of ~300 bytes at ≤10 Hz; compression would only add buffering. Not taken.
- **Answering the turn start before persisting**: the 204 already waits on nothing after `store.startTurn`'s SQLite writes (~25 ms in `no-links`); the vendor call is not gated by the answer.
- **pi-durable's 100 ms partial throttle** (`PARTIAL_THROTTLE_MS` in `@earendil-works/pi-durable`): the first delta waits 100 ms after the first token and the stream runs at 10 Hz, locally and on the cloud alike. It is inside the harness; the ruling is to layer over harnesses, so it is not changed here. An upstream option (16-33 ms) would take 70-85 ms off every first delta and make the stream visibly smoother on both paths.
- **Object placement**: `enam` against `apac`. Moving the object next to an Indian person saves 2 × 110 ms on the two browser-facing legs of a turn and costs the vendor round trip from Asia on every model request (and Anthropic's 403 from HKG): with one model call per turn roughly a wash, with tool rounds a loss. `enam` stays.
- **The relay hop itself**: `direct` against `relay-warm` with warm caches, 471 vs 470-490 ms accepted, 1,289 vs 1,286-1,325 ms first delta: the room costs ~0-30 ms when its caches hold. The cliff was the problem, not the hop.

Losers, in the rig itself: the first version delayed response bodies but not headers, so a bodiless 204 came back with no return-link delay (312 ms "accepted" against the 470 physics allows); and a fresh control-plane stand-in per reboot made the cold-object scenario fail its second turn with `session.error`, since the plane had forgotten the session's registration and leases (the stand-in now outlives workerd across reboots, `TopologyInput.world`).

## What to measure on staging after the deploy

From India, signed in, a Pi session on a cloud workspace, DevTools network panel with `Server-Timing` visible (lane E added `timing-allow-origin` to the relay's CORS headers):
1. `POST .../prompt_async` wall time with 1 s between sends (expect ~320 ms + two control-plane requests + ~30 ms), then after a 12 s pause (expect one extra apac ⇄ IAD round trip, not two; before this branch two). The relay's `server-timing` on a sampled response shows `rat-active` and `target-resolve` overlapping.
2. The `/api/wr/events` stream: time from the press to the first `message.part.delta` frame, and the frames' spacing (expect ~100 ms, sd under 10 ms). Compare with the same prompt on a local Pi session.
3. The session object's log: the three `session-authorize`/`turn-delivery` calls' timing per turn (`SLOW_REQUEST_MS` warnings at 1 s) and lane E's `host-start`/`host-serve` `Server-Timing` on the object's answers; a first request on a cold object should show ~100-200 ms of `host-start`.
4. The vendor: `press → vendor request` cannot be read from the browser; the object's `console.warn` on slow control-plane calls is the proxy.

## Not verified here

Real link latencies (the rig injects the 50/110/5/10 ms one-way figures above), staging's control-plane time per request (`cpMs`; both 50 and 400 are run), the room's actual colo for an Indian opener (assumed on the browser-to-object path), the hibernation behaviour of a real object between visits (workerd neither hibernates nor evicts; the cold start is a restart from storage), and the browser's own frame timing (the rig's client is Node; the app commits deltas on `requestAnimationFrame`, so add up to 16 ms).
