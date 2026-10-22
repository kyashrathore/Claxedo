# A person's own machine: assign and terminal latency, 22 October 2026

`claxedo connect` enrolls a machine with the control plane and serves the folders its owner assigns to it through the relay. This note measures, from this Mac in India against staging (`app.claxedo.dev`, the control-plane Worker pinned to `aws:us-east-1`, D1 in ENAM, the relay room placed `apac`), how long an assignment takes to be served and how long a terminal takes to show its first bytes, where each second went, and what moved after this branch (base `origin/dev` 60a4df6074).

The rig: the published `@claxedo/cli` 0.2.0 from npm installed into a scratch prefix, run with a scratch `HOME` (serving a folder writes harness hook files into the home), enrolled with an invitation minted by the signed-in staging CLI; `host assign` driven as the CLI does it (`POST /api/workspace/:id/host-assignment`), polling `GET /api/claxedo/host/enrollments` every 200 ms for the machine's ack; the terminal driven as the app does it (`POST /api/workspace/:id/connection`, then the relay's `POST …/api/wr/pty` and the `…/pty/:id/connect` WebSocket), with the connector's own log stamped to the millisecond. Three folders, three to seven runs per step.

## Assign: 14.7–16.6 s, of which 12.0–13.8 s is waiting for the next heartbeat

