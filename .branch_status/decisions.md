# Decision Record

## Settled product decisions

### D1: Private session direction

Target behavior: session transcripts are private to the creator, active participants, and organization administrators who retain workspace authority.

Why: workspace membership is too broad for collaborative transcript privacy.

### D2: Unbranched onboarding

Personal organization creation stays implicit. The product does not ask a new user to choose personal versus team during onboarding.

Why: tenancy must not make the solo path harder.

### D3: No automatic personal-to-team migration

Existing personal workspaces do not move into a team without an explicit user action.

Why: organization reassignment changes ownership and access semantics.

### D4: Transcript privacy boundary

Session privacy covers transcript-bearing session, event, PTY, process-log, and projection surfaces. Files and working trees remain governed by workspace authority.

Why: per-session filesystem privacy is a different product and storage model.

### D5: Team terminology (superseded by D17)

~~User-facing copy says `Team`; code retains `org`.~~

Superseded 2026-08-29 by **D17** (Org → Team nesting). Historical copy that equated Team with `org` is obsolete.

### D6: Compatibility boundary

OpenCode request, response, status, and event behavior is the external boundary. Claxedo-only internal shapes can change directly without compatibility aliases.

Why: duplicate internal contracts create permanent migration paths and ambiguity.

### D7: Team creation authority

Creating a project or workspace in a team requires current write authority.

### D8: Participant administration

The session creator or organization administrator may add/remove participants (and session share grants) only while retaining current workspace authority. After Org→Team nesting, a **team admin** may also administer grants for sessions whose project the team can access.

### D17: Org → Team nesting

**Org** is the company/tenant (billing, credentials, RAT `org_id`, live-sync isolation). **Team** is an access group **inside** an org (`teams` / `team_memberships`). Projects belong to an org; teams receive `team_project_grants` to projects.

Migration: each non-personal org gets one **default team**; existing `org_memberships` copy into that team's memberships; the default team is granted all current projects in the org. Do **not** auto-enroll historical private sessions onto the default team.

Personal orgs need no team CRUD (D2 preserved). User-facing copy says **Org** and **Team** distinctly; code uses `orgs` and `teams`.

### D18: Session share targets

Private sessions may be shared with an **individual user** (`session_participants` and/or user-targeted `session_share_grants`) or a **team** (team-targeted `session_share_grants`, evaluate-time membership join). Org-targeted session grants are an interim Phase-1 shape and retarget to `team_id` when nesting lands.

Org-admin session bypass remains for support (private ≠ hidden from org admins). Team grants control normal collaborator visibility. Revoking a group session grant fans out RAT revoke like workspace org shares.

### D19: Active org and team

Principal carries application `orgId` (tenant) and optional active `teamId` (filter). Hosted multi-org deployments expose an org switcher; user-deployed one-org hides org switching. Team switcher applies whenever the org has multiple teams.

### D20: CF/Better Auth + D1 ports the same nested model

Cloudflare cutover requirements **R31** and **R35** (see `docs/plans/2026-08-27-147-refactor-cloudflare-d1-better-auth-cutover-plan.md`) certify `org → team → project → workspace → session` with session share targets user XOR team. D1 and SQLite authority adapters must grow the same `teams`, `team_memberships`, `team_project_grants`, and `session_share_grants` tables and evaluation as Convex—Better Auth remains identity-only (no Organizations UI as source of truth).

SQLite schema + tenancy migration v3, evaluate/list/grant/revoke, and default-team org→team share retarget have landed in `workspace-authority-store.ts` / `workspace-authority.ts`. D1 `CONTROL_PLANE_DB` DDL must mirror those tables when the Better Auth+D1 profile is implemented (see Core target data notes in the cutover plan); do not certify D1 without them.

## Settled technical decisions

### D9: One admission owner

`AgentRuntime` owns a single durable per-session turn lease. Adapters and routes do not implement parallel collision policy.

### D10: Canonical producer identity

Actor, tenant, author, and event scope come from their authoritative producer. Consumers do not synthesize a missing value from the current reader, synchronizer, or nearby event.

### D11: Filter collections

Session list/search/history collections filter unauthorized rows. They do not deny the entire collection because one row is private.

### D12: One live/replay policy

Live delivery, retained replay, reconnect drain, and compatibility proxy delivery use the same session visibility contract.

### D13: Fail closed with accurate status

Authority unavailability fails closed but remains a retryable 503. Permission denial is 403. Invalid proof is 401.

### D14: Expand, migrate, verify, contract

Convex schema changes use ledger-backed ordered migrations. Required fields become contractual only after verification succeeds. SQLite uses the documented transactional stopped-service hard cut.

### D15: Preserve canonical session placement through the client

Central, workspace-runtime, and local session placement comes from the
authoritative session/inventory producer. Direct-route resolution, cache keys,
hydration, and lifecycle updates preserve that placement; a tool-sandbox
directory or nearby workspace hint cannot reclassify the session.

Why: a correctly authorized central session can still hydrate through the wrong
transport if the app infers placement from execution metadata.

### D16: Child lifecycle owns task-card status

Subagent/task cards render the canonical child lifecycle. A parent task tool
error does not replace a child that has reached a terminal lifecycle, and
terminal subagent updates are retained for authorized replay.

Why: provider adapters can report parent tool failure after the delegated child
has completed. The child lifecycle is the authoritative answer for multiplayer
observers and reconnecting clients.

## Resolved design gates

### O1: Human and agent actor representation

Resolution: a stable authenticated user keeps its canonical kind. Runtime calls carry an explicit paired `actorId`/`actorKind`; incomplete or conflicting pairs fail closed. Internal control-plane work is a separate service principal with agent kind. Runtime access tokens persist and revalidate both principal kind and actor kind.

### O2: Renewable stream authorization

Resolution: PTY and SSE use a renewable session lease linked to the active runtime access token. Renewal rechecks current session authority, remains bounded, and terminates the connection on denial or unavailable renewal. The expired establishment proof is not reused as authority.

### O3: Event grant cache semantics

Resolution: grants are scoped by principal/session, short-lived, renewable, and shared by live/replay delivery. Per-scope queues and reconnect authorization concurrency are bounded; overflow disconnects for replay recovery. Replay results retain source order and have a total startup deadline. A later denial after prior authorization is revocation and terminates the stream.

### O4: Ambiguous registration outcome

Resolution: callers preassign stable session ids and registration is idempotent. Definitive registration failure compensates by deleting the runtime session; cleanup failure is retained as part of the error. A retry with the same id reconciles the authoritative row instead of creating a second identity.

## Rejected review proposals

- Treating migration-assigned opaque ids as inherently synthesized fallback was rejected after validation; the migration can be their canonical producer when tenant provenance is unambiguous.
- Requiring a separate WorkGraph service actor was rejected because current product behavior intentionally attributes owner-initiated WorkGraph operations to the owner.
- Supporting concurrent old/new SQLite writers was rejected; the documented topology is a stopped-service transactional hard cut.
- Splitting `convex/sessions.ts` solely because of file size was rejected as preference without a demonstrated defect.
