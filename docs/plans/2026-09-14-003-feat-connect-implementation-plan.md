# Remote machine connection: implementation plan

Status: P1–P3 implemented on branch `feat/connect` (2026-09-14–15), reviewed twice (Fable + Codex) with every finding fixed, live-proven on the fixture (12/12 + 1 fixme) and on real EC2; P4–P7 not started. Revision 4. Builds on the investigation
(`2026-09-14-001-feat-connect-enrollment-foundation-proposal.md`) and the
component map (`2026-09-14-002-feat-connect-components-and-flows.md`). Nothing
here is authorized until the product questions in §0 are answered.

## 0. Decisions this plan assumes (answer before phase 1)

| # | Question | Assumed default | If answered otherwise |
|---|---|---|---|
| Q1 | Do ordinary org members see invitation-enrolled hosts' workspaces? | No implicit org-member access (direct, project and org-admin access unchanged) | drop P1.5's `org_member_visible` column |
| Q2 | Bearer invitation defaults | 1 h, single use, scope required | constants in P1.3 |
| Q3 | Does the signed desktop daemon get private sessions? | Yes, in P7 | P7 shrinks to the heartbeat switch |
| Q4 | Claxedo starts/stops user compute? | Never | — |
| Q5 | Remote access survives desktop quit? | No | — |
| Q6 | Where do user-hosted session histories live? | On the host; CP keeps index + checkpoints (P6) | P6 becomes index-only |
| Q7 | Two live instances of one enrollment (restart before lease expiry, cloned disk) | A starting instance explicitly **acquires** a new server-issued serving generation; the previous generation's beats and tunnel are refused; the change is recorded and shown. A holder of the same key can always take over deliberately — the fence orders instances, it cannot exclude a key holder | "first wins" makes restart-before-expiry wait up to one lease |

## 1. Shape of the work

Seven phases. **P1–P3 is the first slice**: invitation-file bootstrap, a
machine-authenticated heartbeat, assignment discovery, durable restart and
redeem recovery, serving with private sessions, and a live acceptance run.
Deferred from the slice: pending approvals (P4a), host
folder operations (P5b), project regrouping, idle/stale metadata, the desktop
policy switch.

```
P1 control plane: machine caller, invitations, scope, assignment descriptions
P2 host: shared serving package, machine-signed transport, bootstrap + durable state
P3 claxedo connect command + service + Tier R fixture host
P4 app: remote access panel (machines, invitations); P4a pending approvals (deferred)
P5 app: composer environment/worktree chips, create-project location; P5b host folder ops (deferred)
P6 unattended checkpointing and offline index (registration already exists)
P7 desktop: machine-signed beats; private sessions when serving (Q3)
```

Operating rules for every phase:

- One canonical owner per behaviour. The CLI's copy of the payload builders,
  the daemon-only serving loop, and `claxedo up` are replaced, not paralleled.
  Session registration reuses the runtime's existing private-session path.
- The D1 and SQLite authorities differ in schema (SQLite keys enrollments by
  `owner_token_identifier`, stores `public_key`, has no signature ledger, and
  keeps sessions in `session_history`). Every P1/P6 item names its SQLite
  mapping explicitly and ships a migration for existing databases, with an
  upgrade test that preserves account enrollments, revoked identities,
  assignments and session ownership.
- Every new control-plane route is added to the hosted operation matrix and
  its inventory test in the same commit.
- No fallback paths: a host with no key and a used token exits; a beat from a
  superseded instance stops; a path outside the roots is refused.
- Comments follow the repo rule (constraints and invisible behaviour only).
- `bun run test:architecture-ratchets` after every phase that adds a
  production import; raise a ceiling only with the measured number.

---

## P1 — Control plane: the machine has its own standing

### P1.1 Machine identity and verifier

**Identity.** `host_id` is unique only per owner today (D1 `unique (owner_actor_id, host_id)`;
SQLite `UNIQUE (owner_token_identifier, host_id)`). The machine therefore
signs and presents its **`enrollment_id`** (the primary key, globally unique),
not its host id. The enrollment response of redeem/enroll returns it; the
host persists it beside the key (P2.3).

**Verifier.** New `packages/claxedo-server-core/src/platform/auth/machine-auth.ts`,
**route-local**: it is a function the heartbeat and checkpoint routes call, not
a new member of the general `ControlPlaneAuthContext`, so no other route can
accidentally accept a machine as an owner-equivalent caller.

- Headers: `x-claxedo-enrollment-id`, `x-claxedo-host-ts` (epoch ms, integer),
  `x-claxedo-host-nonce` (16–64 base64url chars), `x-claxedo-host-signature`
  (ECDSA P-256 / SHA-256, IEEE P1363, base64url).
- Signed bytes, exactly: `claxedo.machine-request.v1\n<METHOD>\n<pathname>\n<sha256(body) hex>\n<ts>\n<nonce>\n<enrollment_id>`.
  The body's `enrollmentId`/`hostId` fields must equal the header and the
  row; mismatch → 401.
- Order of checks, cheapest first: body size cap (16 KiB, applied by the
  route itself with `bodyLimit`, because the hosted app's IP guard is outer
  middleware and a self-hosted mount may not have it) → IP budget → header
  shape → ts skew ≤ 60 s → enrollment lookup by `enrollment_id` → eligibility
  → signature → nonce consumption. Only then per-enrollment rate limiting
  (120/min keyed `machine:<enrollment_id>`).
- **Eligibility, adapter-neutral:** `revoked_at is null and paused_at is null`,
  the row's `key_version` equals the one the verifier read, **and the owner
  is eligible**. D1: owner user and actor rows exist with state `active`
  (it has `users.state`/`actors.state`). SQLite: the owner's `users` row
  exists (its `users` table has no state or deleted column and there is no
  `actors` table — the predicate is row existence and nothing else, written
  in the SQLite adapter, not copied SQL).
- **Key version:** new column `host_enrollments.key_version integer default 1`,
  incremented by the account re-enroll upsert (`on conflict (owner_actor_id, host_id)`)
  whenever `public_key_json` changes. Every machine-caller mutation (heartbeat,
  acquire, checkpoint) is guarded **inside its batch** by the whole eligibility
  predicate — `enrollment_id = ? and key_version = ? and revoked_at is null and paused_at is null and <owner eligible>` —
  so a request verified against a key that was replaced, or an owner suspended,
  between verification and mutation writes nothing (assertion row +
  `guardedBatch`, the existing pattern). The verifier's pre-check is the cheap
  refusal; the in-batch predicate is the guarantee.
- **Replay store**: new table `host_request_nonces (enrollment_id, nonce, expires_at, primary key (enrollment_id, nonce))`
  with an index on `expires_at`, in both adapters; insert-or-fail is the
  consumption; rows expire at `ts + 120 s`. Sweep: `delete from host_request_nonces where expires_at <= ? limit 500`
  (exact rows by expiry, run inside the heartbeat batch like
  `expiredRowSweep` but written for this table — the existing helper deletes
  by a single id column and must not be pointed at `enrollment_id`). The
  `host_signature_uses` ledger keeps its domain and is not widened.
