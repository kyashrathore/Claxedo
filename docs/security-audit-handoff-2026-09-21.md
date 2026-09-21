# Security remediation handoff — 21 September 2026

User requested wrap-up to conserve usage. No new implementation assignments or reviews are being dispatched. This is a handoff of incomplete audit work, not full security acceptance.

The [revalidation tracker](security-audit-revalidation-2026-09-20.md) contains all 161 findings from the [original audit](security-audit-findings-2026-09-19.md): **31 fixed with focused verification, 20 resolved/consolidated or not established as originally claimed, 110 open**. Of the open findings, 35 are partial or awaiting acceptance and 75 need investigation, fixes or hardening. Counts describe tracker categories, not a fresh reproduction of all findings.

The shared `dev` working tree contains extensive unrelated changes. It has not been stashed, reset, committed or pushed by this wrap-up. Preserve those changes. Do not introduce fallback data, compatibility paths or duplicate implementations. Flag work beyond a small fix before expanding it.

## Final bounded slices

| Slice | Verified result | Remaining boundary |
| --- | --- | --- |
| P-125 explicit workspace IDs | Unknown or empty explicit IDs fail instead of selecting another workspace by directory. Store and real local HTTP coverage passed; legitimate directory-only creation and project discovery remain. | Independent Devin source review completed with no defects found; the boundary is resolveWorkspace, not all store write APIs. |
| P-119 billing timestamps | Subscription events without provider modified/created time are rejected before a store write; arrival-time synthesis removed. Signed webhook regression preserves a newer subscription. | External authority monotonic ordering for valid timestamps was modeled, not executed live. |
| P-107 Bun relay memory | Frame and byte bounds enforced independently; overflow buffer capped; direct body reads bounded inside admission; existing teardown reused. Root corrected review's missing slow-consumer CORS headers and added cumulative-frame coverage. | Cloudflare and runtime host-client predicates, aggregate limits, direct response buffering and cancellation remain open. |
| P-137 Daytona identity | Removed supervisor overwrite of driver-owned host identity and unused sandbox-ID environment write. Boot environment agrees with returned target and persisted lease identity in tests. | Actual Daytona registration/routed request not run; duplicated target-env helpers still need consolidation. |
| P-6/P-22 launch and auth | Shell interpretation removed; descriptor URL policy hardened; HTTP/OAuth redirects refused. Real redirect probe sent no request to the redirect destination. | Actual Windows/WSL launch; persisted OAuth client discriminator; terminal output sanitizing, polling ceilings and WSL path edge cases. |
| P-74 runtime routes | Canonical bounded body reader reused, duplicate reader deleted, PTY/process identity comes from assigned runtime target rather than caller headers/environment. | Anonymous health diagnostics contract remains open. |
| Channel test isolation | Configured Vitest setup installs temporary data roots before imports, clears inherited leaf overrides, closes DB before cleanup; cloud fixture now declares required driver. | Earlier real-profile incident below; direct Bun runs do not execute this Vitest setup. |

## Root verification

Commands are run from the named package unless stated otherwise. Logs are local `/tmp` evidence and may disappear; the outcomes are recorded here durably.

| Package / command | Result | Log |
| --- | --- | --- |
| CLI: `bun test src` | 98 passed | `/tmp/claxedo-security-cli-wrapup-tests.log` |
| Root: `bun /tmp/claxedo-security-cli-redirect-wrapup.ts` | Real local 307 refused by both bearer and OAuth request owners; destination hits = 0; synthetic credentials only | `/tmp/claxedo-security-cli-redirect-wrapup.log` |
| Server: `node node_modules/vitest/vitest.mjs run src/hosts/workspace-runtime/runtime-boot.test.ts src/workspace/supervisor/cloud.test.ts` | 120 passed | `/tmp/claxedo-security-daytona-wrapup-tests.log` |
| Server: `node node_modules/vitest/vitest.mjs run src/billing/apply-polar-state.test.ts src/billing/routes.test.ts` | 35 passed | `/tmp/claxedo-security-billing-wrapup-tests.log` |
| Relay: `bun test src/bun.test.ts`, isolated CLAXEDO data/state under `/tmp/claxedo-security-wrapup-relay` | 106 passed before final review correction | `/tmp/claxedo-security-relay-wrapup-tests.log` |
| Relay: `bun test src/bun.test.ts -t 'slow consumer\|pre-open'`, same isolation | 6 passed; 101 filtered out | `/tmp/claxedo-security-relay-review-fixes.log` |
| Root: `bunx oxlint packages/workspace-relay/src/bun.ts packages/workspace-relay/src/bun.test.ts` | Zero warnings/errors | `/tmp/claxedo-security-relay-wrapup-lint.log` |
| Relay: `bun run typecheck` | Passed after review correction | `/tmp/claxedo-security-relay-wrapup-types.log` |
| Root: `bun run test:architecture-ratchets` | Passed; no ceiling/baseline increases | `/tmp/claxedo-security-wrapup-ratchets.log` |

