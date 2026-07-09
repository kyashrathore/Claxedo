# Connection Scoping: Team-Shared and Personal Connections

Status: draft (adversarial review recorded 2026-07-10; all findings
resolved in-plan — see appendix)
Last updated: 2026-07-10
Prereq reading: `docs/plans/2026-07-03-004-feat-connections-framework-plan.md`
(current shape + security gates), `packages/claxedo-connections/README.md`.

## Problem

Connections are host-global: one row per `integration_id`
(`claxedo_connection` PK), one credential under
`integration:{integration_id}`. In signed multi-user mode every member
shares — and can replace or delete — the same connections, and there is no
way for a user to connect a personal account without exposing it to the
whole team.

## Product Model

Every connection has a **scope**, chosen at connect time:

- **team** — visible to and usable by every signed member. Exactly today's
  behavior; all existing rows migrate here.
- **personal** — owned by one signed subject. Only the owner lists, manages,
  and (by default) uses it.

Rules:

- Team and personal connections for the same integration coexist. Uniqueness
  is one connection per `(integration_id, owner)`, where `owner = NULL`
  means team. `connection_exists` / `confirmReplace` semantics apply per
  partition, unchanged otherwise.
- **Unsigned local mode offers no choice.** A single-user loopback server has
  no meaningful team/personal distinction: the UI hides the toggle and all
  connections are stored as team (owner `NULL`). This means unsigned-mode
  behavior is bit-for-bit today's behavior — the feature is additive.
- Consumption resolution: an **interactive turn** resolves the acting
  user's personal connection first, then falls back to team — among
  connections that grant the requested capability (capability filter
  first; a personal row lacking the capability must not shadow a usable
  team row). **Unattended work** (wakes, scheduled runs, proactive agent)
  uses team connections only — a user's personal token is never spent by
  automation they didn't interactively drive. Note "interactive" is a
  property of the **turn's origin**, not the session: a wake fires
  `spawnTurn(sessionId)` into an existing, owned session, so keying
  resolution off session→owner alone would violate this rule (see
  resolution seam).
- Management: personal connections — owner only (others get 404, not 403, to
  avoid existence leaks). Team connections — any signed member (today's
  behavior); admin-only management is a later, separate step once roles are
  threaded through.

## Decisions (settled in design discussion 2026-07-10)

1. **Default scope in signed mode: team.** Matches current behavior;
   personal is the opt-in.
2. **Resolution: personal-then-team fallback**, not per-session explicit
   selection.
3. **Credential keys move to row identity: `integration:{connectionId}`.**
   Rows gain an `id`. This decouples credential identity from the
   partitioning scheme so future scopes (e.g. project) never rekey
   credentials again. Requires a one-time migration of existing provider
   ids (see Phase 2).
4. **Explicit scope selection complements the fallback (settled
   2026-07-10).** The agent-facing selector is the pair
   `(integration, scope)` — never a global slug like
   `personal-{user}-{integration}`. Names are turn-relative: "my
   personal drive" is expressed as `scope: "personal"` and the turn
   credential supplies the "my", so identical tool calls in different
   users' turns resolve to different (or no) rows. Rule: an explicit
   `scope: "personal"` request NEVER silently falls back to team — it
   errors actionably if no personal connection exists. The
   personal-then-team fallback applies only when no scope was stated.

## Architecture: who owns what

Inherited principle (goal.md): the kit stays mechanism-only; make illegal
states unrepresentable; changes are additive/strangler-style with unsigned
mode as the untouched default path.

### Kit (`packages/claxedo-connections`) — opaque partitioning, no identity

The kit must not learn what a "user" is. It gains an opaque partition key:

- `ConnectionRow` gains `id: string` (host-generated) and
  `owner?: string` (opaque; absent = shared partition).
- `ConnectionStorePort`: `get(integrationId, owner?)`,
  `delete(id)`, `getById(id)`, `list(filter?: { owner?: string | null })`.
  Upsert conflict target is `(integrationId, owner)`. The `list` filter is
  deliberately tri-state and MUST be documented on the port type:
  `undefined` = all partitions, `null` = team partition only, string =
  that owner's partition only.