- Output: `{ enrollmentId, hostId, ownerUserId, ownerActorId, scope, keyVersion, generation }`.

Tests (`machine-auth.test.ts`, run against both adapters through the port):
fresh request accepted; each refusal above with its status; identical request
twice → second 401; body tampering; ts at exactly ±60 s; nonce reuse after
expiry sweep is still refused within the window; suspended owner → 403.

### P1.2 Heartbeat accepts the machine caller; assignments become descriptions

`packages/claxedo-server/src/routes/hosted/host-enrollment.ts`:

- `/heartbeat` tries the account path first (`signedOrError`); if there is no
  account principal **and** the machine headers are present, it calls the
  machine verifier. All other routes are unchanged and never call it.
- Body v3 (machine callers): `{ enrollmentId, hostId, generation, acks: [{ workspaceId, revision }], ttlMs?, sessionAuthority? }`.
  The request signature (P1.1) covers the body; the v2 payload signature is
  not sent by machine callers (one boundary, not two). Account callers keep
  v2 unchanged until P7.
- Response gains `assignments: [{ workspaceId, remoteDirectory, displayName, revision }]`,
  `scope: { revision, allowed_roots, visibility }` (the enrollment's current
  scope, versioned), `relay: { url, jwksUrl }`, `authority: { sessionAuthorityUrl }`,
  and keeps `assigned_workspace_ids` for the desktop until P7.
- **Assignment revision is a strictly increasing integer**, not a timestamp:
  new column `host_workspace_assignments.revision integer not null default 1`.
  `assignWorkspaceHost` writes the workspace's `remote_directory` and
  `revision = revision + 1` **in one batch**, so a description never shows a
  new directory with an old revision or two changes with one revision. (Today
  the directory update and the assignment upsert are separate statements with
  a `Date.now` timestamp; both adapters change.)
- **Readiness is authoritative state, not a minted token.** New table
  `host_assignment_readiness (workspace_id pk, enrollment_id, generation, revision, ready_at)`,
  written by the heartbeat from the host's `acks`. The canonical serving
  predicate (`HOST_SERVING_WORKSPACE_SQL` in D1 and its SQLite twin) changes
  from "assigned ∧ id in acked set ∧ live lease" to "assigned ∧ readiness row
  matches (enrollment, current generation, current revision) ∧ live lease".
  Everything that decides routability reads that one predicate — the tunnel
  credential mint, `activeWorkspaceHost`, the catalog's `host_online`, and
  `/internal/relay/target` — so a re-pointed directory stops routing and
  disappears from "online" on the next read, not only from the next token.
  `acquire` deletes readiness rows of prior generations in its batch, so a
  superseded instance's readiness cannot keep a workspace routable.
- The host applies a response only if its `generation` matches and no
  per-workspace revision goes backwards; overlapping responses cannot restore
  a stale description.

Authority (both adapters):

- `heartbeatHostEnrollment` gains a second entry point
  `heartbeatHostEnrollmentByMachine(machine, args)` that shares the mutation
  with the account path; `who` is the row's owner.
- Columns on `host_enrollments`: `instance_id text`, `instance_changed_at integer`,
  `enrolled_via text`, `scope_json text`. Migration files for D1 and SQLite,
  defaulting `enrolled_via = 'account'` for existing rows.
- **Serving generation (Q7):** no client timestamps. A starting instance calls
  `POST /api/claxedo/host/enrollments/acquire` (machine-signed, fresh nonce);
  the authority atomically increments `host_enrollments.serving_generation`,
  records `generation_acquired_at` and an audit row
  `host_enrollment.generation_acquired`, and returns the new generation. Every
  heartbeat carries `generation`; a beat whose generation is lower than the
  stored one is refused 409 `enrollment_generation_superseded` (the guard is in
  the same statement as the lease renewal). Ordinary beats never acquire; only
  the explicit call does, so a delayed first beat from an old process cannot
  displace a newer one. A cloned disk that runs `acquire` deliberately
  displaces the original — that is the documented limit of key-holder fencing
  and the reason the machines list shows generation changes.
- **Tunnel fencing (Lane D, both relay implementations):** the Host Tunnel
  Token carries `enrollment_id` and `generation`. The relay keeps both on the
  host-tunnel socket (Bun socket data, Cloudflare hibernation attachment —
  today they hold only host id + workspace ids) and preserves them through
  `host.registration.update` (both implementations re-verify the token and
  rewrite registration there; a registration update with a lower generation
  than the socket's is refused; an update carrying no generation on a fenced
  socket is refused; every update runs the same admission pipeline as a
  connect, and a socket that becomes fenced starts the periodic check).
  A token that carries a generation on a relay with no resolver is refused
  403 `host_generation_unverifiable`. Admission consults a new
  `GET /internal/relay/host-generation?enrollmentId=` lookup with these
  rules: a cached value is used only when it **equals** the token's
  generation; a token with a **higher** generation than the cache forces a
  refresh before deciding (a fresh acquire is never rejected by a stale
  cache); a token with a **lower** generation than the cache or the lookup is
  refused, and a lower-generation socket can never replace a higher-generation
  incumbent. A periodic host-tunnel check every 30 s in both implementations
  — including rooms with no clients — closes a socket whose generation is no
  longer current; because the check may read a cached value, the closure
  bound is "next check + cache TTL". Lookup **unavailable**: new admission is
  refused (503, the host retries); established tunnels survive up to the same
  3-consecutive-failure grace the Cloudflare client check already uses, then
  close. Production Bun wiring (`main.ts`) is in Lane D's paths.
