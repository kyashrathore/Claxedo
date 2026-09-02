# Machine-wide enrollment consolidation (retire per-workspace host links)

Date: 2026-09-01 · Branch: `codex/cloudflare-multiplayer-migration` · Status: PLANNED · Adversarially reviewed 2026-09-01 (see below — unit order revised)

## Why

Remote access currently runs on TWO grains at once:

1. **Machine-wide enrollment** (Unit 6, shipped): one P-256 machine key, one
   enrollment row (`host_enrollments`), one signed heartbeat proving "this
   machine is here". The Host Connector's own doc states the intended end
   state: *"everything the old per-workspace design put here — which projects
   are shared, what a workspace id is, when to register a new one — is now
   decided by the control plane at request time."*
2. **Per-workspace local host links** (old grain, still load-bearing): every
   share is its own challenge → machine-key signature → `local_host_links`
   row, kept alive by its own signed heartbeat under a 5-minute TTL cap.

The duplication is not free. It produced tonight's live defects on staging:
the share list and rail clobbered by control-plane echoes of local ids, a
healthy connector reported as timed out because two shares' registration
round trips ran inside its bootstrap budget, and N per-workspace heartbeats
per interval where one signature could carry the same fact. Every new share
multiplies signed traffic; every consumer (routing, devices, share state)
reads the legacy table while the enrollment carries none of it.

## Current consumers of the per-workspace grain (all verified in source)

| Consumer | File | Reads |
|---|---|---|
| Relay routing (workspace → host) | `packages/claxedo-server/src/authority/adapters/d1/user-hosted-relay-target.ts` | `local_host_links` lease join |
| Runtime target authority | `packages/claxedo-server/src/authority/runtime-target.ts` | link rows |
| Connection info / HTT minting | `packages/claxedo-server/src/connections/user-hosted-connection.ts`, `workspace/route-support.ts` (`hostTunnelCredential`) | per-(host, workspace) |
| Devices list (self-host + desktop synth source) | `deployments/self-hosted-node/remote-access-service.ts` (`activeLinks` → group by host) | link rows |
| Documents local relay | `documents/backends/hosted/local-relay.ts` | link rows |
| Convex authority variant | `authority/adapters/convex/workspace-authority/workspaces.ts` | link rows |
| Register/heartbeat/pause routes | `routes/hosted/workspace.ts` (+ local `workspace/local-host-link.ts`) | challenge + signature verification |
| Desktop child share pipeline (added 2026-09-01) | `claxedo-desktop/scripts/host-connector-entry.ts`, `claxedo-host-connector/src/connector.ts` | hostLink.challenge/register/heartbeat ops |
| CLI / self-host signer | `claxedo-server/src/workspace/local-host.ts` (`local-host-identity.json`) | separate key + same routes |

## Target model

One machine lease, control-plane-owned assignments, one signature for the
served set.

1. **Assignment is data, not crypto.** New control-plane table
   `host_workspace_assignments(workspace_id PK, host_id, org_id, owner_user_id,
   assigned_at, unassigned_at)`. Sharing = the OWNER's authenticated call
   assigns a workspace to one of their enrolled hosts. No challenge, no
   per-row TTL — an assignment has no liveness of its own.
2. **Liveness comes from the enrollment lease only.** The machine-wide
   heartbeat (`host_enrollments.expires_at`) is the single "is this machine
   here" fact. Machine gone ⇒ every assignment inert within the lease TTL.
3. **The machine still attests what it serves — with ONE signature.** The
   enrollment heartbeat payload becomes v2:
   `claxedo.host-enrollment.heartbeat.v2 \n host_id=… \n ttl_ms=… \n
   workspaces=<sorted workspace ids, comma-joined>`. The control plane stores
   the last-acked served set on the enrollment. Routing requires BOTH the
   assignment (owner intent) AND host ack (machine consent) — this preserves
   the security property the per-workspace signature provided (an owner
   session cannot conjure serving of a directory the machine never agreed
   to), at 1 signature per interval instead of N+1.
4. **Routing** (`user-hosted-relay-target.ts` and the runtime-target
   authority) joins `host_workspace_assignments` × live `host_enrollments`
   (not expired/revoked, workspace id ∈ acked set) × workspace posture. Host
   Tunnel Token minting moves onto the heartbeat-ack path for the acked set
   (decision recorded below).
5. **Share UX is unchanged** (tick = share): the tick performs the owner
   assignment call and tells the connector child to add the id to its served
   set (persisted exactly as today in
   `host-connector-shared-workspaces.json`), then forces one beat so the ack
   lands within a second. Unshare (new capability this model makes cheap) =
   unassign + drop from the set.
6. **Devices** groups assignments by host joined with enrollments; the
   desktop keeps synthesizing its one row from the connector snapshot.
7. **secondDeviceOpen** moves from the link row to the assignment row (same
   marker, same writer: `markSecondDeviceOpen`).

### Decisions to confirm during implementation (recorded, not open-ended)

- **HTT scope:** keep per-(host, workspace) Host Tunnel Tokens, minted for
  each acked workspace on heartbeat ack (smallest change to relay admission);
  do NOT widen to a machine-scoped token in this plan.
- **Convex authority variant:** implement the same assignment reads, or — if
  the teams/Convex deployment is explicitly out of scope for the CF line —
  record the deferral in the plan evidence and leave its link reads intact
  behind its own adapter. Decide at Unit 3; deferral requires a note in
  `docs/handoffs/cloudflare-multiplayer-migration.md`.