- `ConnectionsService`: `connect` / `connectOAuth` accept
  `owner?: string`; `remove` / `reverify` / `reportAuthFailure` /
  `getToken` move from `integrationId` to connection `id`;
  `list` and `forCapability` accept an owner filter with
  personal-then-team preference implemented as pure mechanism
  (`resolveForCapability(capability, { integration?, owner?, scope? })`
  returns at most one handle per integration, selected
  **capability-first**: among rows whose `grantedCapabilities` include
  the capability, the `owner` partition's row if present, else the
  shared row. Filtering by owner before capability is a bug — a
  personal row lacking the capability would shadow a usable team row
  and turn a working call into a `capability_not_granted` 403).
  `scope?: "team" | "personal"` is an explicit selector overriding the
  preference: `"team"` selects only the shared partition; `"personal"`
  requires `owner` to be present and selects only that partition,
  returning not-found (never a silent team fallback) when no matching
  row exists — as pure mechanism, `"personal"` without an `owner` is a
  caller error.
- Attempt state (`attempts.ts`) carries `{ integrationId, owner?, scope }`
  through the OAuth redirect round-trip; `handleCallback` stores into the
  right partition.
- Routes (`routes.ts`): `POST /:id/connect` body gains
  `scope?: "team" | "personal"`; the gate-provided principal is injected by
  the host (see below), never read from the body. `/connections/:id/*`
  routes now take the connection row id.
- The kit generates no ids and reads no clock beyond the injected `now` —
  id generation is a host-injected `newId()` dep (decision-free kit keeps
  zero global state).

### Host (`claxedo-server`) — identity, storage, policy

- Schema: `claxedo_connection` gains `id TEXT PK`, `owner TEXT NULL`,
  `scope` derivable from `owner` (no separate column — illegal states
  unrepresentable), `UNIQUE(integration_id, owner)` with SQLite treating
  NULL as distinct — enforce the team singleton via a partial unique index
  `WHERE owner IS NULL`.
- Migration (additive, in the existing claxedo migrations chain):
  1. add columns, backfill `id` per row,
  2. rewrite credential rows `integration:{integration_id}` →
     `integration:{id}` in the same migration transaction — PRECONDITION
     to verify first: the managed credential rows
     (`ControlPlaneCredentials`) live in the same SQLite file the
     migration runner (`storage/db.ts` raw `sqlite.exec`) operates on. If
     they do not, this becomes a two-phase rewrite and the compatibility
     read below is load-bearing, not belt-and-suspenders,
  3. keep a compatibility read in the credential adapter for one release
     (log when hit) in case an external backup restores old keys.
- Gate (`connections-host.ts`): already validates the signed principal —
  stop discarding the subject. Resolve
  `principal: { subject } | "unsigned-local"` once per request and hand it
  to the route layer; `scope: "personal"` without a signed subject → 422.
  Unsigned-local principals may manage team connections only (today's
  behavior, unchanged). The gate's loopback short-circuit
  (`connections-host.ts` allows loopback with NO auth, even in signed
  mode) must be scoped down: a subject-less loopback caller is a
  team-scope principal — it never lists, manages, or resolves personal
  rows. Without this rule, any local process leaks every user's personal
  connections via `GET /` on loopback.
- Token route stays loopback + `x-claxedo-connections: 1` as the
  transport gate. Owner resolution NEVER derives from anything the
  runtime asserts — explicitly including a bare `sessionId`, which on a
  shared signed host is guessable/leakable and would act as a forgeable
  bearer for other users' personal tokens. The only input that can
  unlock personal resolution is the host-minted turn credential (see
  resolution seam); its absence resolves to team.

### Resolution seam — whose turn is asking

Two facts make the naive designs wrong, and one fact makes the right
design possible:

- The loopback token route today carries NO identity — not even a session
  id (only peer address + `x-claxedo-connections: 1`). "The server knows
  each session's owner" doesn't help unless the request says which
  session is asking, and a runtime-asserted session id is a forgeable
  bearer.
- "Unattended" is not a session property. A wake calls
  `spawnTurn(sessionId)` into an existing, owned session
  (`central-session-runtime.ts` spawnTurn wiring); pure session→owner
  resolution would spend the owner's personal token on a cron-fired
  turn — exactly the forbidden outcome. Today the wake path carries no
  actor at all (wake tool context omits `actor`; the loopback message
  injection has no identity), so nothing existing can be reused as the
  origin bit.
- Every turn is started by the host itself, at exactly two entry points:
  the gated message route (signed principal just validated) and the
  host's own `spawnTurn`. The host never has to infer origin — only not
  lose it between turn start and token fetch.

Mechanism — **host-minted per-turn credential**:

