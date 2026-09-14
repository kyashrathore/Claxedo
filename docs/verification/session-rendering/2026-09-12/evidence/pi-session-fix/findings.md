# Pi missing session file: diagnosis, fix, and rerun

Date: 2026-09-14. Prior evidence: [prerequisite-rerun](../prerequisite-rerun/).

## Confirmed mechanism

Real Pi 0.85.1 writes `sessions/<ts>_<id>.jsonl` only when the first assistant
message lands (verified against the real binary: a fresh `--mode rpc` session has
no file; a header-only file resumes cleanly; `--session-id <id>` creates a session
with an exact id; `_persist` uses `openSync(file, "wx")` so pre-writing the file
is unsafe — a surviving original process would hit `EEXIST`).

Every mutating request (`POST /session`, `POST /session/:id/message`) runs the
embedded runtime's `"sync"` configure, which re-projects credentials.
`projectAuth` mints a fresh placeholder JWT on every call, so each apply carries
a different auth row → `runtimeSnapshotSignature` differs → the Pi driver's
`applyConfig` rotates `models.json` and calls `closeProcesses()`, which
synchronously clears the in-memory `entries` map and disposes the idle live
process. The next send's `ensure(id)` then found neither an entry nor a file and
threw `Pi session file is missing`.

Proven end-to-end against a real spawned server (`startRealLocalServer` +
`startScriptedModelServer`): `POST /session` → 201, wait ~2.5s so the second
configure runs a separate apply, `POST /session/:id/message` → 200 with
`"Pi session file is missing for <native-id>"` in `info.error`, `models.json`
rewritten between the two calls.

## Fix

Committed as `20fdb18874` (driver + test + fake) with the decision-register
update in `7bcda14abf`.

`packages/agent-sdk-runtime/src/harnesses/pi/driver.ts`: the driver now tracks
the session ids it created but has never seen persisted (`unpersisted`). When
`ensure` misses both the live entry and the session file, only those ids are
recreated via `pi --session-id <id>`; any other unknown id still throws. The set
is emptied when a file is observed (ensure resume hit, idle reap) and on
`deleteAgentSession`. `test-utils/fake-pi-rpc.mjs` now defers its file write to
the first assistant message like real Pi and accepts `--session-id`.

Regression test: `driver.test.ts` "a rotation before the first turn recreates
the session instead of losing it" — red before the fix ("Pi session file is
missing"), green after. The pre-existing guard "missing native file fails
without creating a replacement session" still passes (a fresh adapter has no
created ids).

Verification: `bun test src/harnesses/pi/driver.test.ts` 13/13;
`src/harnesses/pi/auth.test.ts src/runtime.test.ts src/harnesses/goal-conformance.test.ts`
84/84; `bun run typecheck` clean in `agent-sdk-runtime`; `bun test src/server.test.ts`
in `workspace-runtime` 47/47. The same real-server repro now reaches the model
request instead of the session-file error.

Pre-existing (not caused by this change): `pi-native.node-test.ts` second case
fails identically with and without the fix — `runtime.host.apply({auth: {}})`
writes `{providers: {}}` over the test's `models.json`, so the custom `proof`
provider is gone and `pi --model proof/proof` exits 1.

## Rerun of the four failing journeys

Same spec, both identity modes, `build-preview`, zero retries, one run per mode
(not a reliability qualification). Result: **0 passed, 4 failed** — but the
failure is no longer the session file. The turn now reaches a model request and
the page shows:

> Incorrect API key provided: test-key. You can find your API key at
> https://platform.openai.com/account/api-keys.

New blocker, different layer: the seeded `openai`/`local_only`/`test-key`
credential produces a brokered projection whose `ProviderDestination` origin is
hardcoded to `https://api.openai.com` (`PROVIDER_ROWS` in
`packages/claxedo-server-core/src/credentials/destinations.ts`). Pi's
`models.json` points at the loopback broker, which forwards to real
`api.openai.com` — the scripted model endpoint can never serve brokered
providers, so Tier R Pi journeys cannot reach their scripted replies. Options:
a destination override on the credential for test/local rows, or `local_only`
delivery without brokering. That is a credential-delivery design decision owned
by the broker layer, not the Pi driver.

## Evidence

- [unsigned command](pi-unsigned-command.json) → [result](pi-unsigned.json),
  [artifacts](pi-unsigned-artifacts/) (videos, traces, screenshots, server log)
- [test-user command](pi-test-user-command.json) → [result](pi-test-user.json),
  [artifacts](pi-test-user-artifacts/)

Both error-context.md files contain the OpenAI 401 text and neither contains
"session file is missing".
