# Validated Review Findings

## Review scope

Reviewed implementation tree: `062fc24c33c72d10fab3cede8f9267e97a66174b`

Rebased implementation commit: `c97d1fe3cefed0f6aeb9da1e0f38bc6b4b308924`

Base: `866feaabe2fa1f80f51aa05d7788626ae7a3bf5b`

Review coverage: correctness, project standards, testing, maintainability, agent-native behavior, security, performance, API compatibility, data migrations, reliability, adversarial analysis, and deployment verification.

Independent validation checked 23 candidates. Eighteen survived and five were rejected. One preference-only P1 was removed during synthesis. Four P2 advisories moved to residual/testing risks.

Verdict: **NOT READY**

## P1 findings

### #2: Human and agent clients overwrite one shared actor kind

Location: `convex/model.ts:153`

Impact: Browser and CLI requests update the same user row to different kinds. `authorizeRuntime` rejects an active token after the other client changes the stored kind.

Required response: Make actor kind immutable for a stable actor or introduce a distinct linked agent actor. Add a concurrent browser/CLI test.

Owner: downstream resolver. Confidence: 100.

### #3: Revoked creators retain participant-management authority

Location: `convex/sessions.ts:108` and SQLite authority equivalents

Impact: A creator who lost workspace/org authority can still add or remove participants because creator status bypasses the current workspace-authority check.

Required response: Require current workspace read authority before creator/admin participant management in both backends. Add revocation parity tests.

Owner: downstream resolver. Confidence: 100.

### #5: Sessionless global events bypass tenant scoping

Location: `packages/claxedo-local-server/src/opencode/compat-routes/index.ts:120`

Impact: Signed subscribers can receive another tenant's document, workgraph, or provisioning events when the frame has no recognized session id.

Required response: Apply canonical `eventVisibleTo` subject/org filtering and default-deny unclassified signed frames.

Owner: downstream resolver. Confidence: 100.

### #6: SQLite and Convex derive different repository keys

Location: `packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority-store.ts:462`

Impact: One backend can merge distinct case-sensitive repositories or fail to match equivalent SSH/HTTPS repositories. Project identity and membership then differ by backend.

Required response: Use one dependency-light canonicalizer and a shared parity table.

Owner: downstream resolver. Confidence: 100.

### #8: Identity-aware SSE repeats authorization per frame

Location: `packages/workspace-runtime/src/event-delivery.ts:262`

Impact: The event source authorizes during enqueue and the writer authorizes the same frame again. Authority load grows with frames times connections.

Required response: Carry the enqueue decision to the writer and coalesce bounded connection/session grants.

Owner: downstream resolver. Confidence: 100.

### #9: Authority work enters an unbounded promise queue

Location: `packages/workspace-runtime/src/event-delivery.ts:303`

Impact: Slow authority calls accumulate unlimited pending closures before SSE backpressure, growing memory and stream delay.

Required response: Cap per-scope work, coalesce safe events, and terminate overflowed streams for replay recovery.

Owner: downstream resolver. Confidence: 100.

### #10: Reconnect serially authorizes every retained frame

Location: `packages/workspace-runtime/src/event-delivery.ts:339`

Impact: A 256-event replay can wait for roughly 21 minutes when each authority call reaches its five-second timeout.

Required response: Use bounded concurrency, per-session caching, preserved ordering, and a total startup deadline.

Owner: downstream resolver. Confidence: 100.

### #11: Authority 503 responses become permanent 403 denials

Location: `packages/workspace-runtime/src/remote-session-authority.ts:36`

Impact: Clients and streams treat a retryable authority outage as a permanent private-session denial.

Required response: Preserve 503 and its canonical error code; reserve 401 for invalid proof and 403 for denied authority.

Owner: downstream resolver. Confidence: 100.

### #12: Removed participants can replay private PTY logs

Location: `packages/workspace-runtime/src/routes/process.ts:85`

Impact: A removed participant who knows a PTY id can read its snapshot through `/process/logs` because the compatibility route checks only workspace role and PTY existence.

Required response: Pass `SessionAccessPolicy` into `ProcessRoutes` and authorize every PTY lookup alias.

Owner: downstream resolver. Confidence: 100. Corroborated by testing and adversarial reviewers.

### #13: Forked sessions are never registered

Location: `packages/workspace-runtime/src/routes/session-core.ts:1189`

Impact: Fork returns HTTP 201, but the child has no creator/participant authority record. Later reads and prompts fail closed.

Required response: Register and project the child like ordinary creation; delete it on registration failure.

Owner: downstream resolver. Confidence: 100. Corroborated by testing and correctness reviewers.

### #14: Failed registration leaves sessions created

Location: `packages/workspace-runtime/src/routes/session-core.ts:801`