1. **Mint at turn start.** When the host starts a turn it mints a
   short-lived opaque credential and records host-side
   `{credential → sessionId, subject?}`. Interactive turns record the
   validated subject; `spawnTurn` (wake/schedule/proactive) records no
   subject. The credential encodes nothing — it is a random handle to
   host-side state, so runtimes cannot manufacture or modify one.
2. **Carry via the runtime environment**, the same way the SessionEnv
   seam (`/api/wr/session-env`) already delivers per-session config; the
   runtime attaches it opaquely to token fetches as a new header.
3. **Resolve at the token route** by host-side lookup:
   valid + subject → personal-then-team (capability-first) for that
   subject; valid + no subject → team only; absent/expired/unknown →
   team only.
4. **Fail-safe invariant (this IS the enforcement).** The unattended
   path uses team connections not because it declares itself unattended
   but because it never possessed the thing that unlocks personal. A
   propagation bug degrades to "personal connection not used" (visible,
   mild), never to "personal token spent by automation" — all risk on
   the safe side. Per-turn (not per-session) minting also makes
   concurrent wake + interactive turns in one session resolve
   independently and correctly.

Prerequisite to verify before Phase 3: a queryable server-side
session→owner / principal-at-turn-start mapping exists in EVERY signed
mode. Control-plane session authorization is authority-port backed
(canonically Convex on hosted); confirm the embedded Better Auth
self-host path can answer "which subject started this turn" server-side,
not merely validate a token.

Entry-point enumeration: any message-injection path into a session other
than the gated route and `spawnTurn` must be enumerated during
implementation; each either mints or is deliberately left credential-less
and thus falls into the absent→team row (safe direction).

Consumers: `forCapability` callers (WorkGraph today, doc-collab next)
pass the resolved owner. Where a consumer has no turn context it gets
team scope by construction — WorkGraph's in-process call is server-side
automation and stays team-only permanently.

Agent-facing selection ("use my personal drive"): the tool/MCP surface
for a turn lists the connections that turn can actually use, scope
visible and labeled via `accountLabel` — e.g. `google-drive (team)`,
`google-drive (personal — user@gmail.com)` — filtered by the turn
credential, so unattended turns and other users never see (and thus
never name) a foreign personal entry. The agent selects with
`(integration, scope)` per decision 4; "use my personal X" with no
personal X connected surfaces an actionable not-found the agent can
relay ("connect one in settings, or use team"), never a silent team
fallback.

### UI (`claxedo-app` settings-connections)

- Signed mode: connect dialog gains a scope choice (default **Team**,
  toggle to "Only me"); list shows scope badges; personal rows of other
  users never appear (the server never returns them).
- Unsigned mode: no toggle, no badges — pixel-identical to today
  (inherited release gate: UI parity where behavior is unchanged).

## Phases

### Phase 1 — kit partitioning (no host changes)

- [ ] `ConnectionRow.id` + `owner`, store ports re-keyed, memory store
      updated; upsert conflict per `(integrationId, owner)`.
      Progress:
- [ ] Service methods accept/thread `owner`; `remove`/`reverify`/`getToken`
      move to row ids; `resolveForCapability` implements
      capability-first personal-then-team as pure mechanism with
      behavior tests.
      Progress:
- [ ] Explicit `scope` selector on `resolveForCapability`: `"team"` /
      `"personal"` partition pinning; behavior tests that explicit
      `"personal"` with no matching row returns not-found (never falls
      back to team) and that `"personal"` without `owner` is a caller
      error.
      Progress:
- [ ] Attempts carry `{owner, scope}`; OAuth callback stores into the right
      partition; replay/TTL tests extended.
      Progress:
- [ ] Routes: scope in connect body, row-id connection routes, host-injected
      principal seam; route tests for every scope × principal combination
      (team/personal × signed/unsigned-local).
      Progress:
- Acceptance: `bun test src/` in `packages/claxedo-connections` green; no
  API removed without a replacement; unsigned-shaped usage (no owner ever
  passed) behaves byte-identically to today.

### Phase 2 — host storage + gates

- [ ] Drizzle migration: `id`, `owner`, partial unique indexes; credential
      provider-id rewrite `integration:{integration_id}` →
      `integration:{id}` in-transaction; compatibility read + log.
      Progress:
- [ ] `store-adapter.ts` re-keyed; `connections-host.ts` threads the signed
      subject; personal-scope-requires-signed 422; owner-mismatch → 404.
      Progress:
