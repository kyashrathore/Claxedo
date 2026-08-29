# Verification and Rollout Plan

## Current verification result — 2026-08-28

All 18 validated review findings are closed. The implementation is based on
`dev` at `834307041e8b01eef532833b8deb3703f03dc647`. The authority review
closes through `2adbe6ca4c`; post-review runtime-to-UI fixes are
`430fa0bc1d`; deterministic browser-test follow-up is `9bf5849c41`.

Passed:

- `@claxedo/server`: 3,068 passed, 14 skipped; its canonical command also ran the 397-test Convex suite.
- `@claxedo/server-core`: 484 passed.
- `@claxedo/local-server`: 227 passed.
- `@claxedo/agent-sdk-runtime`: 492 passed; typecheck and distribution build passed.
- `@claxedo/workspace-runtime`: 893 unit, 37 relay, and 59 real PTY/storage tests passed.
- App non-browser E2E: 26 Bun tests and 6 journey tests passed.
- Browser WorkGraph: 20/20 in both signed test-user and local-unsigned modes.
- Browser mobile matrix: 5/5 in both auth modes.
- The three deterministic core-browser failures were rerun after their fixes in both auth modes: 3/3 and 3/3 passed.
- All affected package typechecks passed.
- Root lint passed with 17,185 warnings and zero errors.
- `git diff --check` passed.

Post-review follow-up verification:

- Focused changed app units: 177 Bun tests passed.
- Focused changed app component tests: 25 Vitest tests passed.
- Central runtime: 30 tests passed.
- ACP adapter: 42 tests passed.
- Workspace event route: 6 tests passed.
- Session UI task-card behavior: 14 tests passed.
- App, server, agent SDK runtime, workspace runtime, and session UI typechecks
  passed. The app command also passed 264 architecture tests, 20 timeline
  performance tests, and 38 performance component tests.
- Former Pi and Codex ACP blockers passed together in the real-provider browser
  composition.
- The complete real-harness lane passed: 14 passed, 1 recording-only test
  skipped.
- The complete two-mode core browser matrix completed with one strict locator
  ambiguity in WorkGraph. After changing the helper to the unique accessible
  toolbar name, the exact journey passed in both `test-user` and
  `local-unsigned` modes.
- `git diff --check` passed after all implementation and documentation edits.

Current non-environment test failures:

- `packages/claxedo-app: bun run test`: 5,695 passed, 2 failed.
- `submit.harness-dispatch.test.ts` — “existing harness follow-up preserves its
  persisted harness variant”: expected `claude-acp/opus` with variant `high`,
  received the generic `provider/model` selection.
- `submit.session-config.test.ts` — “second submit with unchanged config does
  NOT re-PATCH”: expected one config PATCH, observed two.

Those files were not changed by `430fa0bc1d` or `9bf5849c41`. They remain real
suite failures and are the only known local merge gate.

Environment-limited lanes:

- Live-provider E2E requires credentials not available in this run.
- Desktop E2E requires a packaged Electron artifact.
- The public-web package currently has no discoverable E2E tests (`No tests found`).
- The monorepo-wide typecheck is blocked in this nested worktree because shared `dist` symlinks point to the parent checkout, causing TypeScript to load duplicate Hono/Zod declarations. The 36 other tasks passed; all affected packages pass independently.

## Merge gates

The branch may merge only when:

1. All P1 findings in `review-findings.md` are closed. **Passed.**
2. P2 findings #23, #24, and #28 are closed. **Passed.**
3. The deployment migration gate (#18) is implemented. **Passed in code; staging rehearsal remains a deploy gate.**
4. The targeted unit/integration matrix passes on the rebased branch. **Passed.**
5. The local Org→Team multiplayer production-like smoke passes (see below). **Required.**
6. The Pi and Codex ACP real-harness lifecycle failures are resolved. **Passed.**
7. The complete real-harness lane is rerun. **Passed: 14 passed, 1 recording-only skip.**
8. The complete app unit command passes, or the two composer failures receive
   an explicit owner waiver. **Open: 5,695 passed, 2 failed.**

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

## Production-like Org→Team multiplayer smoke

Canonical `@tier-real` browser proof (replaces the old participant-only two-user suite):

```bash
CLAXEDO_TIER_REAL_E2E=1 bunx playwright test \
  packages/claxedo-app/e2e/playwright/web-signed-org-team-multiplayer.spec.ts
```

Real layers: production web build, self-hosted `createSelfHostedApp`, SQLite `WorkspaceAuthority`, JWT control plane, workspace runtime/relay, People UI, composer drive. Substitutes: local JWKS teammate mint, page token seed, scripted model.

Required evidence artifacts (fail if missing):

- `test-results/evidence/web-signed-org-team-multiplayer/videos/alice.webm`
- `.../bob.webm`, `.../casey.webm`
- `.../side-by-side.mp4`
- `.../manifest.json` plus deny/allow/drive/revoke screenshots

Journey checklist:

1. Alice's collaborative org has a default team; Bob is a team member.
2. Casey has workspace editor access but is not on the team.
3. Alice creates a private session; Bob and Casey cannot list/read it.
4. Alice shares the session with the team via People UI.
5. Bob lists, opens, reads, and drives a turn; authors visible.
6. Casey remains denied.
7. Alice revokes the team session share; Bob is denied again.

Cheaper subsets (no browser/video): `two-user-signed-transport.e2e.test.ts` (HTTP org/team/share) and `two-user-product.e2e.test.ts` (Convex nested team share).

## Legacy two-user checklist (subsumed)

The older participant-add smoke is subsumed by the Org→Team video suite. Remaining items not covered there stay as focused gates:

1. Concurrent turn admission (Journey 4) — separate harness/runtime tests.
2. Fork child registration (Journey 5) — separate tests.
3. PTY/SSE hard-close timing after revoke (Journey 6 deep) — lease-bound tests.
4. Authority 503 / bounded queue — reliability suite.

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
- Production-like Org→Team multiplayer smoke passes (video + manifest).
- Migration rehearsal passes on representative legacy data.
- Rollback procedure is exercised.
- No obsolete fallback identity, local lease, duplicate policy, or temporary compatibility path remains.
