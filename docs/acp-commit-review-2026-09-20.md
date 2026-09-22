# ACP commit review — 2026-09-20

## Scope and ownership

The commit on `codex/acp-connections-reviewed` isolates the scriptable ACP implementation from concurrent security, image-delivery, navigation, and native steering edits in the shared `dev` checkout. The implementation keeps protocol and process lifecycle ownership in `agent-sdk-runtime` and reuses canonical workspace session bindings, transcripts, permission events, questions, and the existing composer dock.

## Independent reviews

Claude Code reviewed the staged diff with `--model claude-opus-5`; Devin reviewed the production diff with `--model swe-2-high`. Both were supplied snapshots rather than a live provider acceptance environment. Their reports are review input, not proof that every concern is a defect.

Claude found concurrent capability discovery could boot the same probe twice and let one failure dispose the other caller's process. Discovery now shares one in-flight result per process, with success, failure, and replacement-process tests. Its follow-up confirmed the core fix. A hypothesized permanently rejected memo after successful boot was ruled out: successful boot already fills the discovery cache, and malformed discovery rejects during boot and disposes the process.

A further fix review repeated the rejected-promise concern and proposed a pusher race. Full-source checks found discovery boot disposes the probe on every rejection, and pusher capture/invocation has no intervening await (Promise executors run synchronously). Neither is a surviving bug. Other Claude concerns were checked against full code: authentication restart clears stored process bindings; production transport-retirement keys match; shipped workspace stores always supply startup ownership; managed session authorization denies unknown sessions; and the runtime supplies one shared interaction store. No reproduction established those reported defects. Permission migration transaction/reopen checks passed.

Devin's findings were checked against the full implementation:

- Exact ACP permission choices were missing from the producer and reply path. The fix projects offered options through the existing permission contract and validates exact option IDs before durable settlement.
- Unowned permission requests before an upstream session exists must cancel immediately. ACP permission requests do not carry the startup request correlation used by elicitation, so attributing them to a guessed creation would violate session isolation.
- Interrupted creation cannot stay at an unresolved status forever, but a bound session is also insufficient proof of completed setup. Recovery preserves the session and records an explicit failed start when completion cannot be established; it does not synthesize success or replay configuration.
- Cancellation incorrectly recorded an empty user answer. Cancelled/disconnected questions now use the existing rejection terminal event; actual answers retain the reply event.
- Explicit filesystem sharing is intentional: a stdio executable may forward to another host. Negotiated inline attachment delivery remains available; unsupported delivery fails before submission.
- The legacy `commands` capability means an implemented `executeCommand` operation. Advertised ACP slash commands use canonical session metadata and prompt submission instead. Fork and child visibility are negotiated per session; setting static unnegotiated capabilities true would misrepresent support.

Devin also reviewed the fix diff. Its follow-up claimed a deny/reject early return bypassed exact choice validation; the actual `respondPermission` implementation has no such branch. Every live pending decision goes through `answerAcpPermission`, then durable reply commit, then agent resolution. It repeated the rejected-discovery-promise concern already ruled out by unconditional probe disposal on boot failure. Neither follow-up claim reproduced against the full code.

## Verification

Final review fixes passed `bun run typecheck` in the SDK and workspace packages, the full ACP/shared SDK suite (260 tests, 982 assertions), and `bun test src/routes/session-core.test.ts` (87 tests, 339 assertions). Cancellation coverage independently passed 19 tests, 118 assertions. Root `bun run test:architecture-ratchets` and both package builds passed again after the fixes. Earlier checks on this isolated snapshot passed SDK and workspace compilers, client `bunx tsgo -b`, 58 focused client Vitest checks, architecture ratchets, and the full app and desktop closure builds. The published Node startup-question smoke passed malformed-answer, schema-validation, successful-answer, and session-creation paths.

The aggregate app typecheck remains blocked by existing architecture-debt limits. Comparison with HEAD found the same directory-string, module-state, untrack, and cast violations; this change also adds 2 and 11 lines to two files already above their size limits. No baseline was raised to conceal those failures. Workspace `verify:publish` remains blocked by eight pre-existing README export inventory omissions.

The earlier packaged Electron acceptance run exercised the native bottom dock, reload-preserved JSON answer, validation errors, successful submission, and exactly one explicit prompt send with no fatal/page/unhandled-rejection errors. That run used the shared checkout before the final review fixes; it is not a packaged execution of this isolated final snapshot. The final review fixes require the focused checks below, and external-provider startup elicitation remains unverified.

The SDK test command was `bun test src/harnesses/acp src/harnesses/shared/sdk-runtime-interactions.test.ts src/harnesses/shared/sdk-runtime-adapter.test.ts src/harnesses/shared/mcp-elicitation.test.ts`. Client verification used `bunx tsgo -b` and `bun run test:vitest` on session-question-dock, session-composer-region, draft-session-start, claxedo-events-cursor, and connections. Full closures used `bun run verify:closure` in app and desktop packages. The published Node smoke was rerun successfully after the final review fixes. The command was `node scripts/acp-question-package-smoke.mjs` in workspace-runtime.

An existing persistence limitation remains: remembered permission grants and reply journal records are separate store writes. A journal failure can retain an explicitly authorized always-grant while keeping the request pending; the agent resolver is never released before the reply event is durable. This review did not invent an unsafe reordered write path or a new storage abstraction.