- [ ] Regression tests: migration fixture with a pre-migration DB snapshot;
      gate tests for cross-user isolation (user A cannot list/delete/
      reverify user B's personal connection); existing loopback/header/
      peer-address gate tests stay green.
      Progress:
- Acceptance: targeted vitest files green
  (`connections-host.test.ts`, `connections-cors.test.ts`,
  `local-only-projection.test.ts`); typecheck green; a pre-feature SQLite
  file opened post-migration lists all old connections as team and their
  tokens still resolve.

### Phase 3a — team-only resolution everywhere (safe floor)

Ships alone and is releasable: no credential mechanism, every consumer
resolves team, behavior identical to today. Personal connections exist
(Phases 1–2) but are list/manage-only until 3b.

- [ ] Token route + in-process consumers resolve team-only; WorkGraph
      `forCapability` call sites annotated team-scope-by-construction.
      Progress:
- [ ] Verify prerequisite: server-side "which subject started this turn"
      mapping exists in embedded Better Auth self-host mode (not just
      hosted/Convex). Record findings here before starting 3b.
      Progress:
- Acceptance: consumer tests green; a personal connection is never
  returned by any token path (asserted by test).

### Phase 3b — turn-origin credential + personal resolution

- [ ] Mint per-turn credential at both turn entry points (gated message
      route with subject; `spawnTurn` without); host-side record with
      TTL; enumerate and disposition any other message-injection paths.
      Progress:
- [ ] Carry credential to runtimes via the SessionEnv seam; token route
      header; resolution table (subject → personal-then-team
      capability-first / no subject → team / absent-expired-unknown →
      team) with a test per row.
      Progress:
- [ ] Behavior tests: personal Notion beats team Notion for the owner's
      interactive turn; team used for everyone else; a wake-fired turn
      in the owner's OWN session resolves team, not personal (the
      defining regression test for this feature); concurrent
      wake + interactive turns in one session resolve independently.
      Progress:
- [ ] Agent-facing selection surface: per-turn connection listing in the
      tool/MCP surface, scope-visible and credential-filtered (foreign
      personal entries never listed); explicit `scope: "personal"`
      honored end-to-end; "personal requested, none connected" returns
      the actionable not-found (tested), with no silent team fallback.
      Progress:
- Acceptance: no code path reaches a personal connection without a valid
  subject-bearing turn credential (enforced by types where possible,
  verified by tests for every entry point); fail-safe direction covered
  (deleting/expiring the credential mid-turn degrades to team, never
  errors into personal).

### Phase 4 — UI

- [ ] Connect dialog scope choice (signed only, default Team); scope badges
      in list; `settings-connections-core.ts` state-machine tests extended.
      Progress:
- [ ] Unsigned mode pixel/behavior parity (no toggle, no badges) —
      browser-use verification per the local visual gate
      (`bun run dev`, backend :3001).
      Progress:
- Acceptance: `bun run test` (browser conditions) green in claxedo-app;
  visual gate cleared for both modes.

## Definition of Done (overall)

- [ ] All phase checkboxes above checked with Progress notes.
- [ ] Unsigned local mode: zero behavior change (existing tests untouched
      and green; no new UI).
- [ ] Signed mode: two users on one host can each hold a personal
      connection for the same integration alongside one team connection;
      isolation verified by tests.
- [ ] Migration proven against a real pre-feature database file.
- [ ] No release exposes personal token resolution before the turn-origin
      credential mechanism exists (Phase 3a may ship alone; 3b is the
      only phase that unlocks personal consumption).
- [ ] `docs/plans/2026-07-03-004-feat-connections-framework-plan.md`
      updated: ownership section replaces the "open follow-up" note.
- [ ] Adversarial review findings (appendix below) all resolved or
      explicitly accepted.

## Execution: parallelize with agents & workflows

Per goal.md's execution mandate: implement with parallel agents owning
disjoint files, and use Workflows for fan-out verification.

- **Agent A (kit)**: `packages/claxedo-connections/src/*` — Phase 1 in
  isolation; the kit has no host imports, so this is fully parallel.
- **Agent B (host)**: `packages/claxedo-server/src/connections-host/*`,
  `storage/connection.sql.ts`, migration — starts against Agent A's port
  types (agree the `ConnectionStorePort` signature first, then work
  concurrently).
- **Agent C (UI)**: `packages/claxedo-app/src/components/
  settings-connections*` — mocks the route shapes from Phase 1's route
  tests; integrates last.
