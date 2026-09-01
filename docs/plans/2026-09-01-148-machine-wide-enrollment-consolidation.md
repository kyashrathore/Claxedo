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

### Not yet verified

The workspace rendering in the hosted app end to end. The transport is proven
(the health round trip above), but the desktop's refresh grant died during the
token-rotation incident, so a fresh interactive sign-in is required before the
final UI acceptance can run.