- **Schema:** additive migration for the new table; `local_host_links` and
  `host_attestation_challenges` stop being written in this plan and are
  DROPPED in a follow-up migration only after the staging acceptance below
  passes (paired-D1 recovery epoch must be re-registered when they drop).

## Units of work

1. **Authority + schema.** Migration for `host_workspace_assignments` (+ acked
   set column(s) on `host_enrollments`, e.g. `acked_workspace_ids` JSON +
   `acked_at`). New `WorkspaceAuthority` methods: `assignWorkspaceHost`,
   `unassignWorkspaceHost`, heartbeat v2 verification storing the acked set.
   Unit tests against the D1 adapter, including the v2 payload literal.
2. **Routes.** Owner-authenticated assign/unassign routes; enrollment
   heartbeat route accepts v2 payload (v1 rejected — no dual-format window on
   the dev staging, per no-fallback policy). Per-workspace
   challenge/register/heartbeat routes removed (hosted + local).
3. **Routing + HTT.** Rewrite `user-hosted-relay-target.ts`,
   `runtime-target.ts`, `user-hosted-connection.ts`, documents local-relay to
   the assignment×enrollment join; HTT minting on heartbeat ack. Spike
   (`better-auth-d1-spike.test.ts`) grows an end-to-end: enroll → assign →
   heartbeat-ack → relay target resolves; unassign/expiry → target inactive.
4. **Connector + desktop.** `claxedo-host-connector`: heartbeat v2 payload
   carries the served set; drop `linkChallenge/linkRegister/linkHeartbeat`
   from the transport. Desktop child/supervisor: share = add-to-set + forced
   beat (no CP round trip in the child); main performs the owner assignment
   call (new op `workspace.assignHost` in the matrix, renderer-withheld NOT
   required — it is owner-intent data like other workspace ops; decide in
   review). Remove the three `hostLink.*` ops from every registry, matrix,
   and contract sample. Boot/supervisor/ipc tests updated.
5. **Self-host node + CLI.** `remote-access-service.ts` devices from
   assignments; `local-host.ts` signer moves to enrollment v2 (the CLI enrolls
   machine-wide exactly like the desktop child; its per-workspace signing
   path is removed).
6. **App.** Share flow calls assign op; shared state reads assignments (the
   devices synthesis stays). Echo-merge guards from 2026-09-01 remain (they
   are grain-independent).
7. **Removal + hygiene.** Delete dead link code paths, run
   `bun run test:architecture-ratchets`, update
   `docs/tech-docs/desktop-hosted-operation-matrix.md` (drop hostLink rows,
   add assignment row), update the handoff doc.

## Definition of Done (exact)

- [ ] Tick-to-share on the desktop performs exactly: 1 owner `assignWorkspaceHost`
      call + 1 forced enrollment heartbeat. Cloudflare observability for a
      share + 10 idle minutes shows ZERO requests to
      `/api/workspace/*/user-hosted/(challenge|register|heartbeat)`.
- [ ] A phone opening the QR link reaches the shared workspace live on the
      staging deployment (relay target resolves via assignment×enrollment).
- [ ] Killing the desktop app makes the relay target inactive within the
      enrollment TTL (observed live, not inferred).
- [ ] Revoke-machine leaves zero routable assignments and an empty devices
      list on both desktop and self-host surfaces.
- [ ] Unshare (unassign) exists end to end and removes the row + tick.
- [ ] `rg -n "local_host_links|hostLink\." packages --glob '!*.test.ts'`
      returns only the D1 migration history and (if deferred) the Convex
      adapter, each with a recorded justification.
- [ ] Spike, connector, desktop, app, server suites green; architecture
      ratchets green; operation matrix and handoff doc updated in the same
      change.
- [ ] Live staging acceptance evidence (worker observability excerpts) pasted
      into `docs/plans/evidence/` per the repo convention.

## Risks

- **Relay admission regressions**: the target resolver is the one consumer a
  wrong join breaks silently (routes 404/refuse). Mitigate with the spike
  end-to-end BEFORE touching staging, then live probes.
- **Two-writer sets**: the served set is written by heartbeat ack while
  assignments are written by owner calls; routing must treat them as AND, and
  tests must cover each side missing.
- **CLI divergence**: `claxedo up` shares must move in the same slice or the
  removed routes strand it — Unit 5 is not optional.

## Adversarial review (2026-09-01, same session)

Findings from attacking the plan against the live code and the live staging
deployment, ordered by severity. The unit order above is superseded by the
revision at the end of this section.

### P0 — the desktop never SERVES what it registers (pre-existing, blocks everything)

Registration is not serving. The relay reaches a workspace only through a
host tunnel the machine holds open, and the tunnel client
(`claxedo-server/src/user-hosted-tunnel.ts`, keyed `${workspaceId}\n${hostId}`
with a per-workspace Host Tunnel Token) lives in the SELF-HOST NODE server —
it was never ported to `@claxedo/local-server` in the split. Verified live:
with two shares registered and heartbeat-renewed, the desktop daemon holds
loopback connections ONLY — zero connections to the relay
(`lsof -iTCP -sTCP:ESTABLISHED` on the daemon, and no process connected to
`claxedo-workspace-relay-*`). A phone scanning the QR resolves the target and
then finds no connected host. Every registration-side fix to date polished a
pipeline whose serving half does not exist on desktop.