- **Verification workflow**: after integration, fan out one agent per test
  surface (kit bun tests, host vitest targeted files, app tests, migration
  fixture) plus an adversarial verifier per DoD line; loop until dry.

## Appendix: adversarial review findings

Review pass 2026-07-10, grounded in code (every claim verified against
`dev`). Verdicts: fix-in-plan = the plan text above was amended;
verify-before-phase = a recorded precondition; accepted-risk = rationale
given.

1. **Token route carries no identity at all — CONFIRMED gap
   (fix-in-plan).** `GET /connections/:id/token` is gated only by
   loopback peer address + literal header `x-claxedo-connections: 1`
   (`connections-host.ts:107-112`); no session id, no subject. Any
   design where the runtime asserts a session id makes that id a
   forgeable bearer for other users' personal tokens on a shared signed
   host. Resolved: host-minted per-turn credential (resolution seam);
   bare session ids explicitly banned as a resolution input. Since the
   HTTP route has NO shipping consumer yet (WorkGraph consumes
   in-process; route referenced only in tests), the identity contract
   is designed clean now rather than retrofitted.

2. **"Unattended → team" cannot hang off the session — CONFIRMED gap
   (fix-in-plan).** Wakes call `spawnTurn(sessionId)` into an existing,
   owned session (`central-session-runtime.ts:544-551`); session→owner
   resolution alone would spend the owner's personal token on a
   cron-fired turn. Nothing today carries an origin bit: the wake tool
   context omits `actor` (`central-session-runtime.ts:221-226`) and the
   loopback message injection has no identity. Resolved: origin is
   stamped per-turn at mint time; the fail-safe invariant
   (absent/unknown credential → team) makes enforcement structural, and
   Phase 3b carries the defining regression test (wake-fired turn in
   the owner's own session resolves team).

3. **Loopback short-circuit in signed mode leaks personal rows
   (fix-in-plan).** The gate allows loopback with no auth even in
   signed mode (`connections-host.ts:87-88`). Unscoped, any local
   process could list/manage every user's personal connections via
   loopback. Resolved: subject-less loopback caller = team-scope
   principal (gate section).

4. **Capability/owner filter ordering (fix-in-plan).** `getToken` 403s
   on a capability miss (`service.ts:211`). "Owner partition's row if
   present, else shared" — as originally worded — let a personal row
   lacking the capability shadow a usable team row. Resolved:
   `resolveForCapability` selects capability-first.

5. **`resolveActingOwner` assumed a mapping that may not exist in all
   modes (verify-before-phase-3b).** Session authorization lives in the
   control-plane authority port (canonically Convex on hosted) and is
   never consulted by connections-host today; embedded Better Auth
   sessions live in a separate SQLite file. The plan now records a
   Phase 3a checkbox to verify "which subject started this turn" is
   answerable server-side in embedded self-host mode before 3b starts.

6. **"Same migration transaction" credential rewrite is conditional
   (verify-before-phase-2).** The migration runner raw-execs SQL
   against the claxedo DB (`storage/db.ts`); the rewrite is
   transactional only if the managed `ControlPlaneCredentials` rows
   live in that same file. Precondition recorded in the migration step;
   otherwise the compatibility read is load-bearing.

7. **`list` owner filter tri-state footgun (fix-in-plan).**
   `undefined` vs `null` vs string semantics now documented as a
   requirement on the port type.

8. **Personal fallback is invisible (accepted-risk).** Personal-then-team
   means the owner's interactive turns silently behave differently from
   teammates' — a debugging surprise, and a prompt-injected agent in the
   owner's interactive session can spend the owner's personal token.
   Accepted for v1: fallback beats a per-session selection UX tax
   (settled decision 2), the exposure is scoped to the owner's own
   interactive turns (never automation — finding 2), and the UI shows
   scope badges. Mitigation if it bites: log/surface which connection
   served each token resolution.

Confirmed-sound (no change needed): row-id credential keys preserve the
host stores' one-credential-per-provider-id invariant
(`types.ts:97-100`); the attempt state machine extends trivially since
the redirect round-trip exposes only the opaque `state`
(`attempts.ts:66-88`); 404-not-403 for foreign personal rows; partial
unique index `WHERE owner IS NULL` correctly handles SQLite
NULLs-are-distinct; existing rows → team matches "bit-for-bit today's
behavior" for unsigned mode.