`claxedo host assign <dir>` → `POST /host-assignment` → `assignWorkspaceHost` writes the row. The machine learns of it only from the answer to its next heartbeat (`createHostConnector`, `reconcile`), and `BEAT_INTERVAL_MS = min(LEASE_TTL_MS / 3, 20_000) = 20 s` (`packages/cli/src/connect/host.ts`; the desktop's connector child beats every 20 s too, `child-supervisor.ts`). Nothing pushed: the assign handler published no live-sync notice. The owner's "up to 20 s" is exactly this interval; its mean is 10 s.

| step | run 1 | run 2 | run 3 |
|---|---|---|---|
| `POST /host-assignment` returned (auth 360–510 ms + d1 570–710 ms) | 1.03 s | 1.15 s | 1.04 s |
| waiting for the next beat | 12.0 s | 12.6 s | 13.8 s |
| host preparation (`listener.ensure`: the host's `claxedo.db` opened and 61 migrations applied, 340 ms, once per process; the runtime created) | 0.35 s | 2 ms | 2 ms |
| ack beat round trip, credential back, relay tunnel dialled | 0.60 s | 0.67 s | 0.81 s |
| assign → control plane shows the ack | 14.9 s | 14.7 s | 16.6 s |

Enroll → "serving as" took 3.7 s for a cold process (node start, redeem, acquire, first beat) and 2.2 s on a restart with three folders (every runtime started in 10 ms; the tunnels dialled 0.55 s after).

### After: the control plane rings the machine

The host routes now ring the owner's live-sync room with a `host.changed` event (`WorkspaceRouteOptions.hostChanged`, nudged by `hosted-core-app.ts`) after an assignment, a retirement, a scope change, a pushed provider configuration and a revocation, and every connector holds a machine-signed `text/event-stream` on `GET /api/claxedo/host/enrollments/events` (`workspace/host-events.ts`, bridged into the room as a `machine` subscriber, `live-sync-subscriber.ts`) that beats on each ring (`MachineTransport.watch`, `packages/claxedo-host-connector/src/machine-events.ts`). The beat stays the one path an assignment travels on; the ring only decides when it happens. A machine hears its own `host.changed` and nothing else in that room (`eventVisibleTo`); a person's stream never hears it.

Measured live on staging with this branch's control plane (try/staging-d2 5e361a58a1, deploy run 39819660748) and a connector built from the branch, five fresh folders in a row, `wrangler tail` on the control plane:

| step | run 1 | run 2 | run 3 | run 4 | run 5 |
|---|---|---|---|---|---|
| `POST /host-assignment` returned | 1.27 s | 1.46 s | 1.18 s | 1.34 s | 1.08 s |
| host logs "serving" (ring, beat, preparation) | 0.60 s after | 0.61 s | 0.65 s | 0.58 s | 0.58 s |
| ack beat, credential back, relay tunnel dialled | 0.54 s | 0.66 s | 0.75 s | 0.55 s | 0.54 s |
| assign → control plane shows the ack (polled every 200 ms, each poll 0.9–1.1 s) | 3.52 s | 3.77 s | 3.33 s | 2.49 s | 3.18 s |

The tail shows the mechanism: each `POST /api/workspace/:id/host-assignment` is followed within 0.3–0.6 s by a heartbeat (the rung one) and 0.5–0.7 s later by a second (the ack's), with the 20 s timer's own beats unchanged around them; the connector logged no stream failure for the round. Against the strict fake control plane, which rings exactly where the routes do: an assignment is served with no timer tick (`connector-machine.test.ts`, "rings the machine"), a dropped stream reopens with backoff and resumes from the last frame's id (`machine-events.test.ts`), and `closing or draining the connector closes its doorbell stream`.

A stream that ends (a deploy, an idle proxy, a sleeping laptop) is reopened after 1 s, doubling to 30 s per failed attempt, reset by any frame read. A refusal the control plane decided (401/403/404/409/410) ends the watch; the next beat is where that decision is acted on. The held stream costs the control plane nothing while it is idle: it re-reads nothing, because a revoked or paused enrollment is refused at the machine's next beat (at most 20 s), which stops the connector and closes the stream with it, and a machine that kept a stream open past that would hear only rings for its own host id. The reconnect wait is the app's event stream's (`@claxedo/helpers/backoff`): doubling per failed attempt, drawn from the upper half of a window that starts at 1–2 s and ends at 15–30 s.

## Terminal: 7.7–12.6 s from mint to first frame

| step | before (7 runs) | after (4 runs, this branch's connector) |
|---|---|---|
| `POST /connection` (mint; lane TS) | 1.38–3.52 s | unchanged |
| a `GET …/api/wr/health` through the relay (runtime-total 0.4–1.3 ms warm; lane TS) | 1.23–4.04 s | unchanged |
| `POST …/api/wr/pty` through the relay | 1.59–2.81 s; runtime-total 411–1900 ms | 0.94–2.68 s; runtime-total 397–615 ms |
| of which `Pty.create` (host) | 3–17 ms warm, 263 ms cold (node-pty import 244 ms) | 4–11 ms, the cold first one too |
| of which the host's authority call (`admitTerminal` → `POST /api/runtime-authority/session-authorize`, IAD) | 0.4–1.9 s | unchanged, once per create |
| `…/pty/:id/connect` WebSocket open | 0.68–1.59 s (3.87 s once), after the attach's authority call | 0.55–1.65 s, while the attach's authority call is still open |
| first frame after the WebSocket open | 0.7–1.9 s | 0.6–0.7 s |
| mint → first frame | 7.7, 8.4, 9.6, 9.8, 10.6, 12.6 s | 5.7, 6.1, 7.9, 8.5 s on the branch connector against the old control plane; 5.26, 5.00, 5.05, 5.06, 5.01 s live on the deployed branch (`POST pty` 0.72–1.05 s wall, runtime-total 424–535 ms; WebSocket open 0.76–1.31 s; first frame 0.52–0.62 s after it) |

The shell's own first byte on the host is 21–33 ms warm (461 ms for the cold first `zsh -l`); the 907–987-byte first frame is the terminal's preamble and prompt.

### What moved

The attach's authority call ran before the upgrade. `PtyRoutes` ran `admitTerminal` on the create and once more on the `/connect` upgrade, each an HTTP round trip from the host to `session-authorize` in IAD (0.4–1.5 s from India), and the upgrade — itself a round trip through the relay — waited for the attach's. The authority is still asked on every attach, as the owner's rule requires (a revoked share or removed member loses the terminal at once, not when a lease runs out), but its answer is now awaited inside the stream (`createAuthorizedPtyConnection.attach`, `pty/authorized-connection.ts`): the upgrade completes while the authority answers, `Pty.connect` replays nothing until it allows, a keystroke that arrives first waits behind it, and a refusal closes the socket with 1008 before any byte crosses. A viewer and a session-scoped token are still refused before the upgrade on the stamp alone (`terminalCallerRefusal`). Tested: the upgrade answers while the authority has not (`pty.test.ts`, "awaited on the socket"), and a token revoked between the create and the attach denies the attach with the authority asked a second time ("revoked between the create and the attach").

A lease reuse (the attach running on the create's 15 s lease when the same runtime access token attached) was measured first — WebSocket open 0.47–0.85 s, first frame 0.17–0.27 s after it, mint → first frame 3.7–6.8 s — and withdrawn: within the lease a revocation would have been noticed at the renewal, up to 10 s later, which the owner's rule rules out.

The first terminal paid the PTY binding's import. `Pty.warm()` loads `@lydell/node-pty` when the host runtime starts (`createHostRuntimeListener.ensure`), 244 ms off the first create.

The creation-identity probe (`readPtyCreationIdentity`, `sysctl` on macOS) costs nothing measurable with `sysctl` on the PATH: `Pty.create` is 4–11 ms warm, probe included. Without it on the PATH (a service unit with a bare PATH) every terminal is left unowned and the workspace later refuses terminals with `workspace_launch_unreconciled`; the rig hit that once.

### What is left, with its owner

- The relay hop: 1.2–3.2 s per HTTP request and 0.5–0.8 s per WebSocket open on a warm host whose runtime answers in 1 ms. Lane TS's relay trace (`relay-trace.ts` spans, forced on staging) on this machine's workspace puts the host's own leg, `tunnel-wait` (room → host tunnel → connector → runtime → back), at 179–205 ms per request against runtime-total 0.4–1.7 ms; gateway → room about 55 ms; `relay-auth` 0 when cached and 213–406 ms after more than 10 s idle; and 0.24–0.44 s of TCP connect for a fresh connection from this Mac, which lands on Cloudflare's France edge. The connector adds nothing measurable to its leg.
- The create's authority call, 0.4–1.5 s, one per terminal; the Worker verifies the relay's stamp, reads the parent token's row in D1 and mints the lease.
- One attach in seven ended with the relay closing `1000 Host upstream WebSocket failed` 3.9 s after the open began (the host tunnel's loopback WebSocket to the runtime listener did not open); not reproduced since, reported to lane TS.
- The owner's "5.3 s cold pty and hooks" on their Mac is not reproduced here (hooks setup 11 ms into a scratch home); a real home's harness configs are merged on that path (`materializeAgentHooks`), which this rig must not exercise (it writes the home's harness settings), so it stays unmeasured.

## Reproducing

`docs/perf/machine-connect-latency-2026-10-22/` has no scripts; the rig lived in a scratch directory outside the repository and is described above. The published CLI's log carries `pty.create timing` and `pty.firstByte` lines per terminal; stamp its stdout and stderr with epoch milliseconds to place them on the same timeline as the client.
