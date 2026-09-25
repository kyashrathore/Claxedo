# Invariant map: packages/agent-event-runtime

Scope: `packages/agent-event-runtime/**/*.test.ts` under `/Users/yashvardhansingh/test/opencode-harness` (25 files, excluding node_modules and dist). Companion files: `event-runtime.tsv` (one row per case), `event-runtime-fixes.tsv` (one row per fix-subject commit touching the package).

## Case count vs row count

- Test cases: **285**
- TSV rows: **285**

The textual `test(`/`it(` count is 273; three files generate extra cases at runtime from loops, which is where the difference comes from:

- `tool-name-canonicalisation.test.ts`: 2 `test(` calls inside `for (const kase of CASES)` over 5 harnesses (claude, codex-app-server, cursor, pi, acp:example) → 10 cases, not 2.
- `claude/adapter.test.ts`: `for (const failed of [false, true])` wraps the task-notification test → 2 cases, not 1.
- `codex/adapter.test.ts`: two `for (const started of [false, true])` loops wrap three tests (`nonzero command completion`, `MCP application error`, `MCP rejection`) → 6 cases, not 3.

273 − 2 − 1 − 3 + 10 + 2 + 6 = 285. Every generated case has its own row, named with the resolved title (e.g. `codex-app-server mints only canonical tool names`, `(started=false)`).

## Counts per replacement class

| Replacement | Rows |
|---|---|
| TRANSLATOR-CORPUS | 181 |
| WIRE-CORPUS | 87 |
| KEEP | 14 |
| OBSOLETE | 3 |
| FLOW(n) | 0 |

No case needed `FLOW(n)` as its replacement: every assertion in this package is either an input-to-event or event-to-frame mapping the two corpora can pin, or a focused invariant listed under KEEP. Where a live flow exercises the same behavior end to end (permissions H3, questions H4, subagents H5, goals H6, titles H12, usage H13, attachments H11), the row's notes name the flow rather than replace the corpus row.

## KEEP list (14)

- `harnesses/codex/protocol-pin.test.ts` — *the protocol generator pins the Codex the sandbox runs*: cross-artifact version-consistency check; no flow or corpus can compare package.json against the sandbox Dockerfile.
- `harnesses/acp/event-translator.test.ts` — *does not write ACP diagnostics to console*: side-effect silence a corpus cannot observe.
- `harnesses/acp/event-translator.test.ts` — *does not leak ACP diagnostics across runtime instances*: shared-module state between two live translators is invisible to per-case corpus comparison and to a single-runtime flow.
- `projections/client-presentation/projection.test.ts` — *rolls back state when projection translation throws*: fault injection via a hostile event field; no recorded provider input produces it.
- `projections/client-presentation/projection.test.ts` — *returns projection snapshots that do not mutate after later tool updates*: mid-stream snapshot freeze, not an output.
- `projections/client-presentation/projection.test.ts` — *clones restored projection snapshots so projections are independent*: shared-snapshot aliasing is invisible to a flow.
- `core/runtime.test.ts` — *returns snapshots that do not mutate after later ingests*: same snapshot-freeze class.
- `core/runtime.test.ts` — *clones restored adapter snapshots so runtimes are independent*: same aliasing class.
- `core/runtime.test.ts` — *clones structured-clone-safe snapshot values*: Date/Map/BigInt/circular fidelity; no recorded input produces these deterministically.
- `core/runtime.test.ts` — *falls back to JSON-safe snapshot values when structured cloning fails*: fallback-path helper invariant.
- `core/runtime.test.ts` — *sanitizes JSON fallback values that would otherwise throw*: same helper.
- `core/runtime.test.ts` — *rejects older snapshot versions clearly*: needs a forged old-version snapshot.
- `core/runtime.test.ts` — *turns adapter throws into diagnostic events*: only a hostile adapter exercises the wrapper's catch; real translators emit diagnostics.
- `core/runtime.test.ts` — *documents default id factory restore boundary*: the per-runtime id counter reset is invisible to the wire corpus, which normalizes ids.

## UNCOVERED fixes (3 of 42)

- `13d32b8acc` fix(agent-event-runtime): the pi harness resolves from source like its siblings — `index.test.ts` asserts every documented subpath *except* `./harnesses/pi`, the exact hole the commit fixed. Suggested: add `./harnesses/pi` to the subpath import assertions.
- `33f933dcb6` fix(streams): round-6 review — the in-package change was `contracts/stream-heartbeat.ts`, whose focused test was deleted in `d74833544d`. Suggested: a contract test asserting both producers' cadences stay multiples of `EVENT_STREAM_HEARTBEAT_MS` under the reader's stall budget.
- `42bac669b6` fix(events): one liveness contract for every agent event stream — same deleted `stream-heartbeat.test.ts`. Suggested: pin the shared heartbeat/stall contract where the producers and reader can see it.

## Surprising findings

- **A fix was deliberately re-inverted.** `455ba55814` taught Codex/Cursor *not* to report a non-zero exit as a tool failure; `53ffff28c4` later flipped it back on both Codex paths and Cursor, and the current tests assert the newer verdict. Both commits appear in the fixes TSV for that reason.
- **Two matched commits are not fixes.** `156e7e0ab8` is a `feat` (matched via "fixes") and `bb1bab608e` is a `wip` checkpoint (matched via "review-fix"). Both are mapped anyway since the grep admits them.
- **The ACP subagent test was added and later deleted.** `f69bde5308` added `acp/subagent.test.ts`; `c8bb14606f` removed it when operator connections went generic, so ACP-side subagent coverage now relies on the generic paths only.
- **Pinned misses, not bugs.** The plan-mode projection intentionally documents two misses — Claude-over-ACP `ready` and Cursor `createplan` carry plan markdown but never reach the plan row, because the harness title wins over the real tool name. The wire corpus must preserve the miss, not fix it.
- **The dual adapter return convention is the only pure plumbing deleted.** `normalizes both adapter return conventions` and the two `index.test.ts` entrypoint/subpath rows are the sole OBSOLETE cases; everything else survives as corpus input or a focused test.
- **Security-hardening fixes need crafted corpus inputs, not recordings.** P-39/P-40/P-5 guards (reserved `__proto__`/`constructor` keys, bounded retained records, forged subagent bindings, wire-secret leaks) are classified TRANSLATOR-CORPUS/WIRE-CORPUS but the notes flag that the corpus must *construct* hostile inputs — no provider recording contains them.