- **Bun tunnel identity (prerequisite, existing defect):** Bun keys its host
  tunnels by host id and every new host socket replaces the previous one —
  so one host serving two workspaces with one socket each (the desktop's
  serving loop, and this plan's) cannot hold both on a Bun relay today;
  Cloudflare rooms are per workspace and unaffected. Lane D re-keys Bun's
  host tunnels by `(hostId, workspaceId)`; replacement happens only within the
  same identity and only by an equal-or-higher generation. In-flight forwarded
  requests on a closed socket fail as they do today on tunnel close.

Tests: machine beat renews lease with owner from the row; account beat
unchanged; descriptions and versioned scope returned only for this
enrollment; re-point bumps the revision atomically with the directory;
serving predicate false until the new revision is ready, and `host_online`,
`activeWorkspaceHost`, `/internal/relay/target` and the mint all agree;
acquire increments the generation, deletes prior readiness, and the older
generation's beat → 409; relay (Bun and workerd fixtures): stale-generation
admission refused, higher-generation token forces a cache refresh,
lower-generation socket cannot replace an incumbent, registration update
with a lower generation refused, periodic check closes a superseded socket,
lookup outage → new admission 503 / established tunnels survive the grace;
Bun holds two workspace tunnels for one host; restart before expiry succeeds
immediately via acquire; key_version and owner-eligibility guards: a beat
verified against a replaced key or a suspended owner writes nothing; SQLite
twin of each.

### P1.3 Invitations

Token encoding, frozen: `chx_inv_1.<invitation_id>.<secret>` where
`invitation_id` is the row id and `secret` is 32 random bytes base64url. The
store keeps `secret_hash = sha256(secret)`; the id is not secret.

Migration (both adapters): `host_invitations (invitation_id pk, owner_user_id,
owner_actor_id, org_id, secret_hash, display_name, scope_json, expires_at,
redeemed_at, redeemed_enrollment_id, redeemed_host_id,
redeemed_public_key_fingerprint, created_by_actor_id, created_at, revoked_at)`.
Single use only in v1. SQLite mapping: `owner_token_identifier` in place of
the two owner ids, `org_id` nullable (SQLite has a single tenant).
`org_id` is the caller's current org at creation; assignment for this
enrollment refuses a workspace in any other org.

Port + adapters:

- `createHostInvitation(auth, { scope, displayName?, expiresInMs })` → `{ invitationId, token, expiresAt }`;
  `expiresInMs` clamped to [5 min, 24 h], default 1 h. Requires the caller be
  an active user; the invitation's org/project scope is the caller's current
  org (recorded on the row), never inferred later.
- `listHostInvitations(auth)`, `revokeHostInvitation(auth, { invitationId })`.
- `redeemHostInvitation({ invitationId, secret, hostId, publicKey, signature, displayName? })`
  — no auth. Signature payload: `claxedo.host-enrollment.redeem.v1\ninvitation_id=…\nhost_id=…\npublic_key_sha256=…`.
  Public keys are compared by **fingerprint** (sha256 of the JWK's `x||y`,
  base64url), never by JSON text. One guarded batch, in this order:
  (1) `update host_invitations set redeemed_at=?, redeemed_host_id=?, redeemed_public_key_fingerprint=?, redeemed_enrollment_id=? where invitation_id=? and secret_hash=? and redeemed_at is null and revoked_at is null and expires_at > ?`;
  (2) `insert into host_enrollments (...) select ... from host_invitations where invitation_id=? and redeemed_enrollment_id=?` with the pre-generated `enrollment_id`, `key_version = 1`, `serving_generation = 0`; (3) assertion that the enrollment with that id exists. Any failure rolls the batch back. There is no extra nonce row: the redeem's replay protection is the single-use invitation itself.
- **Idempotent for the same host.** If the invitation is already redeemed and
  the presented secret is valid and the presented key's fingerprint equals
  `redeemed_public_key_fingerprint`, the route returns the **same enrollment**
  (status 200, `resumed: true`) instead of `invitation_redeemed`. This is the
  whole recovery story for "redeem committed, response lost": the host
  persists its key before the first redeem request and simply redeems again
  on the next boot. There is no `/mine` route and no provisional signature.
- **Collision policy — the `(owner, host_id)` pair is occupied for ever.**
  Both schemas keep `unique (owner, host_id)` and revocation does not release
  it, so a redeem that would insert a second row for an occupied pair is
  refused with `invitation_host_conflict` **whether the existing row is live
  or revoked, and whatever key it holds**. There is no upsert on this path
  (the account re-enroll upsert is a different route with a different
  caller). Replacement of a revoked machine is therefore always a **new host
  id**: the host mints its host id with its state file, so a fresh state dir
  is a fresh host id by construction; `claxedo connect --reset` discards the
  state (and the key) and prints what it is doing. A same-key redeem of a
  **different** invitation while the pair is occupied is also a conflict —
  "resume" applies only to the invitation that created the enrollment.
- **Resume binding:** `resumed: true` requires the presented key fingerprint
  **and** host id to equal `redeemed_public_key_fingerprint` and
  `redeemed_host_id`.
- Error mapping: `invitation_invalid` (bad id or secret — the response never says which), `invitation_expired`, `invitation_revoked`, `invitation_redeemed` (only after the secret verified; includes `redeemed_host_id`, `redeemed_at`), `invitation_host_conflict`.

Route: `POST /api/claxedo/host/enrollments/redeem` — no auth; `bodyLimit` 8 KiB;
IP budget; plus a 5/min budget keyed by `invitation_id` so a leaked id cannot
be brute-forced against.

Tests: fresh redeem creates an enrollment owned by the inviter with the
invitation's scope and org; wrong secret → `invitation_invalid` with no
redeemed-by detail; second redeem with the **same** key → same enrollment,
`resumed: true`; second redeem with a **different** key → `invitation_redeemed`;
two concurrent redeems with distinct keys → exactly one enrollment; revoke
racing redeem → at most one wins; expired; host-id collision with a live
**or revoked** enrollment → `invitation_host_conflict` and no write; same
key, different invitation, occupied pair → conflict; resume with the right
key but a different host id → `invitation_redeemed`; secret never stored;
SQLite twin.

### P1.4 Scope (assignment is the only thing scope governs in this slice)

- `scope_json = { allowed_roots: string[], visibility: "owner" | "org" }`.
  `may_register_workspaces` is **not** in this slice (self-assign and folder
  ops are deferred, see P3.3/P5b).
- `assignWorkspaceHost`: when the enrollment has `allowed_roots`, refuse a
  `remoteDirectory` that is not one of them or under one of them. The rule is
  segment-aware on absolute POSIX paths after collapsing `.`/`..` and trailing
  slashes (`/srv/api` is under `/srv`; `/srvx` is not; a relative or
  non-absolute path is refused). The host repeats the check on the **resolved**
  path (`realpath`, so a symlink out of the root is refused) before serving.
  Tightening the roots of an enrollment that already serves a folder outside
  them retires that assignment on the next beat (`assignments` omits it; the
  host drops the link) — recorded as an audit event.
- Visibility is a property the **assignment** applies, not only cold
  registration: `assignWorkspaceHost` sets `workspaces.org_member_visible`
  from the enrollment's scope on every assignment and re-assignment (existing
  workspaces included), and a scope change (P1.5) re-applies it to every
  workspace assigned to that enrollment. New column, default 1.
- Exactly one shared **workspace-scoped** SQL fragment gates the ordinary
  org-member branch on that column in the three workspace rank computations
  (`workspaceAccessCte` in host-access, `workspaceAccessSql` in
  workspace-authority, the rank in session-authority). `projectAccess`
  (project-scoped, no workspace row) is **not** touched: project discovery
  policy stays as it is and is called out as such. Direct workspace
  memberships, project memberships, team grants and org admins are
  unaffected — the feature is "no implicit org-member access", not
  "owner-only", and the docs and UI copy say so.
- **Project regrouping is out of this slice.** Cold-registered workspaces keep
  today's `project_id` derivation. (Regrouping by repo remote can attach a
  workspace to a project that already has memberships; it must be its own
  change with its own access review.)

