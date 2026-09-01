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
