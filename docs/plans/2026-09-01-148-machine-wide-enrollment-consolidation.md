# Machine-wide enrollment consolidation (retire per-workspace host links)

Date: 2026-09-01 · Branch: `codex/cloudflare-multiplayer-migration` · Status: PLANNED

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