Tests: assignment outside roots refused, inside accepted, `..`/symlink cases;
an ordinary org member cannot open an owner-visibility workspace but a
direct/project member and an org admin can; tightening roots retires the
outside assignment; SQLite twin.

### P1.5 Scope changes and retirement

`PATCH /api/claxedo/host/enrollments/:id/scope` (account; owner only): writes
`scope_json` and bumps `scope_revision`; in the same batch, for every
assignment of that enrollment whose `remote_directory` falls outside the new
roots, **deletes the assignment row, deletes its readiness row, and retires
the workspace** — the two statements `unassignWorkspaceHost` already runs
(assignment delete + `retireUserHostedWorkspaceSql`, which only sets
`workspaces.deleted_at`); and re-applies `org_member_visible` to the rest.
A retired workspace **disappears from the catalog** (the inventory excludes
deleted rows); there is no "visible but unassigned" state in this slice, and
the acceptance assertion is disappearance. The next heartbeat's `assignments`
omits the retired rows and carries the new scope revision; the host unacks
and applies the new roots before validating anything else.

### P1.6 Enrollment list

`listHostEnrollments(auth)` on both adapters → every non-revoked enrollment
with `enrollment_id, display_name, host_id, public_key_fingerprint, key_version,
enrolled_via, last_seen_at, expires_at, serving_generation,
generation_acquired_at, acked (workspaceId + revision), scope`. `GET /` keeps
its single-row shape under `active` for the desktop and adds `machines`.

### P1 Definition of done

- [x] `machine-auth.ts` + tests on both adapters; route-local; identity by `enrollment_id`; key_version guard on every machine mutation; adapter-neutral eligibility with the SQLite predicate written separately; nonce table with exact-row sweep; check order as specified. Progress: done 2026-09-14 — server-core `machine-auth.ts` (0fccb78e36), D1 `machineAuth` adapter (9895cb17fa), SQLite (bc0402abb5); 52 + 19 + 32 scenario tests
- [x] Heartbeat accepts the machine caller; `assignments` with monotonic revisions; readiness table is the one serving predicate for mint, `activeWorkspaceHost`, catalog and relay target; `acquire` + generation fencing; relay: generation admission with the cache rules, registration-update preservation, outage policy, 30 s host-tunnel check, Bun tunnels keyed by (host, workspace) — in Bun **and** workerd; SQLite migration + upgrade test. Progress: done 2026-09-14 — D1 9895cb17fa, SQLite bc0402abb5, relay b905edd413 (Bun + workerd, 373+92+13 tests); SQLite upgrade test `host-connect-upgrade.test.ts`
- [x] Invitations: frozen token encoding; org recorded; transactional redeem; idempotent same-key+host resume; occupied-pair conflict (live or revoked); concurrency + revoke-race tests; secret hashed; SQLite twin. Progress: done 2026-09-14 — D1 + SQLite; live: fixture items 2 and 3 (re-redeem resumes, fresh key → invitation_redeemed, wrong secret → invitation_invalid without redeemed-by detail)
- [x] Scope: root rule (segment-aware, resolved-path on host), versioned scope delivered on redeem/heartbeat, visibility applied at assignment and scope change, one workspace-scoped fragment across three computations, project access untouched; scope PATCH deletes assignments + retires workspaces transactionally and the catalog drops them; regrouping explicitly excluded. Progress: done 2026-09-14 — root rule via `host-connect-contract.directoryWithinRoots` (1d58008573); live: fixture item 9 (scope PATCH retires, catalog drops)
- [x] Operation matrix + inventory test updated for every new route. Progress: done 2026-09-14 — `desktop-hosted-operation-matrix.md` non-AccountPort table; `hosted-operation-inventory.test.ts` NON_ACCOUNT_ROUTES pin
- [x] Ratchets, per-package typecheck, `claxedo-server` and `server-core` suites green with recorded commands and counts. Progress: done 2026-09-14 — `bun run test:architecture-ratchets` green; root `bun turbo typecheck --force` 31/31; claxedo-server `bun run test` 275 files / 2743 passed; server-core 89 files / 937 passed

---

## P2 — Host side: shared pieces

### P2.1 One identity implementation

Delete `packages/cli/src/keys/host-key.ts`; the CLI imports
`@claxedo/host-connector/host-identity`, which gains
`machineRequestSignature(keys, { method, path, body, ts, nonce, enrollmentId })`
with the literal pinned by the same test string P1.1 uses. Node `fs` stays
behind an injected adapter (the package remains Web-Crypto-only).

### P2.2 Durable host state

New `packages/claxedo-host-connector/src/host-state.ts`: one JSON file
(`~/.claxedo/connect/state.json`, 0600, written atomically via temp +
rename) holding:

```
{ host_id, private_key_jwk, created_at,
  control_plane_url,                       // frozen at first redeem; a different URL is a different host state
  bootstrap?: { invitation_id, token_file } // present from "key persisted" until "enrollment persisted + token removed"
  enrollment?: { enrollment_id, owner_display, org_id, enrolled_via, enrolled_at, key_version },
  relay?: { url, jwksUrl }, authority?: { sessionAuthorityUrl },
  scope: { revision, allowed_roots, visibility },  // the control plane's scope as last delivered (P1.2); applied before any assignment validation
  cli_roots: string[],                      // --root, kept separate from the CP scope
  // effective roots = CP allowed_roots ∩ cli_roots by filesystem containment on resolved paths
  // (a cli root inside a CP root narrows to the cli root; disjoint ⇒ nothing is servable);
  // no --root ⇒ the CP roots; an EMPTY CP allowed_roots ⇒ deny-all (never "unrestricted")
  storage_root,                             // WORKSPACE_RUNTIME_WORKSPACES_DIR for this host's runtimes
  service?: { kind: "systemd-user" | "launchd", unit, installed_at },
  run?: { pid, started_at, generation, last_beat_ok_at, last_beat_error? } }
```

Write order on first boot: key + `control_plane_url` + `bootstrap` **before**
the first redeem request; `enrollment` on success; then remove the token file
and clear `bootstrap`. A boot that finds `bootstrap` still set with an
enrollment present finishes the cleanup (remove the file, clear the field)
before doing anything else. `run` is rewritten on every successful beat and
cleared on exit; `claxedo status` reports *online* only when `run.pid` is
alive **and** `last_beat_ok_at` is within one lease, replacing today's
PID-only check in `commands/status.ts`.

### P2.3 Bootstrap client with recovery

`packages/claxedo-host-connector/src/bootstrap.ts`:

- Order on start: load state → finish any pending cleanup → if `enrollment`
  present: `acquire` a generation, then beat (a 404/410/403 there means
  revoked → exit 78) → else: persist key + `bootstrap`, redeem (idempotent —
  a lost response is recovered by redeeming again with the same key, P1.3),
  persist `enrollment`, remove the token file, clear `bootstrap`, then
  `acquire` and beat.
