# ACP and Pi continuity follow-up

The four additional findings from the session-lifecycle review are implemented locally. This report covers ACP and Pi; it does not claim every harness or packaged desktop has passed acceptance.

## Behavior

- ACP keeps requested launch configuration separate from the launch that is actually running. Repeated pending changes remain deferred. Reverting to the running configuration cancels the pending restart, including while earlier notifications are draining.
- Native AIR child sessions own their lifetime through their explicit terminal updates. They use the host's background lifecycle mode so parent completion cannot release their leases. `AcpChildren` owns their translators and publishes child events through the session broker, during and between parent turns. The full runtime/store test proves transcript isolation, output across a follow-up turn, and lease release on the child's own completion.
- ACP refuses configuration replacement while an announced child remains live, before retiring the peer. Pending configuration can be retried after child completion or reverted so prompts continue on the existing peer. Explicit session close still retires the process. A replayed spawn for a completed child cannot reintroduce a blocker. A child that never emits a terminal can continue to block a requested replacement; no completion is invented.
- Foreign session IDs do not establish native-child identity. The title side-session waits for its queued updates before returning its text and removing its route. The workspace-restart corpus caught this distinction during development; its final comparison matches without changing the recording.
- Pi treats rejected model/thinking commands as configuration errors. A configuration rejection before prompt submission preserves the attached process and lets a corrected turn run. Timeouts, channel failures, and failures after submission retain the existing retirement behavior.

## Verification

Commands ran from the named owning package unless stated otherwise.

| Scope | Command | Result |
| --- | --- | --- |
| Harness ACP/Pi transport and ACP conformance | `bun test src/transports/acp src/transports/pi-rpc src/conformance/acp.test.ts src/conformance/acp-continuity.test.ts src/conformance/acp-lifecycle.test.ts src/conformance/acp-cancellation.test.ts src/conformance/acp-isolation.test.ts src/conformance/acp-permissions.test.ts src/conformance/acp-retirement.test.ts` | 370 passed. Two additional recovery cases added afterward passed in the final focused run below. |
| Final focused ACP regressions | `bun test src/conformance/acp-continuity.test.ts src/transports/acp/events.test.ts` | 17 passed, including immediate/deferred replacement refusal, reversion, completion recovery, queued title text and foreign-session isolation. |
| Real Pi conformance | `bun test src/conformance/pi.test.ts` | 78 passed, including real model requests, cancellation, process loss and corrected-effort retry. |
| Real Pi 0.99.1 rejection/recovery | `bun test src/conformance/pi.test.ts --test-name-pattern 'clamped effort\|unavailable model'` | 2 passed. The unavailable-model case was added after the full suite above. |
| Real Pi 0.99.0 rejection/recovery | `CLAXEDO_E2E_PI=min bun test src/conformance/pi.test.ts --test-name-pattern 'clamped effort\|unavailable model'` | 2 passed. |
| Session-core child lifetime and transcripts | `bun test src/host/acp-child-continuity.test.ts src/host/child-turn-lifecycle.test.ts src/host/child-routing.test.ts src/host/idle-child-turns.test.ts` | 19 passed. New test connects the actual ACP transport/wire to the runtime and SQLite store. |
| Custom ACP stack and wire | `CLAXEDO_E2E_PORT_RANGE=48500-48549 bun run corpus H16-custom-acp compare` | Flow passed; wire corpus matched. |
| Workspace ACP restart stack and wire | `CLAXEDO_E2E_PORT_RANGE=48500-48549 bun run corpus H21-workspace-acp-restart compare` | Flow passed; wire corpus matched after fixing title isolation. |
| Harness, session-core, workspace-runtime | `bun run typecheck` in each package | Passed. |
| Repository root | `bun run test:architecture-ratchets` | 26 tests passed; all six product closures, helpers and file-size checks passed. |
| Repository root | `git diff --check` | Passed. |

The original temporary audit reproductions were red before implementation. A concurrent heavy verification run hit the existing five-second timeout in the ACP draft-probe test and an architecture scan; the isolated reruns passed without increasing timeouts or weakening assertions. Restart tests that previously changed only a lease counter now change an actual launch projection, preserving their restart/failure assertions under the established no-op configuration contract.

## Remaining check and acceptance limits

`bun run check` in harness still fails six aggregate source budgets. Running the same checker on committed HEAD confirmed all six already exceeded their ceilings: profiles 654/600, ACP 3070/3014, Claude 3327/2969, Codex 3057/2793, Cursor 1865/1652, Pi 1397/864. This work adds approximately 38 ACP lines and four Pi lines; it does not make those aggregate budgets pass. No ceilings were raised. The other harness checks pass. Concurrent Codex edits in this shared checkout are outside this change.

The full all-harness wire corpus and packaged desktop were not rerun. ACP acceptance uses the real transport and runtime against protocol peers, not a live external vendor's AIR implementation. Provider prompt-cache hits are not measured. No user session or running application was restarted for these tests.
