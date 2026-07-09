# Connection Scoping: Team-Shared and Personal Connections

Status: draft (adversarial review pending)
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
- Consumption resolution: an **interactive session** resolves the acting
  user's personal connection first, then falls back to team. **Unattended
  work** (wakes, scheduled runs, proactive agent) uses team connections
  only — a user's personal token is never spent by automation they didn't
  interactively drive.
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
  Upsert conflict target is `(integrationId, owner)`.
- `ConnectionsService`: `connect` / `connectOAuth` accept
  `owner?: string`; `remove` / `reverify` / `reportAuthFailure` /
  `getToken` move from `integrationId` to connection `id`;
  `list` and `forCapability` accept an owner filter with
  personal-then-team preference implemented as pure mechanism
  (`resolveForCapability(capability, { integration?, owner? })` returns at
  most one handle per integration: the `owner` partition's row if present,
  else the shared row).
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
     `integration:{id}` in the same migration transaction,
  3. keep a compatibility read in the credential adapter for one release
     (log when hit) in case an external backup restores old keys.
- Gate (`connections-host.ts`): already validates the signed principal —
  stop discarding the subject. Resolve
  `principal: { subject } | "unsigned-local"` once per request and hand it
  to the route layer; `scope: "personal"` without a signed subject → 422.
  Unsigned-local principals may manage team connections only (today's
  behavior, unchanged).
- Token route stays loopback + `x-claxedo-connections: 1`. It gains an
  optional `owner` resolution input that the HOST derives (see resolution
  seam) — never trusted from a remote client; loopback-only remains the
  transport gate.

### Resolution seam — whose session is asking

The server knows each session's owner; runtimes do not carry user identity.

- New host seam `resolveActingOwner(sessionId | request-context) →
  string | undefined` backed by the control-plane session→owner mapping.
  Interactive signed sessions → the owning subject. Unsigned local, and any
  unattended trigger (wake, schedule, proactive), → `undefined` (team).
- `forCapability` consumers (WorkGraph today, doc-collab next) pass the
  resolved owner. Where a consumer has no session context, it gets team
  scope by construction — the safe default falls out of the types instead
  of a runtime check.

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
      personal-then-team as pure mechanism with behavior tests.
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

### Phase 3 — resolution + consumers

- [ ] `resolveActingOwner` seam over the session→owner mapping; unattended
      paths (wakes/scheduled/proactive) type-constrained to team scope.
      Progress:
- [ ] WorkGraph `forCapability` call sites pass resolved owner;
      personal-then-team covered by a behavior test (personal Notion beats
      team Notion for the owner's interactive session; team used for
      everyone else and for unattended).
      Progress:
- Acceptance: consumer tests green; no consumer can reach a personal
  connection without a resolved subject (enforced by types, verified by a
  compile-fail test or lint rule).

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

(To be filled by the review pass; each finding gets a verdict —
fix-in-plan, fix-in-implementation, or accepted-risk with rationale.)