- Decision errors (`invitation_redeemed/expired/revoked/host_conflict`,
  `enrollment revoked`, `generation superseded`) exit 78 (EX_CONFIG);
  transport errors retry with backoff up to 5 min, then exit 1.

### P2.4 Machine-signed transport

`createMachineSignedTransport({ controlPlaneUrl, keys, enrollmentId, keyVersion, fetch })`
implements `acquire()` and `ConnectorTransport.heartbeat`; `createRequest`/`enroll`
throw (a `connect` host never calls them). HTTP failures surface as
`HOSTED_HTTP <status> <json>` so `transientHeartbeatFailure` keeps working;
409 `enrollment_generation_superseded` is a decision.

### P2.5 Assignment discovery in the connector

`createHostConnector` gains an `onAssignments(descriptions)` callback and an
`ack({ workspaceId, revision })` / `unack(workspaceId)` pair replacing the
share/unshare API for machine transports. Reconciliation is **serialized**
(one in flight; a response is applied only if its generation matches and no
per-workspace revision goes backwards). Cycle: beat → `assignments` → for
each description whose revision is not the acked one: **withdraw** first
(unack + close that workspace's tunnel, so the control plane stops minting
for it on the next beat), validate `remoteDirectory` against the effective
roots (resolved path), prepare a runtime for the new directory (P2.7), drain
the old runtime's turns, then `ack` the new revision → the next beat writes
the readiness row → the workspace is routable again and the credential covers
it → serving loop opens its tunnel. A description that disappeared is
unacked and its runtime disposed after draining. `sharedWorkspaceIds()` stays
for the desktop.

Tests (fake control plane enforcing P1 contracts — it must reject a reused
nonce, a stale ts, a bad signature, a stale generation, a stale ack revision,
and answer `resumed` / `invitation_redeemed` correctly): owner assigns a
folder after the host started → acked within two beats, tunnel opens; owner
re-points the directory → credential stops covering it, host withdraws,
re-validates, re-acks the new revision; a folder outside roots is never
acked; a retired assignment is unacked; an out-of-order response is ignored.

### P2.6 Serving loop moves out of the daemon

New private package `packages/claxedo-host-serving`: `setServing`,
`servingState`, `stopServing`, `userHostedSurface` moved verbatim from
`claxedo-local-server/src/workspace/user-hosted-serving.ts` and
`user-hosted-surface.ts`; the daemon imports them back and its routes are
unchanged (`user-hosted-serving*.test.ts` move with the code and must pass
from the new location). Measure and record the new ratchet edges.

### P2.7 Runtime composition for a host