Impact: The client receives a denial after the runtime persisted a session. Retries can conflict or accumulate hidden sessions.

Required response: Compensate V1 and V2 creation with deletion, preserve cleanup errors, and prove retry with the same id.

Owner: downstream resolver. Confidence: 100. Corroborated by four reviewers.

### #15: Proxy SSE waits on authority for every frame

Location: `packages/workspace-runtime/src/workspace/runtime.ts:972`

Impact: Message delta delivery is limited by a central HTTP authority round trip per frame.

Required response: Use a renewable short session grant and terminate on renewal failure instead of authorizing inside every transform.

Owner: downstream resolver. Confidence: 100.

### #16: A session can retain a project different from its workspace

Location: `convex/migrations.ts:107`

Impact: A same-org legacy project reference is preserved even when it differs from `workspace.project_id`; verification checks only presence.

Required response: Enforce equality or stop with a row-specific conflict. Add the equality check to the verification migration.

Owner: downstream resolver. Confidence: 75.

### #18: Deployment skips the tenant migration gate

Location: `docs/tech-docs/tenant-identity-schema-rollout.md:58` and `.github/workflows/deploy-control-plane.yml`

Impact: New private-session authorization can deploy before legacy creator/participant/tenant data is backfilled, making legacy sessions inaccessible.

Required response: Run all five backfills and five verification migrations before relay/runtime publication in staging and production. Require a legacy-session smoke.

Owner: release. Confidence: 75. This is a release decision gate, not an automatic code fix.

### #21: Minute-old credentials disconnect valid private PTYs

Location: `packages/workspace-runtime/src/routes/pty.ts:273`

Impact: The socket rechecks authority each second with the fixed 60-second establishment proof, so an otherwise authorized PTY closes after about one minute.

Required response: Add a renewable stream lease linked to revocable parent runtime authority.

Owner: downstream resolver. Confidence: 75.

## P2 findings

### #23: Turn leasing falls back to an instance-local map

Location: `packages/agent-sdk-runtime/src/runtime.ts:194`

Impact: Runtime reconstruction loses the lease and can admit a second turn for the same durable session.

Required response: Make durable lease methods required on the runtime store and add a two-runtime reconstruction test.

Owner: downstream resolver. Confidence: 100.

### #24: SQLite omits the durable organization-owner fallback

Location: `packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts:443`

Impact: An organization owner without a legacy membership row loses session authority only in SQLite, while Convex honors the durable owner field.

Required response: Add the owner fallback to SQLite session role, participant administration, and listing. Add backend parity coverage.

Owner: downstream resolver. Confidence: 100.

### #28: Cold transcript sync assigns messages to the sync caller

Location: `packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts:1502`

Impact: When stored authors are absent, historical messages by other people are displayed as if the actor running sync wrote them.

Required response: Carry producer-backed actor identity through projection and leave unknown historical authors unattributed.

Owner: downstream resolver. Confidence: 75.

## Rejected or reclassified candidates

| Candidate | Disposition | Reason |
|-----------|-------------|--------|
| #1 migration-generated opaque ids | Rejected | The migration can be the canonical producer when tenant provenance is unambiguous |
| #4 split the session module | Rejected | File size alone did not prove a current defect |
| #7 separate WorkGraph service actor | Rejected | Current behavior intentionally attributes owner-initiated work to the owner |
| #17 revoke tokens on org deletion | Pre-existing risk | The behavior predates this feature diff |
| #19 support concurrent old SQLite writers | Rejected | Supported rollout is a stopped-service hard cut |
| #20 fetch bridge lacks authority URL | Unproven | External bridge can inject its runtime environment |
| Session-list participant N+1 | Residual performance risk | No production load failure was established |
| Tenancy inventory text-window test | Testing gap | The gate can be stronger, but it is not the primary tenant contract |
| One-second PTY authority polling | Residual performance risk | Superseded by the blocking stream-lease finding #21 |
| Per-row session filter authority calls | Residual performance risk | Requires load bounds and batching design |

## Fix order

1. #5 and #12: close direct data exposure.
2. #3, #13, and #14: complete session revocation and lifecycle atomicity.
3. #11 and #21: establish correct outage and long-lived proof semantics.
4. #8, #9, #10, and #15: implement one bounded event grant/queue design.
5. #2, #6, #16, #24, and #28: restore canonical identity and backend parity.
6. #23: make admission durable.
7. #18: gate deployment on migration and verification.

## Completion evidence required per finding

Every closed finding must record:

- Fixing commit.
- Focused positive and negative tests.
- Backend parity evidence where applicable.
- Public entrypoint or deployed smoke evidence where applicable.
- Any remaining product/release decision.
