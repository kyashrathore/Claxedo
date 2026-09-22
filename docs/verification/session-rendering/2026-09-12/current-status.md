# Session rendering: current checks

Most of the evidence this record cites — recordings, screenshots, timing files and logs — was never committed. Those citations are written as plain paths; the few files that did land are under `evidence/` and stay linked.

Fresh runs on 2026-09-13 replace the old Claude-login and Pi-version blockers. The Pi session-file defect was fixed and the four journeys rerun on 2026-09-14; they now fail at the model request instead.

| Check | Result |
| --- | --- |
| Claude login and real CLI request | Logged in through claude.ai; real request returns `QA_CLAUDE_RECHECK_OK`. |
| Claude real-provider app journey | **2 passed, 0 failed:** one journey in each identity mode, each completing three real turns and reload. All eight reply screenshots reviewed. |
| Pi installed/runtime version | Both **0.85.1**. Executable tests: **3 passed, 0 failed**. The version mismatch is closed. |
| Pi missing session file | **Fixed** in [the Pi driver](../../../../packages/agent-sdk-runtime/src/harnesses/pi/driver.ts), commit `20fdb18874`: sessions created but not yet persisted (Pi writes its file at the first assistant message) are recreated via `--session-id` when their process is lost to per-request credential rotation; unknown ids still refuse. Regression test red→green in `driver.test.ts`; diagnosis in [pi-session-fix evidence](evidence/pi-session-fix/findings.md). |
| Pi native app tool flows | **0 passed, 4 failed** after the fix, in both identity modes — now at the **model request**: the brokered `openai` projection points at real `api.openai.com`, so the scripted endpoint is never reached and the page shows a real OpenAI 401 (`Incorrect API key provided: test-key`). No "session file is missing" appears anywhere. [Rerun evidence](evidence/pi-session-fix/findings.md). |

The next Pi action is a credential-delivery decision, not a driver fix: a `local_only`/`api_key` credential produces a brokered projection whose destination origin is hardcoded in `PROVIDER_ROWS`, so no scripted endpoint can serve a brokered provider. Options: a destination override on the credential row, or non-brokered delivery for local-only credentials. Owner: the credential-broker layer. Reinstalling Pi or asking for login remains irrelevant. Claude is available for further rendering tests through the verified native login path.

Both identity modes means `local-unsigned` and `test-user`. All browser runs used a fresh `build-preview` build and zero retries. Claude used the real provider; Pi used real app/server/runtime processes with scripted model HTTP, which was never reached. Videos were retained but not reviewed; this check makes no flicker or content-shift claim. These existing tests were run once per mode, not a three-repetition reliability qualification or the full rendering matrix.

## What remains in the report

- The repeated per-state setup rows, reconciliation report/ledger/checker and obsolete coverage-gap snapshot have been deleted.
- [The inventory](index.md) retains actual observed pass/fail outcomes. Untested scenarios belong in [the QA brief](../../../qa/2026-09-12-session-rendering-qa-brief.md), not in a multiplied blocker count.
- [The regression report](progress-report.md) and [handoff](WHATS-DONE-AND-NEXT.md) retain reproducible defects, useful tests and concrete next work. Other harnesses were not rerun in this targeted check.

## Commands and evidence

- CLI commands, sanitized results and Pi executable tests (evidence/prerequisite-rerun/prerequisites.json).
- Claude live: unsigned command (evidence/prerequisite-rerun/claude-command.json), result (evidence/prerequisite-rerun/claude-live.json); Test User command (evidence/prerequisite-rerun/claude-signed-command.json), result (evidence/prerequisite-rerun/claude-signed.json).
- Pi native (superseded — missing session file): unsigned command (evidence/prerequisite-rerun/pi-command.json), result (evidence/prerequisite-rerun/pi.json); Test User command (evidence/prerequisite-rerun/pi-signed-command.json), result (evidence/prerequisite-rerun/pi-signed.json).
- Pi native after the session-file fix: [findings](evidence/pi-session-fix/findings.md), [unsigned command](evidence/pi-session-fix/pi-unsigned-command.json) + [result](evidence/pi-session-fix/pi-unsigned.json), [Test User command](evidence/pi-session-fix/pi-test-user-command.json) + [result](evidence/pi-session-fix/pi-test-user.json).
- Six browser cases, retry counts and visual-review results (evidence/prerequisite-rerun/summary.json).

The Pi driver fix and its regression test are committed as `20fdb18874` (three explicit paths: `driver.ts`, `driver.test.ts`, `fake-pi-rpc.mjs`). `agent-sdk-runtime` typecheck and the focused driver/auth/runtime/goal-conformance suites pass; the app's production lint/architecture gates were not rerun for this slice.