`packages/claxedo-host-serving/src/runtime.ts`: `createHostWorkspaceRuntime(...)`
= `createWorkspaceRuntimeApp` with `relayWorkspaceRuntimeExposure({ jwksUrl, workspaceId })`
and `remoteWorkspaceSessionAccessPolicy({ url: sessionAuthorityUrl })` — the
pair `workspace-runtime/src/cli.ts` composes for a sandbox. Both URLs come
from the redeem/heartbeat response and the persisted state (P1.2, P2.2); the
JWKS URL is the relay's published key set, so the host trusts the relay by
the same mechanism a sandbox does. Session registration is then the existing
runtime path: reserved create → runtime `registerSession` → POST to the
authority URL with the caller's RHT → `/api/runtime-authority/session-authorize`
registers the verified principal. That path has never been driven from a
runtime **outside** the control-plane process for a user-hosted workspace
(the fixture's embedded host uses an in-process policy), so it is a named
test here, not an assumption. Storage root per workspace comes from the
state's `storage_root`. One loopback listener multiplexes `/workspaces/<id>/*`.

### P2 Definition of done

- [x] CLI key module deleted; one owner of payload literals (grep). Progress: done 2026-09-14 — `cli/src/keys/host-key.ts` deleted (8240ab4b19); builders live in `@claxedo/host-connector/host-identity` (server twin in `host-connect-contract.ts`, distinct names, helpers ratchet green)
- [x] Durable state file with the frozen fields; `status` = pid alive ∧ recent beat; resume, idempotent re-redeem, and interrupted-cleanup paths tested. Progress: done 2026-09-14 — `host-state.ts` (acec57bd63); `claxedo status` reads it; started_at regression 6f7ef39506
- [x] Machine transport + bootstrap against the strict fake. Progress: done 2026-09-14 — `machine-transport.ts`, `bootstrap.ts`, strict `fake-control-plane.test-support.ts`; 129 tests
- [x] Assignment discovery: late assignment acked, re-point withdraws then re-acks, outside-root refused, retirement handled, out-of-order response ignored. Progress: done 2026-09-14 — connector machine mode (acec57bd63); live: fixture items 1, 9, 10
- [x] `@claxedo/host-serving` extracted; daemon tests green from the new location. Progress: done 2026-09-14 — `@claxedo/host-serving` (166dcb0c44); local-server 67/68 files green (the one red was the ceiling, raised to measured 60/27)
- [x] Host runtime: relayed request with a verified stamp → session authority consulted over HTTP from an external process, including a reserved create that registers; unverified → 403; contrast recorded against the daemon's `local` behaviour. Progress: done 2026-09-14 — `host-serving/src/runtime.ts`; live: fixture item 6 (reserved creates register over HTTP from the external host), item 5 (viewer → 403 from the runtime; tampered RHT → 401)
- [x] Ratchets green with measured ceilings. Progress: done 2026-09-14 — host-connector 2→3 modules, local-server 62/26→60/27, self-hosted 121→125/40; all measured

---

## P3 — `claxedo connect`

### P3.1 Command

```
claxedo connect --token-file F [--root DIR]... [--name N] [--install-service] [--foreground]
claxedo connect                      # resume with persisted state
```

**Owner commands (account-authenticated, run on the owner's laptop or any
signed CLI — not on the host):**

```
claxedo host invite --name N --root DIR... [--expires 1h] [--org-visible]   # prints the token once
claxedo host list                                                          # machines: name, fingerprint, generation, online
claxedo host assign --machine <name|enrollment_id> <dir> [--name N]        # POST /workspace/:id/host-assignment
claxedo host unassign --machine <name|enrollment_id> <dir>
claxedo host scope --machine <name|enrollment_id> --root DIR...            # PATCH scope
claxedo host revoke --machine <name|enrollment_id>
```

These are the first slice's public owner workflow; the Remote access panel
(P4) is the second front end to the same routes. `claxedo host` today is an
alias of `up` and is replaced by this subcommand group. `--machine` selects
the target enrollment explicitly; there is no default machine.

`--root` values are persisted separately from the control plane's scope;
the effective roots are their intersection by resolved-path containment (see
P2.2), and the host refuses anything outside that set. A scope change arrives
on the next heartbeat with a new revision and is applied before any
assignment is validated. Folders are assigned by the **owner** from a
signed client (desktop/web Remote access panel, or `claxedo host assign
<dir>` from a logged-in laptop) — the host never assigns. The interactive
approval flow is P4a; until then `connect` without `--token-file` and without
state prints how to mint an invitation and exits 78.

### P3.2 Service install

`--install-service` writes a `systemd --user` unit (Linux) or a LaunchAgent
(macOS) running `claxedo connect --foreground`, `Restart=on-failure`,
`RestartPreventExitStatus=78`, `TimeoutStopSec=25` (launchd `ExitTimeOut`
25 with a wrapper that forwards SIGTERM and boots the job out on 78). On
Linux it first checks linger and the user manager; when either is missing it
writes the unit, records `service`, prints the exact `loginctl enable-linger`
line and exits 78 without claiming a start.
`claxedo connect --uninstall-service` stops and removes it. A user service is
process isolation from other users only; it does not by itself separate the
connector from an agent running as the same user — documented in the CLI help
and in the proposal's §5.

### P3.3 Self-assign — removed from this slice

Calling `assignWorkspaceHost` as the enrollment owner would let a serving key rewrite metadata of, and take over, any workspace that
owner can administer. No machine-caller route creates assignments in this
slice. When folder operations return (P5b) they will create **new** workspace
rows scoped to the enrollment only, never touch existing ones, and derive
org/project from the enrollment's recorded org.

### P3.4 Retire `claxedo up`

Delete `commands/up.ts`, `commands/down.ts`, `host/register.ts`,
`host/runtime.ts`, `host/state.ts`; `claxedo up` prints "replaced by
`claxedo connect`" for one release; the `host` alias of `up` becomes the
owner subcommand group above. `claxedo login/logout/deploy/documents`
unchanged; `status` reads the P2.2 state.

### P3.5 Tier R fixture: a `connect` host

The existing `signed-browser-relay-fixture.mjs` pre-registers, assigns and
heartbeats an **embedded** host with an in-process authority, its relay child
uses a permissive user-hosted target resolver with no active-token check, and
`/__fixture/mint` returns a RAT. None of the nine items below can be driven
by it as is; Lane H builds these fixture capabilities as named deliverables:

- `--host=connect`: no embedded host; spawn a real `claxedo connect` with a
  fresh state dir; HTT signing and `relayHostJwksUrl` configured on the
  fixture's enrollment routes; **two** real allowed directories provisioned;
  owner actions driven through the `claxedo host …` commands against the
  fixture's account (the same routes the panel uses), not through direct
  database writes.
- Child lifecycle controls: kill/restart, second instance with a copied state
  dir, and a fault barrier that delays the **redeem response** after commit
  (today's wrapper only delays heartbeat handling).
- Relay child wired to the real `isRuntimeAccessTokenActive`, the real
  assignment resolver, and the new host-generation lookup.
- `/__fixture/mint-rht`: a valid RHT with an active parent RAT for a given
  role, plus a tunnel test hook that delivers a request to the host runtime
  as the relay would (no bypass of stamp verification).
- A control-plane outage gate (authority + enrollment routes return 503 /
  drop) independent of tunnel pause/resume.
- The scope PATCH route (P1.5) reachable through the owner account.
- Event-stream assertions use the route's actual parameter, `sessionID`.
- Timing assertions state their assumptions: new requests ≤ resolver cache
  (10 s), established client sockets ≤ next 30 s check, host tunnel ≤ next
  30 s host check, tunnel credential ≤ its TTL. Cloudflare hibernation
  coverage is a separate workerd fixture run; this fixture launches Bun.

`packages/claxedo-app/e2e/playwright/real-connect-host.spec.ts` then drives:

1. fresh enrollment: redeem → enrolled with **no** assignments → owner assigns `/srv/api` → host acks within two beats → tunnel up → catalog shows the workspace with `hostOnline`;
2. a second process with a **fresh** key redeeming the same token → exit 78 `invitation_redeemed`; a redeem with the right id and wrong secret → `invitation_invalid` with no redeemed-by detail;
3. kill and restart before the lease expires → `acquire` succeeds immediately, no re-enrollment; kill **between** redeem commit and response (fault barrier) → next boot redeems again with the same key, gets `resumed: true`, and the control plane still has exactly one enrollment;
4. second instance from a copied state dir runs `acquire` → the first instance's next beat → 409, exit 78; its host socket is closed by the relay's next host check; the old HTT cannot re-admit;
5. **runtime enforcement, not relay**: a fixture-minted viewer RHT delivered through the tunnel hook to the host runtime's write route → 403 `session_write_forbidden` from the runtime; an **editor** Bob's prompt on shared session A is stored with Bob as author;
6. Alice creates sessions A and B (reserved creates through the external host, which register at the authority URL over HTTP); shares A with Bob; Bob's list → only A; Bob GET B → 403; Bob's `/api/wr/events?sessionID=B` → 403;
7. revoke the machine → new client requests refused within 10 s; Bob's open stream closes by the next 30 s client check; the host socket by the next host check; the process exits 78 on its next beat;
8. control plane outage gate for 2 min → beats fail transiently, host tunnel stays, existing private-session streams renew or fail as their own leases dictate (asserted, not assumed), resumes on return without re-enrolling;
9. owner tightens roots via `claxedo host scope` to exclude `/srv/api` → the assignment row is deleted and the workspace retired transactionally, the host unacks on the next beat, the workspace **disappears** from the catalog;
10. two directories assigned to one enrollment stay connected simultaneously (Bun relay); re-pointing one leaves the other served; `host_online`, `activeWorkspaceHost` and the relay target agree with the readiness table at every step.

### P3 Definition of done

- [x] P3.5 items 1–11 green with commands and output recorded (item 11 = service-managed lifecycle; item 8 has partial and full resolver-outage variants). Progress: third pass 2026-09-15 — 12 passed, 1 skipped (5b), done 2026-09-14 — `bun run test:e2e:connect-host`: 10 passed, 1 skipped (`5b` fixme: no provider credential delivery to a connect runtime — out of slice), 4.2–5.5 min, 5 consecutive green runs (c9f41e1e62, then through the self-hosted node's own routes after c6648f2483)
- [x] `claxedo host invite/list/assign/unassign/scope/revoke` implemented against the account routes and used by the fixture. Progress: done 2026-09-14 — `cli/src/commands/host.ts`; the fixture drives owner actions through these commands, not DB writes
- [x] Manual proof on one real VPS: `--token-file` from cloud-init, systemd unit, reboot resumes, `status` truthful, no `credentials.json` on the box. Progress: done 2026-09-14 on EC2 ap-south-1 — real self-hosted Node control plane + real Bun relay on one t3.medium, host on a second with no ingress except SSH from the operator; cloud-init token file → enrolled, `~/.claxedo` held only `connect/state.json`; assign → served in 6.4 s; file read through the relay 258 ms; `sudo reboot` → same enrollment, generation 1→2, served 9 s after kernel up; revoke → 403 → exit 78, `NRestarts=0`; both instances terminated and confirmed. Deterministic twin: `packages/cli/src/connect/machine-lifecycle.test.ts` (fake systemd parsing the real unit, cloud-init provisioner, reboot, revoke-no-restart, crash restart, linger-off refusal) and Tier R item 11 (real CLI installed as a service on the fixture box)
- [x] `up/down/host` removed; CLI tests green; README updated. Progress: done 2026-09-14 — `up/down/host/register/runtime/state` deleted; no stub (036e65cc12); no CLI README exists; `docs/tech-docs/user-hosted-workspaces.md` updated

---

## P4 — App: Remote access panel

Owner paths: `claxedo-app/src/platform/remote-access/*`,
`features/settings/remote-access/*`, `platform/account/*`; desktop
`main/account/hosted-operations.ts`, `account-ipc.ts`.

- New `AccountPort` ops: `host.list`, `host.revoke` (unified with the machine
  port's `revoke`), `host.invitations.list|create|revoke`, `workspace.assignHost`
  (exists) exposed in the panel for "assign a folder on machine X". Decoders in
  both registries; operation matrix; inventory test.
- Panel: **This machine** (unchanged), **Machines** (name, fingerprint,
  enrolled via, online/offline, instance-changed badge, assigned folders,
  assign folder, revoke), **Invitations** (create with scope + expiry; token
  shown once; list with expiry / redeemed-by; revoke).

### P4a Pending approvals — deferred, with the boundary it needs

Deferred out of the first slice. When built: the approval **capability is the
code**, which is never listable — there is no `GET /pending` for arbitrary
signed users; `approve` takes `{ code, scope }` and the code is shown only on
the host's terminal; the host proves key possession on every poll
(machine-signed with a provisional enrollment id); decisions are atomic and
once-only; the pending row exposes fingerprint, name and proposed roots, not
requester IP. The web page `/approve/host?code=` and the desktop panel both
require the code.

Definition of done (P4):
- [ ] Ops in the matrix + inventory test; renderer holds no token. Progress:
- [ ] Tier M mock routes bound to the P1 contracts. Progress:
- [ ] Playwright: create invitation → shown once → listed; assign a folder to a machine from the panel → appears on the host (fixture). Progress:

---

## P5 — App: composer

### P5.1 Environment chip

`newSessionEnvironmentOptions` returns
`Array<{ kind: "local" } | { kind: "cloud" } | { kind: "user-hosted", enrollmentId, name, online, checkouts }>`
built from `localExecution`, `sandboxEnabled`, and the catalog's user-hosted
rows for the selected project grouped by host. Hosts with no checkout of the
project are not shown in this slice (no clone-on-demand yet). The route pin
becomes a preselected machine; the `selfHostedWorkspace()` chip-hiding special
case is removed.

### P5.2 Worktree chip

`createNewSessionWorkspaceState` filters user-hosted rows by host and lists
that machine's assigned folders. **No footer action for machines in this
slice.** The existing runtime worktree route is a *session* resource
(`sessionId` required, `worktree_write` on that session, created under
`~/.claxedo/workspaces/<workspaceId>/worktrees/<sessionId>`) — it cannot be
promoted into an independently assigned checkout, and its path lies outside
an invitation's roots. An independent "new checkout on <machine>" is P5b's
operation with its own destination policy and grant. Cloud footer unchanged.

### P5.3 Create-project form

Location step with Local / Cloud only in this slice; machines appear once P5b
exists.

### P5b Host folder operations (clone into root) — deferred, with the boundary it needs

A workspace token authorizes one workspace, not the machine
(`user-hosted-surface.ts` header). Cloning under a host root therefore needs a
**host-management grant**: a short-lived token minted by the control plane for
(actor, enrollment, operation, destination root, expiry), verified by the host
against the control plane's key, distinct from the relay proof. Clone
credentials are brokered (a single-use, repo-scoped credential from the
connections capability), not the account's GitHub token forwarded in a
header. Execution reuses the self-hosted node's clone path
(`projects-route.ts`) moved behind that policy. The zero-workspace case is
solved by the grant, not by borrowing another workspace's tunnel.

Definition of done (P5):
- [ ] Chips render machines from the catalog; selecting one drives the worktree chip; local/cloud behaviour unchanged. Progress:
- [ ] Machine rows list assigned folders only; no machine footer until P5b. Progress:

---

## P6 — Unattended checkpointing and offline index

Registration needs nothing: a `connect` host's runtime registers every
session at create time with the creator from the verified relay proof.
Host-originated sessions with no human caller are out of scope until a
principal for them is defined.

- Host: on `onTurnOutcome` and on session title change, the connector sends
  machine-signed `POST /api/claxedo/host/sessions/checkpoint { workspaceId, sessionId, expectedEventOrdinal }`.
- Control plane: route machine-caller only; refuses unless the workspace is
  assigned to this enrollment and the session row exists for it. The existing
  pull (`hosted-session-pull.ts`) requires a signed account, opens the
  workspace as that user and mints a **user** RAT; the user-hosted target
  lookup also requires signed auth. A machine result cannot be threaded
  through it and synthesizing owner auth is the impersonation P1 removed. So
  P6 defines a **projection principal**. Two facts in the session authority
  shape it: a service principal must resolve to an active `agent` actor
  attached to an active user, and session access is additionally gated by
  workspace access (org/project eligibility). So the principal is not a bare
  actor name: it is a per-deployment **system agent actor** (`actors` row of
  kind `agent`, owned by a system user that org and project eligibility
  treat as a member of every org — one explicit clause in
  `actorWorkspaceAccessSql`, not a bypass), and the pull is a distinct
  operation `session_project` that the authority admits for that actor only,
  audited with the enrollment and checkpoint request ids. The RAT minted for
  the pull names that actor, the workspace, the host and `purpose: "projection"`;
  the runtime forwards it as the RHT chain does today, and the authority's
  `session_project` rule checks the purpose claim, so an ordinary viewer token
  can never satisfy it and the projection token can do nothing else.
  Snapshot parsing and storage are reused from the existing pull; the account
  policy is not. A durable
  `session_checkpoint_requests` table (workspace, session, ordinal, state,
  attempts) makes the trigger retryable across control-plane restarts. SQLite:
  the pull writes `session_history`; its own lane item.
- App: `sessionProjectionBacking` returns a backing for user-hosted rows;
  `session-source.ts` composes the CP index with the live runtime list (online:
  runtime is truth; offline: CP index with a "last checkpoint" badge); the CP
  list route's 409 for user-hosted workspaces is lifted for workspaces with
  registered rows.

Definition of done:
- [ ] Projection principal and its read clause defined and tested (it cannot write, cannot read outside projection). Progress:
- [ ] A session created on a `connect` host, with the client then closed, is checkpointed after its next turn (retried across a CP restart) and listed from the CP while the host is offline (fixture). Progress:
- [ ] Alice shares A alone with Bob; Bob sees A only; B → 403 on list, read, events. Progress:
- [ ] SQLite twin. Progress:

---

## P7 — Desktop

- Connector child beats with the machine-signed transport; enrollment still
  goes through main's account op (the desktop *is* the interactive path with
  the account present). `host.enrollmentHeartbeat` leaves the operation matrix;
  heartbeat v2 is removed from the control plane.
- Q3 = yes: authorization is decided per request from **trusted ingress
  provenance**, not by swapping runtime policies — and not by a policy that
  merely branches on "claims present". Three facts make this larger than a
  branch: registration and turn admission (`session-core.ts:797`) and event
  privacy (`session-event-privacy.ts:52`) all consult the runtime-wide
  `sessionAuthority` marker, not the request; relayed requests are replayed
  through loopback, so "no verified claims" cannot mean "local owner" (a
  relayed request whose stamp fails verification must be **rejected**); and a
  desktop session created locally has no reservation or creator row. P7
  therefore: (a) stamps provenance at the daemon's ingress (loopback-direct
  vs relay-replayed, the latter only with a verified stamp); (b) makes the
  policy's registration/turn/event decisions request-scoped on that
  provenance — private-session lifecycle for relayed requests, local-owner
  lifecycle for direct ones; (c) defines the local owner identity for signed
  desktops, sign-out and outage behaviour, and how pre-existing local sessions
  become readable remotely (registered lazily with the owner as creator on
  first remote access, or not at all — a product decision); (d) hands the
  connector child from account-enroll to machine-heartbeat after the enroll
  response (which already returns `enrollment_id`) and teaches its heartbeat
  decoder the new response fields. No runtime is disposed on
  enable/disable/sign-out.
- Tests: long turn + PTY survive enable/disable/sign-out; the investigation's
  §14.1 probe answers 403 for a relayed request on a serving desktop and 404
  for a loopback one; Tier L/M user-hosted specs green.

Definition of done:
- [ ] Desktop beats without an account op; sign-out still suspends serving. Progress:
- [ ] Provenance-scoped authorization across authorize/register/turn/events; failed remote verification rejected; no disposal on toggle; probes as above. Progress:
- [ ] `real-desktop-signed-cloud.spec.ts` and user-hosted Tier L/M specs green. Progress:

---

## Cross-cutting acceptance (run at the end of P3, P6, P7)

| Check | Where proven |
|---|---|
| Owner access without self-sharing | P3.5 (1) |
| Fresh enrollment, replay rejected, expiry, scope expansion denied | P1 tests; P3.5 (2), (9) |
| Restart with persisted identity; replacement with fresh identity; lost-response recovery | P3.5 (3): acquire + idempotent re-redeem |
| Concurrent replicas / cloned disk | P3.5 (4): generation fencing incl. relay admission, host-socket closure, and readiness invalidation |
| Two folders on one machine | P3.5 (10) |
| Network recovery; machine revocation | P3.5 (7)(8); bounds per connection type as stated in P3.5 |
| Idle shutdown preserves active work | not in this slice (no idle metadata); Q4 = never stop user compute |
| Desktop/headless coexistence | manual: desktop enrolled + `connect` on one laptop → two machines listed; `connect` refuses to start when `local-daemon.json` names a live daemon unless `--alongside-desktop` |
| A shared, B private; Bob blocked on APIs/lists/streams | P3.5 (6), P6 |
| Bob's writes keep Bob's identity/role | P3.5 (5): runtime-level viewer denial with valid proof; editor attribution |
| Revocation ends access | P3.5 (7) |
| Unattended registration/checkpointing | registration: existing runtime path (P2.7); checkpointing: P6 |
| Equivalent checks across local / user-managed / managed | same assertions against the sandbox fixture (`real-cloud-relay.spec.ts`) and, after P7, the desktop |

## Execution: lanes and ownership

| Lane | Owns (disjoint paths) | Depends on |
|---|---|---|
| A — CP machine auth | `server-core/src/platform/auth/machine-auth*.ts`, nonce table migrations (both), port additions in `authority.ts` | shared literal-string fixture committed first |
| B — CP routes + D1 | `routes/hosted/host-enrollment.ts`, `d1/host-access-authority*.ts`, D1 migrations, operation matrix doc | A |
| C — SQLite parity | `server-core/.../sqlite/workspace-authority*.ts`, `workspace-authority-store.ts`, SQLite migrations + upgrade tests | B (shared test file) |
| D — relay generation fencing | `workspace-relay/src/{auth,cloudflare,bun,worker,main,server}.ts`: HTT claims, socket/hibernation attachments, admission lookup with the cache rules, registration-update preservation, outage policy, periodic host-tunnel check in both implementations, Bun tunnels keyed by (host, workspace); `shared-routes/internal-relay.ts` host-generation route | A, B |
| E — host-connector | `claxedo-host-connector/src/*` | A |
| F — host-serving extraction | new `packages/claxedo-host-serving`, `claxedo-local-server/src/workspace/user-hosted-*` | — |
| G — CLI | `packages/cli/src/**` | E, F |
| H — fixture + e2e | `signed-browser-relay-fixture.mjs`, `user-hosted-relay-fixture.mjs`, `real-connect-host.spec.ts`: every P3.5 fixture capability is a named deliverable here | G, D |
| I — app panel | remote-access + account port paths, desktop `hosted-operations.ts` | B contracts |
| J — app composer | `session-new-*`, `composer/**`, `workspace-catalog.ts` | B contracts |
| K — checkpointing | `routes/hosted/control.ts`, `hosted-session-pull.ts`, `d1/session-authority.ts`, SQLite session store, app `session-projection.ts`, `session-source.ts` | G |

Rules from the repo's record: partition by file ownership, commit with
`git commit -- <paths>`, never stash on the shared worktree, review each
lane's diff and re-run its gates before accepting, treat "fixed" claims as
claims, and run the Tier R spec — not the unit suite — before calling a phase
done.

## Risks

- Machine verifier in the Worker: one D1 read per beat plus a nonce insert;
  index on `enrollment_id` exists (pk); measure p95 on the fixture.
- Serving-loop extraction touches the desktop's live path; guard with the
  moved tests and a manual desktop remote-access check before merging F.
- `org_member_visible` touches three workspace-scoped rank computations; one shared
  fragment or Q1 = no change.
- Q7 generation fencing: a cloned disk that runs `acquire` displaces the
  original until the owner notices the generation badge; a key holder can
  always take over. The fence orders instances; only revocation excludes a
  key. Lane D is the largest relay change in the plan (both implementations,
  hibernation attachments, a new lookup, a new periodic check) and is on the
  P3 critical path.
- The external-runtime registration path (P2.7) has never been exercised for
  a user-hosted workspace from outside the control-plane process; if it needs
  changes they land in `runtime-session-authority.ts` and are Lane B.
