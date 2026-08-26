# Verification and Rollout Plan

## Merge gates

The branch may merge only when:

1. All P1 findings in `review-findings.md` are closed.
2. P2 findings #23, #24, and #28 are closed or explicitly deferred by the owner with recorded consequences.
3. The deployment migration gate (#18) is implemented and rehearsed.
4. The targeted unit/integration matrix passes on the rebased branch.
5. The two-user production-like smoke passes.

## Focused verification matrix

### Identity and tenancy

- Browser and CLI operate concurrently without changing a stable actor kind (#2).
- Equivalent SSH and HTTPS repository forms map to one key in Convex and SQLite (#6).
- Case-sensitive repository paths do not collapse (#6).
- A migrated session cannot retain a project different from its workspace (#16).
- SQLite and Convex agree on durable organization owner authority (#24).

### Session lifecycle and privacy

- Revoked creator cannot add or remove participants (#3).
- Nonparticipant editor cannot use PTY id, terminal id, process id, or name aliases to read logs (#12).
- Fork registers the child and applies creator/participant policy (#13).
- Fork registration denial deletes the child (#13).
- V1 and V2 create registration denial leaves no runtime session (#14).
- Retrying the same client-provided id succeeds after authority recovery (#14).

### Admission and attribution

- Two concurrent prompts admit exactly one winner and one structured 409 loser.
- Two runtime instances sharing one store cannot overlap the same session turn (#23).
- Existing known authors are preserved during sync (#28).
- Unknown historical authors remain unknown rather than becoming the sync caller (#28).

### Events, replay, and PTY

- Two organizations subscribed to global events never see each other's sessionless frames (#5).
- One delivered frame causes one effective policy decision per connection (#8).
- A stalled authority cannot create an unbounded pending-event queue (#9).
- Reconnect readiness has a fixed deadline under retained replay (#10).
- Authority 401, 403, and 503 retain distinct semantics (#11).
- Proxy streaming does not perform one remote decision per message delta (#15).
- A valid PTY remains connected beyond 60 seconds (#21).
- Participant revocation closes PTY and SSE within the lease bound (#21).

## Production-like two-user smoke

Use two real signed identities, real runtime/relay proofs, and the production route composition.

1. User A creates a workspace and private session.
2. User B has workspace access but cannot see the session.
3. User A adds User B as participant.
4. User B opens HTTP transcript, replay, live SSE, and PTY.
5. Both submit concurrently; exactly one turn is admitted.
6. Verify each user message displays the correct author.
7. User A forks; User A can use the child and User B cannot unless granted.
8. Remove User B.
9. Confirm HTTP, process logs, replay, reconnect, SSE, and PTY all deny/close.
10. Keep an authorized PTY open beyond 60 seconds and confirm it remains active.
11. Simulate authority 503 and confirm retryable failure with bounded queue/reconnect behavior.

## Convex rollout

Follow `docs/tech-docs/tenant-identity-schema-rollout.md` as the command-level source.

Required order:

1. Deploy expand schema and compatible readers/writers.
2. Backfill user actor identity.
3. Backfill project tenant identity.
4. Reconcile project membership project ids.
5. Backfill workspace tenant identity.
6. Backfill session tenant identity.
7. Run all matching verification migrations.
8. Check migration ledger for completion and zero errors.
9. Run a migrated legacy-session creator/participant smoke.
10. Publish relay and runtime enforcement.
11. Contract required fields only in a later approved release.

Hard stop conditions:

- Ambiguous org/project provenance.
- Session project differs from workspace project.
- Missing creator where the authoritative producer can resolve it.
- Duplicate canonical repository keys with conflicting projects.
- Verification ledger incomplete.

## SQLite rollout

1. Stop all writers using the authority database.
2. Create and retain the documented pre-upgrade backup.
3. Run the transactional upgrade/backfill.
4. Run non-null, uniqueness, tenant equality, and policy parity checks.
5. Start only the new binary.
6. Run local creator/participant/revocation smoke.

Rollback:

- Stop the new binary.
- Restore the pre-upgrade database backup.
- Start the previous binary.
- Do not attempt concurrent old/new writers or downgrade writes against the contracted schema.

## Deployment workflow gate

Both staging and production workflows must:

1. Deploy the expand-compatible control plane.
2. Run tenant backfills.
3. Run verification migrations.
4. Assert the ledger and smoke result.
5. Only then deploy relay/runtime enforcement.

Promotion from staging to production must use the same ordered gate, not a documentation-only manual expectation.

## Observability

Add or verify metrics/logs for:

- Authority results by action and status: 401, 403, 503.
- Session registration success, denial, cleanup, and ambiguous outcome.
- Fork registration and cleanup.
- Active session turn leases and collision count.
- Event authorization calls per connection/session/frame.
- Pending event authorization queue depth and oldest age.
- Replay authorization count and connection readiness latency.
- Stream lease renewal success/denial/unavailable.
- PTY close code/reason, especially code 1008 near 60 seconds.
- Revocation-to-stream-close latency.
- Migration ledger progress and row-specific conflicts.

## Failure injection

- Authority returns 503 during create registration.
- Authority times out after committing registration.
- Authority stalls during a high-volume message stream.
- Authority stalls during reconnect replay.
- Participant is removed while SSE and PTY are active.
- Runtime reconstructs while a turn lease is active.
- Migration encounters a same-org wrong-project session.
- SQLite upgrade fails between table rebuild steps.

## Documentation verification

Before merge:

- `README.md` status matches `status.json`.
- Finding counts match `review-findings.md`.
- Architecture invariants map to focused tests.
- PRD acceptance criteria map to the smoke plan.
- Every open design gate in `decisions.md` has an owner and resolution.

## Definition of done

- Implementation behavior satisfies the PRD through real entrypoints.
- All P1 findings are closed with evidence.
- Targeted tests, typechecks, and relevant builds pass.
- Production-like two-user smoke passes.
- Migration rehearsal passes on representative legacy data.
- Rollback procedure is exercised.
- No obsolete fallback identity, local lease, duplicate policy, or temporary compatibility path remains.