An initial final-relay targeted invocation from the repository root was refused by the repository's `do-not-run-tests-from-root` guard; no tests ran. It was rerun from `packages/workspace-relay`. Earlier full runtime test validation had one unresolved notify-script failure that passed alone; do not call the full suite green or label the failure pre-existing without evidence.

Earlier accepted root verification remains in the revalidation document: P-125 79 store/integrity + 33 route/projection tests; P-74 107 runtime route/body/identity tests; channel isolation 64 tests and SQLite/D1 migrations 36; shutdown 11 focused and 33 live MCP/Tasks tests with successful teardown. Relevant package typechecks and scoped lint passed. SDK public API/store tests and built Node SQLite entrypoint passed, but publish verification still refuses 13 declaration baselines; publishing is not ready. The completed native Windows helper run passed 192 tests with 4 skipped, and its cloud lease was deleted. That does not establish native acceptance of every launch or secret-storage flow.

## Confirmed test-data incident

An earlier channel migration delegate ran tests against **`/Users/yashvardhansingh/.claxedo/claxedo.db`**. Its transcript confirms actual profile opens at 18:09:02, 18:09:57 and 18:14:25 UTC on September 20. `channels/access-store.test.ts` clears `claxedo_channel_pairing`, `claxedo_channel_allow` and `claxedo_channel_identity` before and after tests. Therefore the tests executed table-clearing hooks against the real database; this was not merely an additive schema change.

**Prior table contents are unknown.** No adjacent database backup was found during a filename/stat-only inspection. No guessed authorization rows were restored, and the database was not inspected or rewritten during wrap-up. The configured test harness has been corrected and verified with temporary roots, but that does not recover potentially lost prior pairing/allowlist/identity rows.

Evidence: `/Users/yashvardhansingh/.claude/projects/-Users-yashvardhansingh-test-opencode/27efef0d-3749-46ee-811e-755c76e794d5.jsonl`; isolation results `/tmp/claxedo-security-channel-isolation-final-root.log` and `/tmp/claxedo-security-channel-migration-isolated-root.log`. Recovery follow-up belongs to the root operator with the user: identify an authoritative pre-test backup if one exists, compare safely and recover only verified prior state. Never recreate approvals from guesses or copy stale authorization blindly.

## Larger work still open

- P-93: remote durable turn authority and recovery proof; local/embedded checks do not prove remote admission.
- P-64/P-85: out-of-process Git index races and remaining platform filesystem proof.
- H-1: privileged-process credential isolation.
- P-98: hosted revocation/refresh race; SQLite atomic behavior does not establish hosted KV behavior.
- P-27: already-issued channel runtime tokens lack provenance; new admission/renewal denial does not invalidate them immediately.
- P-74: public health diagnostics expose host data and need a reviewed consumer contract.
- P-22: replace display identity as persisted OAuth client discriminator across credential writers and refresh callers.
- Native Windows/WSL, signed packaged desktop and live Daytona acceptance remain incomplete.
- Full repository CI and SDK publish qualification remain incomplete.

Use the ranked tracker for the other findings. Resume by rechecking current source and dirty-tree ownership, selecting one bounded slice and proving its actual entrypoint. Do not launch the queued backlog automatically.

## Delegate disposition

The queue file is `/tmp/claxedo-security-delegate-queue/queue.json`. Its user-set `max_active_delegates: 50` remains untouched. Twenty assignment records were prepared; that does not mean twenty delegates ran. No scheduler is consuming this queue.

- Claude P-107, P-137 and P-119 implementations finished. Root reviewed the changes and ran the final checks above.
- CLI transport correction finished and was reviewed with real redirect verification.
- Devin P-107 review finished. It confirmed the three mechanisms, identified the small CORS defect and cumulative-frame coverage gap, both corrected by root. Cancellation/timeout observations remain open under the larger relay work.
- Devin P-125 review finished with no defects found. It verified the store and HTTP boundary and legitimate discovery flows. It did not rerun tests; root owns the 79 + 33 passing checks. Minor coverage gaps remain for some header aliases; source inspection found them using the same checked helper. Evidence: `/tmp/claxedo-security-workspace-id-devin-review.txt`.
- All three delegates that were running when wrap-up began have exited successfully. No delegate from this wrap-up remains running. Remaining queued implementations and dependent reviews were not started; dispatch is disabled. Unrelated agents from other tasks were left alone.

Final scoped `git diff --check` passed. The final relay correction changes no production imports; the passing aggregate architecture ratchets remain applicable. The queue retains the user's configured limit of 50 and has `dispatch_enabled: false`.