Consequence: serving is Unit 0 of ANY plan here, and the tunnel-lifecycle
question ("who starts a tunnel for a shared workspace, with which token, in
which process") is a first-class design input, not an HTT footnote. The
runtime and relay-exposure machinery live in the DAEMON
(`claxedo-local-server` workspace-runtime exposure, kind "relay"); the share
set and the HTT-bearing responses live in the CONNECTOR CHILD. The design
must move the HTT + serving trigger across that boundary explicitly
(child → main → daemon, or daemon fetches with its synced credential).

### P1 — share success must gate on the heartbeat ack, or the QR lies

Under the new model, assignment lands before the machine's consent ack. If
the UI declares "Shared" (and renders the QR) on assignment alone, a failed
or delayed beat leaves a link that routing refuses. The share operation's
success is: assignment write + forced beat returning 200 WITH the workspace
in the acked set. The surface's tick spinner holds until then.

### P1 — set drift needs a reconciliation channel

Owner intent (assignments) and machine consent (acked set) are written by
different parties; without feedback they diverge silently (machine acks a
workspace the owner unassigned, forever). The heartbeat RESPONSE must return
the control plane's assignment view for this host; the child prunes its
persisted set against it and pushes the reconciled state.

### P2 — revocation and dangling assignments

Revoking a machine destroys its key; a later enable enrolls a NEW host id,
so old assignments can never become routable again. `revokeHostEnrollment`
must cascade (unassign or tombstone) its assignments in the same batch, or
the DoD's "zero routable assignments" is true while the table still grows
dangling rows a re-shared workspace then has to displace.

### P2 — single-host-per-workspace is a semantic change (accepted)

`local_host_links` is unique on (workspace_id, host_id) — the old model
tolerated multiple hosts claiming one workspace, and the routing query
picked one arbitrarily. `host_workspace_assignments` keyed on workspace_id
alone makes one-workspace-one-host explicit. This is correct (a local
association id names a directory on one machine) and the ambiguity it
removes was itself a latent routing bug; recorded so nobody "fixes" the
uniqueness back.

### Verified sound (attacks that did NOT land)

- **Heartbeat replay:** `host_signature_uses.signature_hash` is a PRIMARY
  KEY — every signature is single-use, and ECDSA signatures are randomized,
  so each genuine beat differs even over an identical payload while a
  captured one collides with its own prior use. The v2 route MUST keep the
  `signatureUse` insert, and no client may ever retry a beat with a cached
  signature (a retry must re-sign) — the connector already signs per call.
- **Liveness window:** the enrollment lease uses the same TTL bounds as the
  links it replaces (`normalizedTtl`, 5s–5min); off/on behaviour is strictly
  better (intent survives; recovery is one beat), as argued in the plan body.
- **"One relay connection" copy:** aspirational — today's tunnel client is
  per-(workspace, host). The plan deliberately does NOT collapse tunnels into
  one machine connection (that is a relay-protocol change); the enrollment
  consolidation is about the CONTROL grain, and the beat-ack response
  carrying per-workspace HTTs feeds the per-workspace tunnels unchanged.

### Revised unit order

0. **Serve before consolidating (fix on the CURRENT grain first).** Port the
   user-hosted tunnel runner into the desktop stack: HTT flows from the
   child's register/heartbeat responses through main to the daemon, the
   daemon opens the relay host tunnel per shared workspace, and the
   ACCEPTANCE (phone opens the QR live) passes on the existing link model.
   This is the smallest change that makes remote sharing actually work, and
   it de-risks the migration by proving the serving path independently.
1–7. As above, with these amendments: heartbeat-ack response carries
   (a) per-workspace HTTs for the acked set and (b) the assignment view for
   reconciliation (P1s); revocation cascades assignments (P2); share success
   gates on the ack (P1); the spike's end-to-end must include a real relay
   round trip, not just target resolution.

---

## Executed (2026-09-01)

The consolidation shipped, and the hard cut with it: releases 33–35 on
staging carry the machine-wide grain in all three authority adapters, the
assignment routes, the relay-target resolver, the desktop/CLI/self-host
clients, and migration `0015` dropping `local_host_links` and
`host_attestation_challenges` from the live database. The repo-wide sweep is
clean apart from the historical migrations that created those tables.

Proven live: a browser on the public internet reached this laptop's workspace
runtime through Cloudflare and the relay —
`{"ok":true,"status":"ready","service":"workspace-runtime"}` — with the
machine enrolled, both workspaces assigned and acked, and the lease renewing
every ~20s.

### What the plan did not anticipate

Every remaining failure was a seam whose two sides were written apart, and
none were visible to unit tests. Recorded here because the pattern, not the
individual bugs, is what a future migration should expect:

- The daemon's serving route validated a locally invented credential shape
  while the control plane sent the signer's result, so **every real ack was
  rejected 400** and no tunnel ever opened. Now pinned to
  `HostTunnelTokenSignerResult` at compile time.
- The tunnel replayed the remote caller's headers onto its own loopback
  request; Cloudflare's `cf-connecting-ip`/`x-forwarded-*` and the browser's
  `Origin` each independently made a genuinely local request look proxied to
  the daemon's unsigned-local gate. Fixed for HTTP **and** the WebSocket
  upgrade through one seam.
- Bootstrap awaited three control-plane round trips inside a 10s budget on an
  edge that stalls ~12s. Bootstrap now means "alive with an identity";
  enrollment has its own 45s budget.
- Serving outlived its credential, so the desktop claimed "Serving 2
  workspaces" while the control plane answered 409 and a phone was correctly
  told the host was offline. Serving is now leased to `tokenExpiresAt`.
- Release 33's browser bundle shipped broken — its artifact gate **failed and
  was overridden**. The deployed app loaded every asset, threw no errors and
  rendered nothing. Do not proceed past that gate.
- Boot awaited auth initialisation unbounded, so a stalled `get-session`
  produced an infinite spinner with no error and no recovery. Bounded at 20s
  into the startup-failure panel.
- A ~2s deploy 503 permanently un-published the machine through a five-link
  cascade ending in a Clerk-era reading of `invalid_bearer_token`. See
  `reference_transient_auth_blip_cascade` in session memory; all five links
  are fixed.

### Executed 2026-09-01/02 — from "green dot" to a usable workspace

The hosted app reached "Self-hosted · Connected via relay" for a laptop
workspace, and then every read the workspace needs failed one at a time.
Each was a seam with two sides written apart; each is now pinned by a test
that fails when its fix is removed.

- **Deploy window revoked the machine** (`71202a3f08`). A control-plane
  release answers `503 deployment_candidate_unavailable` for the seconds
  between upload and dev-open; the connector read any heartbeat error as
  revocation and stopped for good. Every deploy silently took remote access
  down, and the daemon kept saying `serving: true` because its token lease
  had not expired — the same symptom as a real revocation. Only a decisive
  status (400/401/403/404/409/410) revokes now.
- **Relay refused the machine's tunnel** (`09c229b82d`). Durable Object rooms
  are per workspace; the daemon dialled one tunnel naming every workspace and
  the relay rejected it at the gateway (`host_tunnel_single_workspace_required`).
  One connection per workspace, one machine-wide token (the relay checks
  membership, not equality). `connected` now means every served room has a
  socket.
- **Browser gates the server never sees**: `last-event-id` missing from the
  control plane's CORS allow-list (`b136556ce3`), and the app sending the
  control-plane cookie to the bearer-authenticated relay (`6c923c27d6`,
  corrected for the app/API split-host topology in `7f37cbd352`). Both
  refused in the browser before any request left; nothing logged anywhere.
- **`/api/control/session-list` absent from the hosted roots** (`be1b60c813`).
  The workerd migration dropped it (it lived only on the Node roots'
  `ControlPlaneSessionRoutes`). Now ONE shared `signedSessionList` behind the
  canonical route and both hosted roots; the redundant `x-opencode-directory`
  client header — which the preflight refused — removed.
- **`/provider` 403 through the relay** (`9a2e386102`). The tunnel guard
  refused a route the ownership table called central while the workspace
  runtime served it. Reclassified EXACT (children stay central), after giving
  the runtime a host-injected `providerCatalog` seam so non-opencode
  harnesses do not regress from the compat router's 200 to a 502.
- **Control plane rendered "404 Not Found" as a page** (`222a9643d0`,
  `678d8b5011`). Root now redirects to the app; unrouted paths answer JSON.
  The first version read `CLAXEDO_APP_ORIGINS` while the locked worker binds
  the singular — caught live on release 40.
- **Staging desktop QR pointed phones at production** (`cad4fd0161`).
  `VITE_CLAXEDO_APP_ORIGIN` was read but never forwarded through the
  renderer's `define`.
- **`acp-connections` 404 on hosted** (`e22c8e90a3`) — cosmetic; the client
  already degrades to "no ACP group".

Releases 37–40 carried the server-side fixes to staging. Release 41 (root
redirect env name) is composed and pending.

**Dev-launch trap, recorded because it cost most of a day:** `electron-vite dev`
with no `VITE_AUTH_ENABLED=true` builds an UNSIGNED renderer. The Host
Connector still works over raw IPC, but the renderer never binds its
remote-access port or account surface, so Settings → Devices says "Remote
access is coming soon" and there is no way to sign back in after logout —
while the machine is enrolled and serving underneath. Launch a signed desktop
with `VITE_AUTH_ENABLED=true VITE_CLAXEDO_APP_ORIGIN=<app origin>
CLAXEDO_CORE_ORIGIN=<api origin>`.

### Corrected 2026-09-02 (later the same day)

The "Verified" section above overclaimed. The workspace rendered and the
relay reached the laptop, but the user's acceptance — create a session on the
machine, then see and open it in the hosted app — did not hold: the hosted
app's sidebar read the control plane's registry, which holds nothing for a
user-hosted workspace (sessions created on the machine never register; the
app's placement table already says the control plane has no session store for
user-hosted). What changed, all on `codex/cloudflare-multiplayer-migration`:

- `signedSessionList` pulls a user-hosted workspace's sessions from its host
  through the relay (`pullHostedControlSessionList`), in both direct and
  project scope; the hosted relay provider records user-principal tokens under
  the signed caller (`recordRelayRuntimeToken`) instead of the service-only
  path that refused every real user. Deployed as staging release 42; the
  sidebar lists the machine's sessions (seen in the user's Chrome).
