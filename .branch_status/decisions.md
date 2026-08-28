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

### D5: Team terminology

User-facing copy says `Team`; code retains `org`.

Why: the product term can improve without a risky internal rename.

### D6: Compatibility boundary

OpenCode request, response, status, and event behavior is the external boundary. Claxedo-only internal shapes can change directly without compatibility aliases.

Why: duplicate internal contracts create permanent migration paths and ambiguity.

### D7: Team creation authority

Creating a project or workspace in a team requires current write authority.

### D8: Participant administration

The session creator or organization administrator may add/remove participants only while retaining current workspace authority.

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