- Pulled rows no longer carry the host's filesystem path as `directory`
  (release 43); the app routes session reads through the relay again instead
  of `?directory=/Users/…` against the control plane.
- The host tunnel guard admits the runtime's identity probe
  (`/global/health` on the workspace surface) — the classifier models the
  daemon's ROOT surface only. Desktop bundle rebuilt; the guard runs on the
  laptop.
- Sign-in state: "Cancel sign in" only while pending; sign-in while signed
  keeps the session; a failed profile lookup stops the spinner.
- Session load/switch instrumentation (`session-perf.ts`), phase-gate CORS,
  and `timing-allow-origin` on the control plane and relay.

Still NOT verified: opening a listed session from the hosted app. Two blockers
were measured, neither in application code: (1) the laptop's host connector
stops whenever one control-plane call resets or stalls (the account flips to
"unavailable", the single resume attempt's enrollment times out at 45 s), and
(2) requests from a browser or the desktop to the control-plane host
intermittently never reach the worker (worker tail shows the descriptor
arriving in 55–250 ms wall time while the same page's sign-in request never
arrives; curl saw 4–17 s TTFB with 104 ms worker wall time). That is the edge
or transport, and it needs zone-level decisions (HTTP/3, bot/browser-integrity
checks, the Safe Browsing flag on the host) that are the owner's.

### Verified 2026-09-02

The workspace renders in the hosted app end to end, observed in a browser
rather than inferred from a server probe: `app-acc-stg-…/w/5f39af3e-…/session`
shows `5f39af3e-… · Self-hosted`, the composer, and **Select model** — the
model catalog reached the UI, which means `/provider` crossed the relay to the
laptop (200 with a real `all[]`, where it had been an empty 403). Both shared
rooms hold live sockets; `/session` through the relay returns the machine's
real session list. The signed desktop's Devices panel shows Connect a device /
Pause / Revoke rather than "coming soon".

Still open: the hosted WEB app's Settings → Devices binds the retired HTTP
remote-access port (`main.tsx`) and reads 404 → "locked"; the desktop is
unaffected. The desktop's own account token refresh timed out against the
control plane twice in one evening (`token endpoint timed out after 21998ms`,
then `userinfo failed: 401`), which signed the desktop out and unpublished the
machine; that transport stall is the same class recorded in
`reference_transient_auth_blip_cascade` and is not addressed here.

### Corrected 2026-09-02 (second pass: full web access, measured)

Goal restated for this pass: enroll a device on the desktop, then do from the
web client everything the desktop does against that device's workspace, over
the relay, with no perceptible lag. Every defect below was found by evidence
from the real clients (CDP against the desktop renderer; the browser pane's
`performance` resource entries and fetch probes against the hosted app;
`wrangler d1` reads and `wrangler tail` against staging), and each fix removes
the cause rather than patching the symptom. Staging releases 47–51.

- **Desktop "Workspace failed to start / connection 404"** (`0dcfc9d4b1`).
  A signed-in desktop fetched its shell and global bootstrap through the
  AccountPort and resolved every directory against the control plane first,
  so the renderer's project inventory was the control plane's hosted list.
  Once a share carried the workspace's real directory, the machine treated
  its own worktree as user-hosted and tried to reach itself over the relay.
  The app server now owns its bootstrap; a directory never leaves the
  server; only a workspace id the server disowns is asked of the control
  plane. `account.get` had no caller left and is gone from the port, the
  desktop operation table, and the operation matrix.
- **Web composer stuck on "Harness OpenCode / No model results"** — four
  layers, each proven before the next was touched:
  `3e68cee416` the hosted harness status route existed but its probe was
  never composed into either hosted root (every call answered
  `workspace_not_found`), and the body lacked the `harness`/`activeHarness`
  identity the app decodes; `4eef1bc45d` a web draft never asked for the
  status at all (`shouldHydrateDraftFromHarnessStatus` was loopback-only);
  `ec917791ab` the draft hydrated before the signed inventory loaded, so the
  kind was unknown, the seed harness was committed and the scope marked seen
  forever — a `workspace:` draft now resolves its record first, and the
  store's workspace-runtime predicate reads the inventory it already has;
  `67f5799ec2` the status request carried only the machine's filesystem path
  as `directory`, which the hosted shell cannot map — requests carry the
  workspace id and the shell treats the id as the identity.
- **Web send reserved a session and then did nothing** (`835a074f90`). The
  runtime-session gate resolved the workspace without the inventory, the
  prepared-session plan was disabled, and the claim's `undefined` was
  swallowed. The gate reads the inventory-backed ref, a claim that cannot
  start a session throws its reason, and the submit reports it through the
  same call-site reporter as an OpenCode create failure (`onCreateError`).
- **"Retry sharing controls" on every host-created session** (`f91f492f25`).
  The control plane denied the share listing for sessions its registry
  never held. Listing shares for a session the authority does not hold now
  answers an empty, unmanageable context to a workspace reader, which the
  web already renders as no sharing controls; strangers are still refused.
- **Dead workspaces in every client's inventory** (`9b88098572`). Unsharing
  or revoking deleted the host assignment and left the user-hosted workspace
  row behind (two such rows on staging, whose ids the daemon no longer
  served). A user-hosted workspace now lives exactly as long as its host
  assignment: unassign retires it, revoking a machine retires everything it
  served, sharing again revives the same record; cloud rows are untouched;
  mirrored in the sqlite authority. The two staging rows were retired through
  the desktop's own unshare.

Measured from the browser after release 51 (staging, Singapore edge):

| Step (web client, over the relay) | Time |
| --- | --- |
| Enter → session reserved on the control plane | 0.99 s |
| → `POST /session` on the host through the relay | 1.09 s |
| → prompt dispatched (`prompt_async`) | 0.75 s |
| → new session screen, messages ready | 0.58 s (≈2.2 s from Enter) |
| Harness status (control plane → relay → host) | 2.3–2.9 s |
| Harness model options (relay → host) | 0.5–1.3 s |
| Transcript (52 messages) after route start, warm plane | 0.2 s |
| Same, first cold open after a deploy | 7.8 s (13.5 s from navigation) |
| Relay event streams held open from the browser | 75–80 s and counting |

A curl attach to the relay `/global/event?sessionID=…` received busy,
message.updated, message.part.updated, text and session.error events live
while a prompt ran (222 events in 28 s).

Not verified, with the blocker named: no harness on the machine can currently
ANSWER a prompt — `claude auth status` reports logged out, Codex answers
"You've hit your usage limit", the Cursor SDK needs an explicit API key, and
OpenCode has no providers configured. Session creation, dispatch, live event
delivery and the error turn are proven; a streamed assistant reply is not,
and only the machine's owner can log a harness in. Shell and summarize answer
409 `unsupported_operation` for the claude and codex harnesses on the runtime
itself — identical on the desktop, so not a parity gap. The web Settings →
Devices panel could not be driven from the hidden browser pane (its rail and
account menu do not mount while the page is hidden); the route it reads
(`/api/claxedo/remote-access/devices`) answers the machine "macOS" with its
four workspaces. The control plane's own `/api/wr/events` stream closes every
16 s and the app reconnects; the relay streams do not.

Pre-existing on the branch, untouched: 78 failing bun tests in `claxedo-app`
(legacy `codex-acp` identity expectations under `features/session/harness`,
credential resolution, new-session handoff); the desktop's hosted-transport
stall-recovery retry (`a6259627f8`) remains and is corrective code now that
the HTTP/3 cause is known.

### Consolidated 2026-09-02 (Phase 2) — audited, rewritten, re-verified

Grouping (`git log dev..HEAD`, 104 commits at the time) into five reviewable
sets, in dependency order: (1) hosted control plane and authority
(`claxedo-server`, `claxedo-server-core`, services, D1/Convex, deploy
scripts); (2) workspace runtime and agent-sdk-runtime capabilities; (3)
desktop machine-wide remote access (`claxedo-desktop`,
`claxedo-host-connector`, `claxedo-local-server`); (4) web app routing,
harness resolution, boot, sharing UI (`claxedo-app`); (5) docs, plans,
handoffs, lockfile chores. Two checkpoint commits (`0025eb0f46`,
`903b2d4dec`) and five smaller ones touch three or more groups and must be
split by directory when the PRs are cut; the file-level map is in the
grouping analysis.

Audit findings and what changed, by group:

- **Hosted control plane** (`ededee7f45`): the Better Auth D1 spike worker
  lived under `platform/auth` and imported domain modules — moved next to the
  workers it proves; `GET /api/claxedo/agent-config/harness/acp-connections`
  and `GET /api/claxedo/remote-access` answered anonymous callers — now
  signed-only; the recorded frontend, self-hosted route-set, and
  deployment-closure contracts name the owners that moved them; the
  documents integration mock, deploy fixture, and remote-access test follow
  the current contracts; the public guide is regenerated.
- **Relay** (`62e23bc88c`): `bun.ts`, `cloudflare.ts`, and `server.ts` each
  spelled the user-hosted routing predicate themselves, one as the inverse of
  a two-member union; `user-hosted-forwarding.ts` owns the predicate, the
  socket-kind tag, and the cookie-stripping rule.
- **Desktop** (`96ba837abc`): the edge-stall retry layers were corrective
  code over causes fixed at their owners (unsettled composition memoization,
  HTTP/3 on the browser path, keep-alive reuse in Electron). A hosted request
  is one attempt with one deadline; the refresh-failure window stays as its
  own invariant; incident narration in comments became design statements.
  The connector's status carries the heartbeat-renewed lease, and a session
  deleted through the workspace surface publishes `session.deleted` to the
  desktop.
- **Web app** (`988b5f4bbf`): "user-hosted workspace" is one abstraction —
  `isRelayBackedWorkspaceKind`/`isUserHostedWorkspaceKind` in
  `platform/runtime/agent/workspace-kind.ts` replace ~24 inline checks, three
  redeclared unions, and two duplicate hosting derivations; an unresolved
  relay-backed ref is never guessed as cloud; a signed submit takes its
  workspace from the runtime-ref owner; session-config saves carry the
  access-qualified harness identity (an operator ACP session no longer fails
  every save). The debt baseline fell from 61 to 39 user-hosted comparisons.
- **Tests**: 78 bun + 7 vitest failures in `claxedo-app`, 13 in
  `claxedo-server`, 4 in `claxedo-local-server`, 1 in `claxedo-desktop` were
  pre-existing on the branch (retired `*-acp` harness ids, stale
  source-text assertions, contracts changed by checkpoint commits). All now
  assert the current contracts; two real bugs surfaced and were fixed (the
  signed submit workspace id; the session-config identity shape).

Re-verification after consolidation: every package's own test script and
typecheck green (`claxedo-app` bun 6000/0, vitest 1152/0; `claxedo-server`
full suite; `claxedo-server-core` 529; `claxedo-local-server` 305;
`claxedo-desktop` 749; `claxedo-host-connector` 38; relay, runtime,
agent-sdk-runtime green); `bun run test:architecture-ratchets` holds.
Staging release 53 (the consolidated branch) verified in the browser:
transcript renders (messages ready 1.1 s after route on a reload), the
picker shows the session's saved model, shares and devices answer, anonymous
status is refused, no Retry control. The desktop was relaunched on the
rebuilt daemon bundle: signed, enrolled, all four workspaces shared, lease
live.

Operational note: dev-open's wrangler config had lived only in a release
temp directory; it is now rendered from the release module's own exported
renderer into a durable file, so the dev-open script no longer depends on a
leftover of an earlier run.

### Closed 2026-09-02 (the two gaps the stop hook named)

- **Web Settings → Devices** verified in a fresh browser tab where the rail
  mounts: account menu → Settings → Devices lists the enrolled machine
  "macOS", last seen seconds ago, serving 4 shared workspaces, with Revoke.
- **Live stream attach from the web** (`42bac669b6`, release 54). Two
  defects sat under it. The app's stall watchdog (15 s) was shorter than the
  runtime's stream heartbeat (30 s; 2 min on the session stream), so over the
  relay every quiet stream was aborted and counted as a failure; the desktop
  never saw it because the daemon's own compat stream heartbeats every 5 s.
  One contract now owns both numbers (`EVENT_STREAM_HEARTBEAT_MS` 10 s,
  `EVENT_STREAM_STALL_MS` 30 s in `@claxedo/agent-event-runtime/contracts`),
  used by every runtime producer and by the app's watchdog. Separately the
  web posted control-plane projection pulls (`…/sessions/<id>/checkpoint`)
  every turn for sessions the machine owns, refused with 403 each time;
  projection is only for sessions the control plane holds (cloud).
  Measured on release 54 from the browser: relay per-session event stream
  open 260 s, runtime events 257 s, then reconnected; a turn sent from the
  web reached the host in 0.7 s (`prompt_async`) and the web's message list
  grew within 3.0 s as the turn's events arrived; a curl attach to the same
  stream shows `server.heartbeat` every 10 s. Note for future measurement:
  a `PerformanceResourceTiming` entry appears only when a stream closes, so
  an "absent" stream entry means an open stream, not a missing one.
- Still true: no harness on this machine holds a working credential, so the
  turn's live events end in the provider's error (Codex usage limit) rather
  than a completion; the live path is verified up to and including that
  error event. Logging a harness in is the owner's step.

## Merged with dev 2026-09-02

The branch was 113 commits ahead of and 46 behind local `dev`, with 114 files
changed on both sides and two checkpoint commits carrying most of the branch's
delta. A commit-by-commit rebase would have re-resolved dev's runtime
refactors at every checkpoint, so dev was merged in once (`d98181076a`); the
pre-merge tip is tagged `pre-rebase/cloudflare-multiplayer-migration-2026-09-02`.
The branch is now 114 ahead and 0 behind dev, so each PR group diffs cleanly
against dev.

Verification after the merge (all run from the worktree):

| package | command | result |
| --- | --- | --- |
| agent-sdk-runtime | `bun run typecheck`, `bun run test`, `check:source-shape`, `verify:public-api` | clean; 601 pass |
| workspace-runtime | `bun run typecheck`, `bun run test` | clean; 984 pass, 3 fail (dev-inherited, below) |
| claxedo-server-core | typecheck, test | clean; 534 pass |
| claxedo-server | typecheck, `vitest run` | clean; 3554 pass, 4 fail (dev-inherited, below) |
| claxedo-local-server | typecheck, test | clean; 296 pass |
| claxedo-desktop | typecheck, `bun run test` | clean; 752 pass, 2 fail (dev-inherited, below) |
| claxedo-host-connector, workspace-relay, agent-event-runtime | typecheck, test | clean; 38 / 335+78+13 / 141 pass |
| claxedo-app | `bun run typecheck` (tsgo + architecture), `bun run test`, `bun run test:vitest` | clean; 6036 pass; 1170 pass, 2 fail (dev-inherited, below) |
| repo | `bun run test:architecture-ratchets` | product boundary holds; ceilings exact (app-local 957/38, desktop-renderer-unsigned 1043/59, desktop-main 87/24, local-server 60/21, hosted-node 154/28, self-hosted 155/35) |
| repo | `bun install --frozen-lockfile --dry-run` | lockfile consistent (the run then stops at the known opencode postinstall) |

Failures inherited from dev (each reproduced byte-identically on a detached
`dev` worktree; none touch branch-owned code):

- `workspace-runtime/src/workspace/runtime.test.ts` ×3 (`s-lazy`, `s-mem`, `s-disk`): dev's authoritative runtime refuses `PATCH /session/:id/config` for an id the store never bound, and these tests still materialise the store through that call.
- `claxedo-server/src/opencode/compat-routes/auth-gate.test.ts`: dev `9d48806d7e` mounted `/api/claxedo/events` inside the compat router, which its own auth-gate contract says is parent-owned.
- `claxedo-server/src/tests/integration/session-grouping.integration.test.ts:102`: dev `29aebaa9f1` made local workspaces store `local:` refs; the expectation still says `workspace:`.
- `claxedo-server/src/session/runtime.test.ts:1226`: dev's `abort()` releases admission before the turn publishes its terminal error.
- `claxedo-server/src/authority/two-user-runtime-transport.acceptance.test.ts:508`: dev's internal merge `34cca15f58` dropped `author` from the `PromptInput` built in `turns.start`.
- `claxedo-desktop/src/main/diagnostics/spawn-inventory.test.ts` ×2: dev `e4105227e3` renamed the codex driver to `app-server-process.ts`; the inventory still lists `driver.ts`.
- `claxedo-app/src/app/workbench/rail/workspace-panel-disposal.vitest.tsx` ×2: 10 s timeouts on dev as well.

## Re-verified live after the dev merge 2026-09-02 (release 55)

Release 55 (`release-acc-devmerge-260902-123000-3851`, cutover + deploy, then
dev-open; ledger stateRevision 146 `open`) carries the merged tree. The desktop
was rebuilt (`bun run predev`) and relaunched from the worktree. dev's
per-worktree dev identity gave this worktree a fresh Electron profile, so the
desktop signed in again (GitHub OAuth completed on the existing authorization
in 5 s) and enrolled as a NEW machine, `host_YVi6…`; the four workspaces were
re-shared from it and the daemon reports `connected` sockets for all four.

| requirement | evidence | measured |
| --- | --- | --- |
| 1 enroll | `hostConnector.start()` → `enrolled`; D1 `host_enrollments` row for `host_YVi6…` | lease renewed every beat |
| 2 device + workspaces | web Settings → Devices: "macOS · Last seen 02/09/2026 12:55:39 · 4 shared workspaces · Revoke"; rail lists Claxedo, agent-app-benchmark, formlink, project-three | |
| 3 session list | `/api/control/session-list` served from the host pull | 2.57 s cold |
| 4 transcript | session 044d2435 (52 messages) over the relay | cold reload: screen 731 ms after navigation, first fold +64 ms; warm switch to "Greeting": screen 55 ms, messages 832 ms; cached switch back 38 ms |
| 5 create | draft `/session/new` → reserve 1.23 s → relay `POST /session` 1.32 s → `prompt_async` 0.62 s (dispatched at +4.1 s); session `20840090` present in the daemon's own list with the prompt as title | |
| 6 live stream | the turn's provider outcome ("Usage limit reached" / `authentication_failed`) rendered from the stream without reload; sidebar picked the new session up live | error at ~+6 s |
| 7 parity | Devices management, sharing, session config, shell/summarize routes over the relay; `GET /agent` answers 409 `unsupported_operation` when the harness has no agent listing (honest, not a gap) | |

Still unmet: a completed model reply (every harness on the machine lacks a
credential; entering one is the owner's).

Two defects surfaced and were fixed in `e7e942fd2e` and `e93ed55de6`: the web
posted control-plane projection calls (`…/checkpoint` per message event and
`…/register` after create) for user-hosted sessions, which the hosted Worker
control plane cannot serve ("Session projection store is not available in the
hosted Worker control plane", 500; 403 for checkpoints). Both callers now ask
the projection owner (`sessionProjectionBacking`), which projects cloud
sessions only. Release 56 carries the fix.

Release 56 (`release-acc-ingress-260902-131500-3851`, ledger stateRevision 148
`open`) confirmed the fix from the web client: draft → reserve 1.05 s → relay
`POST /session` 2.34 s → `prompt_async` 1.22 s, session `3a1e12ce` on screen
with its message 1.5 s after the route change, zero `…/checkpoint` or
`…/register` calls, no 4xx/5xx on the send path, and the live stream carried
the provider outcome ("Usage limit reached") without a reload. The desktop
connector stayed `enrolled` with all four relay sockets open through the
release's lock window.

## "Signing in did not respond within 20s" — diagnosed and fixed 2026-09-02 (release 57)

Both the pane browser and the owner's Chrome failed to boot the hosted app
with the 20 s sign-in timeout while curl from the same Mac answered in
0.2–0.7 s. The worker tail decided it: `wrangler tail` reports an invocation
only when it ends, so a request the worker holds forever is invisible until
the client gives up, when it appears as `outcome: canceled` with a few ms of
CPU. The browsers' `/api/auth/get-session` calls showed up exactly that way
(707 s / 15.9 s wall, 6–7 ms CPU), and 1 of 20 fresh-connection probes to an
adapter-touching auth route hung the same way on a HKG isolate. Anonymous and
bad-signature cookie requests never reach the auth database and answered
instantly on the same connections; only requests that read the auth database
hung. A browser stays pinned to one isolate over keep-alive, so one wedged
isolate took both browsers down together.

Cause: `authReady` (the settled-composition rule's readiness) awaited only
Better Auth's `$context`. The first auth-database read still happened on the
first signed-cookie request, and the first control-plane read on the first
hosted route; a cancellation during that read left a reusable composition
whose adapter path never settles. Fix `3e2b97dd15`: readiness now includes a
session lookup through the adapter and a control-plane `select 1`, so a
composition is reused only after both databases answered through it
(`better-auth-d1-compose.ts`, test "is reusable only after both databases
answered through it"). The earlier note blaming the edge for this symptom
was wrong and is corrected in the memory notes.
