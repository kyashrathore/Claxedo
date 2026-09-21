# Security audit revalidation — 20 September 2026

All **161 findings** in [the original report](security-audit-findings-2026-09-19.md) are assessed below. Some remain serious, some were fixed or replaced, and several original severity labels assume an exploit that the evidence does not establish. This is a current-source review with targeted tests, not a claim that 161 live attacks were reproduced.

Reviewed revision: `e06522f6e6092f90c549815edb33b37264759b20`. Implementation inspection began at `342e26247e`; the intervening commit changes only three public documentation files. Existing working-tree artifacts were left alone. The initial review proposed fixes. The remediation updates below track subsequent working-tree changes and their verification; rows without an update retain their initial review status.

## Remediation progress

Wrap-up requested on September 21 to conserve usage. No new assignments are being dispatched. See [the handoff](security-audit-handoff-2026-09-21.md) for final checks, remaining work and the test-data incident.

The full 161-finding scope remains active. The current table records **32 fixed with focused verification, 20 already resolved/consolidated or not established as originally claimed, and 109 open**. Of the open findings, 35 are partial or await acceptance and 74 need investigation, fixes or hardening. These are tracker categories, not a fresh retest of every finding. Overlapping findings share fixes; resolved or unsubstantiated claims still need appropriate regression evidence rather than duplicate implementations.

- **P-81 implemented and focused checks passed:** self-hosted machine plugin reads and writes use one operator gate after browser authentication. The existing plugin composition and materializer remain the only implementation. `CLAXEDO_OPERATOR_SUBJECTS` configures stable signed subjects; empty configuration denies access. Real embedded sign-in, unrelated users, malformed unauthenticated requests, nonexecuting plugin installation, signed runtime apply/withdraw, removal of operator configuration, loopback peer checks and misconfigured auth are covered by `app.plugin-authorization.test.ts` and `operator.test.ts` (12 passing tests). This exercises the mounted app; no external production deployment was tested.
- **P-94 implemented and focused checks passed:** register/checkpoint/repair bind runtime credentials to the route workspace before caches or fetches. Pulls reject stored sessions belonging to another workspace. The shared deployment token override was removed; the supervisor generates a distinct credential per workspace. `session-pull-authorization.test.ts` has 12 passing isolation/positive-flow tests, including runtime callbacks in both signed and local deployments. Runtime mutations always require the workspace credential. The HTTP protocol and isolation suites passed (42 tests); the cloud supervisor suite passed (81 tests). Earlier projection and durable-idempotency checks also passed.
- **P-4 implemented and focused checks passed:** the channel registry resolves Telegram credentials once and passes them explicitly to the real adapter. Enabled registrations missing either credential are refused before adapter construction. The redundant server warning-only configuration reader is deleted. All 179 channels tests passed, including real-adapter secret verification and a conflicting ambient bot token; package typecheck/lint passed. The server channel ingress suite passed (21 tests).
- **P-88 implemented and focused checks passed:** the shared operator authorizer protects both `/remote-access/enable` and the remote-access service, including implicit enrollment through workspace sharing. Tests use the real SQLite authority and verify denial before enrollment, after operator enrollment, and after revocation; authorized re-enrollment succeeds. Unassignment keeps the enrolled operator identity, and enable/revoke share the existing lifecycle serializer. Regression tests cover an unrelated workspace admin, concurrent enables and revoke racing a heartbeat. The service suite passed (22 tests), the self-hosted/remote-access suites passed (167 tests), and workspace routes passed (85 tests).
- **P-17 implemented and focused checks passed:** expiry is enforced atomically for approval/event admission and timed claims. Approval resolution reports `too_late` at the deadline. Scoped lanes terminate expired rows and release live-wake budgets. The canonical store computes the next obligation; hosted alarms re-arm after earlier work instead of losing a later deadline. Wakes passed 60 tests and both typechecks; hosted-lane/machine-consumer tests passed (19 tests). Already-admitted delivery retains at-least-once retries after the deadline. Real Cloudflare deployment behavior remains unverified; poison-wake parking and the absent hosted cron backstop remain documented limitations.
- **P-59 implemented and focused checks passed:** machine folder imports require the existing operator policy; project list/read/update use a single shared authority helper across both route families. Signed creation refuses missing authority or registration before filesystem/clone writes. Local-server platform/shell/workspace/architecture checks passed (152 tests), and mounted self-hosted tests passed (158 tests). The affected full local-server closure verification passed before its exact one-module ceiling update. Nine unrelated local-server tests still fail in four files, reproduced without this slice's changes; the full package is not green.
- **P-60/P-86 implemented and focused checks passed:** provisioning is the only writer of provider identity; runtime telemetry carries health/activity and a required epoch. Memory, SQLite and D1 stores share canonical merge rules. D1 writes only the fields owned by each operation, so a delayed liveness write cannot restore old provider identity. Conditional state checks prevent delayed heartbeats or provisioning results from reviving stopped/destroyed leases. Fake-provider A/B isolation, HTTP credential checks, store races and lifecycle tests pass; the focused manager suite passed (46 tests), D1 passed (15 tests), and server typecheck passed. A real provider snapshot/destruction chain is not yet verified.
- **P-116 implemented and focused checks passed:** management JWKS endpoints require HTTPS without URL credentials or fragments; jose's redirect refusal is covered by a real verifier test. Local Docker now receives the same pinned public key as other local-managed runtimes. Management/config/owner-grant/environment tests passed (29 tests) and cloud supervisor tests passed (81 tests), including the Docker producer. No real remote TLS service was required for these checks.
- **P-20 implemented and focused checks passed:** HTTP introspection pins a validated HTTPS endpoint, with an explicit exact-loopback development option; URL credentials/fragments and redirects are refused. Returned claims are checked for subject binding and current issued/expiry/not-before times. The protocol package passed all 40 tests and typecheck; a real HTTP 307 test proved no bearer reaches the redirect destination.
- **P-85 partially implemented:** every diff/status working-tree read uses one canonical secure reader. Symlinks are represented as links, final-component replacement is checked, and Linux verifies the opened descriptor through `/proc/self/fd`. Focused runtime tests passed (180 tests, one Linux-only test skipped on macOS). Parent-directory replacement between validation and open remains unresolved on macOS/Windows; this finding stays open. The Linux umbrella stopped before tests on 1,288 existing broken documentation links and five dead code paths. The focused Linux filesystem lane passed 39 tests with one platform-specific skip, including the parent-swap regression. Windows initially failed before tests because the dependency patcher used an overlong Git metadata path; the patcher now uses a short temporary sentinel, its three focused tests pass, and Windows passed that setup step. The next run stopped at the missing bunx alias before unit tests; bootstrap now invokes Bun's own alias installer. The third run reached tests and failed on six helper permission/signal assertions; its lease was deleted. See the native Windows investigation below. The first ad-hoc Linux probe lacked Bun; it was replaced by the canonical bootstrap-backed `focus-workspace-files-linux-aws` job.
- **P-82 implemented and focused checks passed:** runtime and embedded proxy share one authorized PTY connection owner. Admission precedes scrollback, output checks the current read deadline, and queued input requires a live write lease. Missing, expired and nonfinite lease deadlines are refused. Runtime/public-API checks passed (50 tests); embedded/proxy checks passed (34 tests), including real socket read-only and revocation flows. Packaged macOS validation is blocked by missing Crabbox `static.host` configuration.
- **P-87 implemented and focused checks passed:** create/fork consult the canonical reservation authority before touching a reserved identity. Existing child sessions require session-scoped access; denied requests cannot change the adapter model. Root create/child-route regressions passed (122 tests). Configuration rollback preserves pre-existing sessions, and synchronous creation claims prevent two requests from starting the same id. Real two-user SQLite authority acceptance checks and retry/concurrency regressions pass; the embedded runtime suite now passes all 25 tests.
- **P-57 implemented and focused checks passed:** reset/delete require both a same-project registered local workspace and an exact Git worktree row. Primary checkout aliases, ordinary descendants, `.git`, and registrations missing either authority are refused. The recursive filesystem deletion fallback is removed. All 18 shell/worktree tests passed; the mounted outsider regression verifies denial and preserved files.
- **P-3 implemented and focused checks passed:** one canonical URL validator runs before host persistence, invitation redemption and transport construction. Non-loopback cleartext endpoints and redirects are refused. Connector tests passed (214), CLI tests passed without a resolver shim (83), and desktop connector tests passed (117); connector build/typecheck/closure verification passed.
- **P-98 partially implemented:** SQLite credential health/secret updates preserve revocation in the SQL write itself, including revocation while a refresh or backend write is in flight. The real registry/check/verification suites passed (105 tests), typecheck and focused lint passed. Explicit status restoration remains a separate operation. The hosted KV adapter still rewrites whole records without atomic lifecycle fencing and requires a separate authoritative solution; this finding remains open.
- **H-2 implemented and focused checks passed:** Cloudflare Worker endpoint validation lives in sandbox-contract and is reused by credential entry, config/environment decoding, managed-secret decoding, verification and the driver. HTTPS without URL credentials/query/fragment is required; verification and driver requests refuse redirects. Server transport/credential tests passed (74), Cloudflare driver tests passed (30), and contract tests passed (10). Affected typechecks, focused lint and architecture ratchets passed.
- **P-131 implemented and focused checks passed:** daemon and self-hosted document Git share one adapter onto the canonical safe bounded Git runner. Shell Git and project clones use the same owner; clone credentials enter through a host-bound typed option, and callers cannot inject arbitrary environment/config names. Worktree startup shells also use the shared safe environment. Real helper/commit/clone and shell environment checks pass; the focused local integration covered 44 tests, with the six-test shell suite rerun green after correcting a test assertion on the nonsensitive value `1`. Both affected full product closure verifications passed without ceiling changes. Existing unrelated session-start failures keep the complete package suites red.
- **P-91 and P-111 implemented and verified:** checkpoint control requires current admin/owner authority or the scoped supervisor management grant. The embedded policy now calls the canonical workspace actor resolver with an explicit minimum role; SQLite and D1 recheck stored membership. Embedded workspace streams receive signed, actor/org/workspace-bound leases. Missing, expired, non-finite and malformed leases cannot extend stream access; stalled renewals stop delivery at expiry. Real SQLite integration verifies all five checkpoint HTTP mutations reject a stale admin token after downgrade, and an already-open SSE stream stops sessionless frames after membership revocation. Runtime stream/checkpoint checks passed (76 tests), server/D1 checks passed (82 tests), and the final four-test embedded HTTP/SSE integration passed. Server/runtime typechecks, focused lint and architecture ratchets passed.
- **P-60/P-86 supervisor integration verified:** manager and supervisor callbacks now call one provider-independent snapshot owner with explicit caller retry policy. Attach publishes only after the health probe and config push pass the lease fence; stop waits for an in-flight start, and the final stop write cannot overwrite a replacement epoch. Sandbox-manager passed 258 tests and typecheck/build; root's combined supervisor/workspace-route run passed 196 tests. Full-server acceptance remains unproven; an earlier broad run had incompletely captured failures.
- **Windows verification update:** the third Windows job passed dependency/bootstrap setup and reached unit tests, then stopped with six helper failures: five Unix permission-mode assertions and one Unix signal assertion. The job deleted its cloud lease. Windows effective ACL protection requires native evidence; a numeric `stat.mode` mismatch alone does not establish exposure. The native credential-storage investigation is explicitly flagged as beyond a small fix.
- **P-10 implemented and verified through MCP HTTP:** the shared tool registry refuses destructive calls without elicitation support, and invokes the handler only after an accepted result. Missing, cancelled, declined and failed confirmation produce no downstream compute/session mutation or fabricated approval. The full MCP package passed 190 tests over its real HTTP/SDK fixtures, typecheck and focused lint passed. Accepted session deletion, lifecycle and restore still work; existing access scopes remain required.
- **P-130 implemented and verified through Bun WebSockets:** the socket expiry watcher caps each timer at the signed 32-bit limit, then checks the signed deadline again before closing or rescheduling. A real socket with a 30-day token stays usable across an injected timer wake and closes exactly at expiry. All 101 Bun adapter tests passed; the final clock-test harness also passed independently, and package typecheck/lint passed. The token lifetime itself is unchanged.
- **P-21 implemented and focused checks passed:** channel status/reset commands run after the same authorization hook as other session operations. The signed server reuses `MachineSessionDispatch.authorize` for the stored private session before revealing its binding or attempting reset. Reset preserves the binding if runtime abort is denied or fails. All 182 channel-package tests and 31 ingress/dispatcher integration tests passed, covering two workspace-authorized senders, denied status/reset, current private-session authority, positive owner reset and cancellation failure. Both package typechecks and focused lint passed.
- **Daemon boundary implemented; packaged acceptance open:** capability admission covers privileged local routes; blank configured tokens fail composition. Electron main pins requests to the daemon and strips the capability before any other destination. Five real bundled-daemon tests and 16 real Electron boundary tests passed, including HTTP, WebSockets, file-origin handling, untrusted frames/guests, navigation and redirect denial. The capability is not delivered to renderer JavaScript. Full affected product closure verification and architecture ratchets passed. Signed packaged macOS and native CI portability remain unverified; S-1/P-84 remain partial for that acceptance.
- **P-90 implemented and verified through the service and mounted app:** the service applies operator and canonical workspace admission before enrollment or serving effects; its route-level heuristic is removed. Actual assignment reuses the same authorization owner. Real SQLite service tests cover revoked membership, an existing row with no resolvable owner, non-operators and positive cold sharing. The signed mounted app refuses a foreign workspace with zero enrollment, assignment and request rows. Delegate runs passed 397 self-hosted/route/tunnel/billing tests, 493 authority/task tests, 146 hosted/D1 tests and 254 core tests. Typed SQLite/D1 conflicts now retain their HTTP statuses; typechecks and architecture ratchets passed.
- **P-103 implemented and verified through broker HTTP:** installation routes select their required operation, carry the verified job identity into document lookup/write attribution, reject a mismatched body session, and filter indexes by document/project/local-workspace scope. The unused local-relay `resolve` request arm is removed; conflict resolution retains its separate runtime operation. All 259 server document tests and three runtime broker tests passed, including read-token PUT denial with a matching version, write-token GET denial, scoped index results, forged attribution, positive writes and real relay roundtrips. Server/runtime typechecks and focused lint passed.
- **P-104 implemented and verified through document HTTP and writeback:** the local backend calls the existing private-session authority before hydration and again before each writeback. Self-hosted and local-daemon composition inject the same authority. Real SQLite tests deny another user's same-project private session, allow the caller's own session and a granted participant, and preserve canonical document content after participant revocation. Missing signed authority fails closed. All 261 document tests, both server/local-server typechecks, focused lint and architecture ratchets passed.
- **P-16 implemented and verified through task HTTP:** the shared array reader applies existing plugin, skill and attachment count limits before decoding elements, and the canonical field collector retains at most 64 diagnostics. Oversized arrays are rejected whole rather than truncated into valid input. Getter regressions prove elements are not touched; real HTTP requests below the byte cap return bounded errors without storing a preset. Valid arrays at the contract limits are preserved. All 245 task tests, typecheck, focused lint, scoped diff checks and architecture ratchets passed.
- **P-92 parent admission implemented; wake delivery remains open:** child creation asks the existing parent prompt authority before provider effects. SQLite and D1 require parent turn access at reservation, recheck before startup and registration, and D1 repeats the predicate in its atomic writes. Shared conformance proves a workspace editor with a follow-only share is refused, a send share succeeds, revocation after reservation blocks startup/registration, and restoring the grant permits registration. Real D1 interleaving tests downgrade the share immediately before reservation/registration batches and prove no child is published. SQLite passed 12 tests, the full D1 suite passed 16 tests, and runtime child/core routes passed 137 tests. Core/server/runtime typechecks, eight-file lint and scoped diff checks passed. Embedded wake delivery now persists the original actor and reacquires turn admission; remote durable proof remains open under P-93.
- **P-133 implemented and focused checks passed:** runtime document activation and conflict resolution authorize the caller through the mounted session access policy before the stored document job is consulted, classified by a new `document_write` session-control operation. The composed relay mount passes the routes the same `sessionAccessPolicy` every other session surface uses. Mounted relay tests prove a caller the session authority refuses cannot activate or resolve — even with a fresh valid capability — the document stays pending, and the authorized caller still hydrates, activates and resolves. The hosted documents integration exercises activation through the real remote session policy. Focused runtime tests passed (79 tests), server document integration passed (3 tests), focused lint and architecture ratchets passed; the package typecheck reports only pre-existing errors in unrelated modified files.
- **P-11 and P-105 implemented; focused entrypoint checks passed:** runtime send/abort and question reply share the stored-parent/session reach guard. Runtime self/child authority is anchored to its own workspace, including colliding IDs and foreign rows claiming the caller as parent. Local Tasks carries an opaque per-session grant through the same capability authentication, project confinement and agent-start gates as signed Tasks. Unknown, malformed, previous-process and disabled handles cannot become the unsigned machine person. Root ran 33 live MCP/composition tests with the configured Vitest runner and 38 session/attention tests; the delegate also verified package types and architecture ratchets. The six adoption failures were invalid fixture connection IDs and the abandoned-session retry retained a deleted session's startup owner. The exact two files now pass all 29 tests after those corrections. Full-package acceptance remains open. The combined MCP/Tasks shutdown failure is now corrected and its latest root run passes all 33 tests with successful teardown, as detailed below.
- **Durable turn lease hardening verified:** malformed leases (including non-finite dates, invalid fences and empty proof), invalid renewals, synchronous renewal/cleanup failures, and renewals arriving after the local deadline cannot retain or revive execution. Root lease/prompt-delivery/durable-queue suite: 42 passed; runtime typecheck and two-file lint passed. This hardens the existing lease controller; it does not close P-93 background identity/proof.
- **Embedded P-93 wake admission and teardown verified:** child origins persist once in the canonical runtime store and are read again during recovery. Managed host turns require actor, workspace authority and message identity before provider effects, acquire the existing durable lease, and refuse adapter-only execution that cannot enforce its fence. Root reproduced and fixed a lease leak on provider setup failure. Root ran 92 child/queue/lease checks and 15 real SQLite authority tests, including actual store reopen, revoked parent share and transcript producer attribution. Event source closure now cancels queued decisions before resolving ownership against disposed state; 69 event/stream tests and 145 wider runtime tests passed, with no closed-database errors. Runtime typecheck, focused lint and scoped diff checks passed. Remote proof and complete platform acceptance remain open.
- **P-61/P-77/P-89 implemented and verified through tunnel entrypoints:** the machine-root compatibility branch is removed. Workspace tunnels refuse configuration, provider-account and project-inventory families before loopback replay; legitimate local account management still succeeds. The daemon capability gate already denied the former root routes, so credential overwrite was not reproduced against the current composed daemon. Root then reproduced four path-normalization escapes: admission inspected a resolved path but construction appended raw dot segments. The tunnel client's common HTTP/WebSocket target owner now resolves the path first; desktop and server composers bind that same path to the authorized workspace. Root ran 64 surface/serving tests, 9 actual WebSocket-tunnel/daemon tests plus 6 adoption tests, 41 runtime relay tests and 9 server tunnel tests. Malformed URL frames are refused without throwing out of the WebSocket handler; a following valid frame still succeeds. The relay attack frames are injected by a real WebSocket stand-in; the normal real-relay HTTP/file/PTY flows also pass. Signature verification in the daemon integration is an explicit fixture seam, not a deployed JWKS acceptance claim.
- **Session-start retry and deletion interlock:** explicit successful deletion now retires the matching durable creation owner with a field-wise SQL CAS; provider or metadata failure preserves it, and creation rollback keeps its failure status. Root reproduced and closed two additional races by extending the existing session identity claim across creation, deletion and child cascades; child creation also holds its parent against deletion. Root ran 98 session-core tests, 21 memory/SQLite store tests and the exact 29 formerly failing local-server tests. Local claims assume the existing single runtime owner; cross-process session takeover and recovery of a start that died before provider binding remain separate unresolved contracts. Runtime and SDK typechecks, focused lint and architecture ratchets passed without ceiling changes. Background provenance changes have their own verification below.
- **Windows native run 7 passed:** `focus-helpers-windows` finished with 192 pass, 4 intentional platform skips and no failures; lease `cbx_3506c0cf4bac` was deleted and the refreshed lease list was empty. Native tests prove owner-only creation before bytes, hostile-handle refusal, retained file identity through publication, replacement of a permissive target, cancellation and force-kill cleanup while deletion is armed, unrelated-account denial with a permissive-file control, and the built helper under Node. Root also caught zero-exit without publication; the helper now requires publication acknowledgement. Its ending-decision regression runs on Windows, but an actual truncated transport is not separately proven. Power-loss cleanup and a crash after deletion is disarmed remain outside the guarantee; timeout after sending a complete payload can race publication. The credentials.json and encrypted credential ciphertext writers now use this owner. Root verified the ciphertext change with 13 backend-registry tests, server-core typecheck and focused lint; the latest root architecture check now passes after the Windows converter remained in its existing owner, keeping desktop-main composition at 93 modules without a ceiling increase. Create-once seed and broker keys, and other secret writers, remain open. The native helper result is not native acceptance of every backend. Run 6's 183/4/3 result is superseded, and its lease was also deleted.
- **Local P-93 provenance and focused shutdown acceptance verified:** local and relayed requests persist explicit trusted provenance with child origins and queued deliveries. Relayed work reuses its original actor and fresh lease; local work rechecks canonical local policy. Legacy actor rows cannot be overwritten or treated as local. Root ran 99 child/queue/lease checks, 89 actual Node SQLite store checks and 15 embedded authority tests. Shutdown rejects late admissions before provider acquisition and ignores callbacks after child-host disposal. The teardown deadlock was an event read waiting for a host that had not yet been asked to close. Runtime close now starts pump cancellation, closes the host, then awaits the pump and iterator cleanup, including on host-close failure. Root's final 11 shutdown/event-pump tests and combined 33 live MCP/Tasks tests pass with successful teardown; runtime typecheck and focused lint pass. Remote durable proof remains open. These focused runs do not establish full-package or platform acceptance.
- **P-125 fixed through the canonical store and HTTP routes:** explicit missing IDs no longer select a workspace by directory or project, even with create=true. Root ran 79 store/integrity tests and 33 metadata/resolve/projection tests, both package typechecks, focused lint and scoped diff checks. No replacement lookup owner was added.
- **Channel migration acceptance remains open:** versioned SQLite/D1 identity rows and stable-ID seed configuration are implemented; legacy rows no longer authorize fresh admission. The delegate reports 211 authority/channel tests, 201 transport tests and schema/closure checks passing. Already-minted runtime access tokens have no channel provenance and remain active until expiry; renewal and new channel admission are refused. A separate migration policy is required before claiming complete invalidation. The delegate also reported its server channel suite used the real ~/.claxedo/claxedo.db. The access-store fixture clears all three channel tables before and after tests, so potential loss of prior pairing/allowlist/identity data must not be described as only an additive migration. Root confirmed real-profile openings in the delegate execution log at 18:09:02, 18:09:57 and 18:14:25 UTC on September 20. Prior table contents are unknown; no adjacent database backup was found and no guessed restoration has been attempted. The configured test harness is now isolated before imports; root verified 64 channel/isolation/database/store tests with temporary paths and 36 isolated SQLite/D1 migration tests.
- **P-74 bounded readers consolidated:** root removed the duplicate document byte reader/error class and closed PTY header/environment identity forgery using the runtime target. All 107 focused runtime/document/identity tests, typecheck, lint and architecture ratchets pass. Public health diagnostics remain open.
- **SDK API correction verified:** the canonical session-start store is exposed through `@claxedo/agent-sdk-runtime/stores/session-start`; consumers depend on `AgentSessionStarts`, not its implementation class. The unused regex evaluator is internal. The new entrypoint, build, docs and reviewed value-export manifest agree; 25 API/store tests, actual built Node SQLite use, runtime typecheck, focused lint and architecture ratchets pass. Thirteen existing declaration closures still require review before publication.
- **Connection provider identity aligned:** the provider registry applies the existing canonical ACP connection-ID validator before registration. Invalid descriptors can no longer be accepted and then disappear when persisted harness configuration is decoded. Ten registry tests and eleven mounted connection/adoption tests pass. Execution binding identifiers remain governed by their separate contract; no replacement IDs are synthesized.
- **P-117 implemented and focused checks passed:** `route-inventory.guard.test.ts` composes the real `createWorkspaceRuntimeApp` at the relay boundary with every conditional mount and enumerates `app.routes`. Each mounted route must classify as a manifest family or a declared additional mount; every manifest family must be mounted. Anonymous requests are refused at all ~120 enumerated entrypoints, a foreign-workspace relay token is refused at each, a correctly scoped token reaches real handlers, and the config/checkpoint management channel refuses relay-only and wrong management tokens. `GET /global/health` is declared as the deliberate pre-auth liveness mount. The 5 inventory tests, 30 route-inventory/http tests and 54 server/public-api tests passed; scoped `bunx oxlint` clean. Package typecheck fails only in unrelated modified files (`routes/session-core.ts`, `routes/pty.ts`); the touched files produce no errors. No production imports changed.
- **In progress:** signed packaged and native CI acceptance for S-1/P-84, private-worktree confinement, parent wake authority, and Windows credential protection. Electron CI now handles Linux display setup and asserts production sandbox preferences; native Linux/Windows execution is still pending. The Windows protect-after-create implementation is rejected: a hostile handle opened before the ACL change retains its access, and Node permits staging-path replacement. The fix must create the private descriptor atomically and retain file identity through publication; static post-write ACL tests are insufficient. Claude Opus-5 implements bounded slices; root reviews and integrates them. Root rejected the first P-64 pass after a real mounted request staged a nested private file by naming its ancestor directory (204). P-64 now closes ancestor recursion, literal pathspec expansion, whitespace mismatches (including exact filenames beginning with spaces), and co-located owner filtering. Root reproduced each bypass before correction; 71 file/diff/Git/target tests now pass. A process-local Git lock and index recheck do not close an out-of-process index change immediately before commit, so P-64 remains partial rather than complete. P-93 embedded identity persistence is verified; remote recovery requires a separate scoped proof contract. Windows run 7 is green as recorded above; the remaining secret writers and remote wake proof are open; focused local shutdown acceptance now passes. Remaining rows retain their earlier assessment until explicitly updated.

Representative verification commands: server `node node_modules/vitest/vitest.mjs run src/authority/http/index.test.ts src/authority/http/session-pull-authorization.test.ts src/sandbox/stores/d1.test.ts`; sandbox-manager `node node_modules/vitest/vitest.mjs run src/manager.test.ts`; workspace-runtime `bun test src/management-auth.test.ts src/routes/config-auth.test.ts src/owner-grant.test.ts src/workspace-relay-env.test.ts`; package typechecks and root `bun run test:architecture-ratchets` passed. The former exploit scratch test is now `app.workspace-isolation.test.ts`, checks denial and preserved data, cleans up its app/databases/environment, and passes. These are focused checks, not completion of the full audit or platform matrix.

Latest root verification commands (run from the named package):

- `claxedo-local-server`: `node node_modules/vitest/vitest.mjs run src/tasks/session-bridge.test.ts src/app/desktop-session-adoption.test.ts` — 29 passed; `node node_modules/vitest/vitest.mjs run src/app/tunnel-credential-scope.test.ts src/app/desktop-session-adoption.test.ts` — 15 passed.
- `workspace-runtime`: `bun test src/routes/session-core.test.ts` — 98 passed; `agent-sdk-runtime`: `bun test src/stores` — 21 passed. Both package typechecks passed. The source-level public API mismatch is corrected: session-start persistence has a dedicated storage entrypoint, its implementation class and unused regex evaluator are removed from the root, and the shared title helpers are documented. The combined API/store suite passes 25 tests, package build passes, and the built session-start entrypoint passes actual Node SQLite creation/reopen/conditional-retirement checks. Publish verification still refuses 13 changed declaration baselines in the shared tree; those existing baselines were not blindly regenerated.
- `workspace-runtime`: `bun test src/workspace-relay-host-tunnel.test.ts src/workspace-relay-e2e.test.ts` — 41 passed. The fixture still prints its bounded relay-server teardown warning; the tests exit successfully. `claxedo-server`: `node node_modules/vitest/vitest.mjs run src/host-tunnel.test.ts src/host-tunnel.e2e.test.ts` — 9 passed. `claxedo-host-serving`: `node node_modules/vitest/vitest.mjs run src/surface.test.ts src/serving.test.ts` — 64 passed.
- Repository root: `bun run test:architecture-ratchets` — passed, no ceiling increases; scoped five-file `npx oxlint` — zero warnings/errors.

- `workspace-runtime`: `bun test src/routes/session-children.routes.test.ts src/routes/session-children.test.ts src/routes/session-prompt-delivery.test.ts src/routes/session-turn-lease.test.ts src/session/delivery-owner.test.ts` — 99 passed, including setup-failure lease cleanup, admission racing disposal and late child callbacks.
- `workspace-runtime`: `node --import ./src/text-imports.mjs --import tsx --test src/store.test.ts` — 89 passed using the configured text and TypeScript loaders.
- `claxedo-local-server`: `node node_modules/vitest/vitest.mjs run src/app/first-party-mcp-subagents.live.test.ts src/tasks/session-bridge.test.ts` — 33 assertions passed, but suite failed on the 30-second afterAll timeout; not acceptance. The isolated MCP suite passed 10 tests.
- `agent-sdk-runtime`: `bun test src/connection-provider.test.ts` — 10 passed; `claxedo-local-server`: mounted connection/adoption suites — 11 passed. SDK typecheck and focused lint passed.
- Native Windows: `./script/cbx-ci.ts run focus-helpers-windows` — 192 passed, 4 skipped, exit success; automatic lease deletion confirmed.
- `claxedo-server`: `node node_modules/vitest/vitest.mjs run src/deployments/self-hosted-node/embedded-child-wake-authority.test.ts src/deployments/self-hosted-node/embedded-host-authority.test.ts src/deployments/self-hosted-node/embedded-session-policy.test.ts` — 15 passed.
- `workspace-runtime`: `bun test src/event-delivery.test.ts src/routes/events.test.ts` — 69 passed; `bun test src/workspace/ src/server.test.ts` — 145 passed, no closed-database errors. Runtime typecheck and focused four-file lint passed.
- `claxedo-server`: `node node_modules/vitest/vitest.mjs run src/authority/adapters/d1/session-authority.test.ts` — 16 passed, including the parent-grant race regression.
- `workspace-runtime`: `bun test src/routes/session-turn-lease.test.ts src/routes/session-prompt-delivery.test.ts src/session/delivery-owner.test.ts` — 42 passed; runtime typecheck and focused two-file lease lint passed.
- `claxedo-local-server`: `node node_modules/vitest/vitest.mjs run src/app/first-party-mcp-tasks.live.test.ts src/app/first-party-mcp.live.test.ts src/app/first-party-mcp-subagents.live.test.ts src/tasks/local-composition.test.ts` — 33 passed. An earlier Bun invocation was the wrong runner for these Vitest suites and is not acceptance evidence.
- `claxedo-mcp`: `node node_modules/vitest/vitest.mjs run src/tools/sessions.test.ts src/tools/attention.test.ts` — 38 passed.
- `workspace-runtime`: `bun test src/workspace/worktree-file-access.test.ts src/routes/diff.test.ts src/routes/git-worktree.test.ts src/target.test.ts` — 71 passed after four root review regressions first demonstrated real private-content/filename exposure. Runtime typecheck and focused three-file lint passed. Root `bun run test:architecture-ratchets` passed without raising a ceiling.
- `workspace-runtime`: `bun test src/event-delivery.test.ts src/routes/events.test.ts src/routes/checkpoint-auth.test.ts` — 76 passed; `bun test src/routes/local-document-broker.test.ts` — 3 passed.
- `claxedo-server`: `node node_modules/vitest/vitest.mjs run src/deployments/self-hosted-node/embedded-host-authority.test.ts src/deployments/self-hosted-node/embedded-session-policy.test.ts src/routes/runtime-session-authority.test.ts src/authority/adapters/d1/host-access-authority.test.ts` — 82 passed; final `embedded-host-authority.test.ts` rerun after adding checkpoint HTTP proof — 4 passed.
- `claxedo-server`: `node node_modules/vitest/vitest.mjs run src/documents` — 261 passed after P-104.
- `claxedo-tasks`: `bun test src` — 245 passed; `bun run typecheck` and focused five-file `bunx oxlint` — passed.
- `bun run typecheck` in server, server-core, local-server and workspace-runtime — passed; focused `bunx oxlint` — no errors or warnings; root `bun run test:architecture-ratchets` — passed; scoped `git diff --check` — clean.

## How to read the verdicts

Each entry retains its original ID and severity, gives the current status and reassessed severity, explains what the code actually permits, and names the fix and acceptance check. Links point to current owners, not the original report's stale line numbers. “Present” means the mechanism exists in current source; it does not imply every deployment exposes it. “Partial” means part of the old claim changed or lacks proof. “Latent” requires a currently absent caller/composition. “Resolved” closes the specific original mechanism, not every possible issue in that subsystem. “Not a bug” means the described behavior alone does not violate the identified boundary.

Severity here is an engineering priority, not a calculated CVSS score. Critical means a reachable path plausibly permits unauthenticated host execution. High means crossing a consequential user/workspace/credential boundary. Medium means a narrower integrity, confidentiality or availability failure with stated access prerequisites. Low means limited impact or defense in depth. Informational means a design concern or inactive path without a demonstrated current security impact. Conditional ratings must be read together with their prerequisites.

Do not add these findings as independent risks: H-1/P-1/P-2, P-14/P-34/P-107/P-129, S-1/P-84/P-102, and P-60/P-86 overlap. The original report's remediation notes also contain stale claims: filtering harness environments does not fully close H-1, and its later OAuth note does not address P-75's actual network-policy/image finding.

## What deserves attention first

| Priority | Findings | Why |
| --- | --- | --- |
| Immediate composition fix | P-81 | Signed self-hosted startup mounts local plugin mutation routes without authentication; a configured MCP command can later execute on the host. Critical if this composition is network reachable. |
| Resource authority | P-59, P-60/P-86, P-87, P-88, P-90, P-94 | Project administration, provider resource identity, session identity, machine enrollment and cross-workspace runtime calls need authoritative ownership checks. |
| Desktop trust boundary | S-1, P-84, residual P-82 | A localhost origin is not the desktop app; initial PTY read admission is not ongoing permission to write. |
| Conditional high impact | P-3, P-4, P-85, P-116, H-1 | Insecure enrollment/JWKS transport, Telegram verifier configuration, symlink reads and privileged process exposure each need the stated prerequisite. |
| Close or narrow old claims | H-4, P-1, P-2, P-57, P-58, P-62, P-63, P-83, P-100, P-101, P-139 | Specific old paths have been fixed or replaced; keep regression coverage on the canonical replacement. |
| Avoid unsupported XSS severity | S-2, P-68, P-69 | Unsafe-looking sinks warrant cleanup, but the full current browser exploit is not established merely by finding `innerHTML`, an anchor, or a CSS string. |

## A junior engineer's map of the system

A user action begins in `claxedo-app` or `session-ui`. In desktop mode, some actions cross Electron IPC into `claxedo-desktop`; others call `claxedo-local-server`. The daemon can operate local files, start runtimes and modify configuration. A signed deployment also uses `claxedo-server` and `claxedo-server-core` to decide who may access a workspace/session. Remote traffic may pass through `workspace-relay` or `claxedo-host-serving`. `workspace-runtime` executes session operations and owns terminal/event routes. `agent-sdk-runtime` launches agent harnesses; `sandbox-manager` manages provider machines.

The UI is not an authority. Hiding a button only changes what an honest user sees. A caller can construct the same HTTP/IPC request independently. Authentication answers “who presented this credential?” Authorization answers “may that identity do this operation on this exact stored resource?” A bearer token grants power to whoever possesses it. A workspace ID, a sender ID inside JSON, an Origin header, or a text label is not such a credential.

An authorization lease is permission with a deadline and renewal rule. It matters for terminals and event streams because a connection can remain open after membership is revoked. SSRF means making a privileged server connect to a caller-chosen destination. XSS means attacker-controlled content actually executes script in a trusted page. An unsafe string alone is evidence of a possible path, not proof that every downstream sanitizer and browser rule is bypassed.

The walkthroughs below explain the recurring patterns. Each finding links to its relevant walkthrough and gives its own narrower correction.

<a id="flow-a"></a>
### A. Authorize the actual operation and stored resource

When a user enables an agent plugin, the app sends configuration to the server. In self-hosted startup, `start.ts` mounts route contributions through `mountControlPlaneRouteContributions`. That function checks route ownership, meaning which package owns a path; it does not authenticate a person. `SignedAgentPluginRuntimeRoutes` parses plugin artifacts and secret configuration and applies the result. The unsigned-local request guard steps aside in signed mode. Without an explicit signed-user/operator check, valid JSON can reach a privileged mutation. The stored MCP command is then consumed when a harness starts. This is P-81: the dangerous step is accepting configuration, even if command execution happens later.

The precise change is at the mounted mutation boundary and its canonical service: require the intended operator principal before parsing/applying plugin configuration, and bind affected resources to that principal. Keep parsing and harness consumption intact. Verify anonymous denial, non-operator denial, and legitimate operator success through the actual signed app. A disabled frontend button does not repair this path.

A related mistake occurs in `workspace-runtime/src/routes/session-core.ts`: session creation accepts a supplied ID and can mutate existing configuration before authority registration rejects it (P-87). Authorization of “create a new session” does not authorize modifying an existing private one. Reserve a fresh identity and authorize the stored object before any mutation; rollback must only delete state created by that request. In document broker P-103, derive read/write permission from the HTTP route rather than a caller-controlled operation header. These fixes prevent one person's request from changing another person's work; stricter errors require the UI to handle denial without optimistic success.

<a id="flow-b"></a>
### B. Keep privileged secrets and provider identity with their owners

Starting a workspace causes the supervisor to build its runtime environment. The runtime has credentials that allow service-to-service calls. Launching an agent then creates a child process. The current `harnessSpawnEnv` strips internal namespaces before that child starts; the Pi and PTY tests confirm the specific inheritance fixes. The parent's environment still exists. Running untrusted code under the same operating-system identity may expose that environment by a different route. This is why P-1/P-2 can be closed while H-1 remains conditional.

The change belongs both at the canonical environment builder and at the process isolation boundary. Do not patch each frontend request to omit a secret after it has already reached the agent. Keep explicit operational values, remove privileged credentials from all child launch owners, and isolate the runtime from untrusted processes. Daemon document git has a separate launch owner that still inherits `process.env` (P-131); repository-configured helpers can run during git operations.

For P-60/P-86, a runtime status/snapshot request supplies sandbox identity fields that the manager can copy into its lease. A lease is the control plane's record of which provider resource it owns. A runtime reporting “I am resource B” must not be allowed to replace that record. Keep resource ID, host ID and generation authoritative in the manager; compare incoming telemetry with them before updating health. This preserves safe recovery while preventing snapshots or deletion from targeting a different resource. Test mismatches and stale generations as well as healthy updates.

<a id="flow-c"></a>
### C. Separate browser origin, network peer and authenticated endpoint

A page running at `http://localhost:3000` and the desktop app are different callers. The local daemon currently treats several localhost origins as trusted, and reflects them through CORS. CORS controls browser response access; it does not authenticate the page. With unsigned local-owner routes, a hostile local development page can gain much more power than its own web origin should have (S-1). The canonical daemon boundary needs an app-held capability, exact approved origins and trusted socket-peer information. Electron main attaches that capability to trusted renderer requests; renderer JavaScript never receives the token.

Cookies create another distinction: they are scoped to a host, not a TCP port. `HttpOnly` prevents JavaScript from reading a cookie; it does not stop the browser sending it to another server on that hostname. That is the prerequisite behind P-108/P-109. Reproduce the complete approval request in the real browser before labeling it zero-click. Use exact-origin CSRF checks and a suitable authentication hostname/boundary, not a frontend-only confirmation dialog.

When a connector enrolls a host, it sends invitation material to its configured control plane. When management JWTs are checked, the runtime downloads public keys from the configured JWKS URL. HTTPS authenticates those remote endpoints and protects the request. Without it, an on-path attacker may steal enrollment material or substitute verification keys (P-3/P-116). Validate the endpoint before the first request, persist only approved configuration, and handle rejection as an actionable configuration error. Tests must show that rejected URLs receive no request at all. Separate service origins can be legitimate; blindly requiring one hostname would break valid deployments.

<a id="flow-d"></a>
### D. Permission and identity must stay valid for the whole operation

Opening a terminal causes the local PTY proxy to look up the terminal and check read access. Current tests show foreign-session admission is rejected. The proxy then connects directly to the embedded terminal. That path does not have all the renewed read and per-message write checks in `workspace-runtime/src/routes/pty.ts`. Consequently, an initial read check is insufficient evidence that a long-lived socket remains safe (P-82).

Make the canonical PTY authorization policy cover admission, each write and continued output. Reuse that policy in the embedded path, rather than adding a permissive second implementation. Remove a user's access while the socket is open: subsequent input must fail and output must stop by the defined deadline. A legitimate viewer should still be able to read without gaining keyboard control. Reconnect must obtain fresh authority.

The same lifetime problem appears in sessionless SSE (P-111), queued prompts (P-93), expiring wakes (P-17) and cached tokens (R-2). Check the authoritative deadline when work executes, not only when it was queued. Never synthesize a newer timestamp to make a stale event fit the current flow. Distinguish bounded propagation delay from permanent access. The UI should show expired/revoked state and offer a fresh authorized action rather than silently replaying stale work.

<a id="flow-e"></a>
### E. Trace untrusted text all the way to the browser sink

A document contains Mermaid source. The editor invokes `mermaid.render`, then inserts the generated SVG into preview/fullscreen `innerHTML`. Strict-mode Mermaid is an existing security layer. The separate shared SVG sanitizer is another layer that these two sinks omit. Current Mermaid is 11.16.0; the inspected classDef advisory was fixed in 11.15.0. That advisory does not prove a current exploit. Apply the canonical SVG sanitizer at both sinks and verify preview, fullscreen, themes and links with the actual renderer. The benefit is consistent handling; the possible downside is stripping intended SVG features that need explicit safe support. See the [Mermaid advisory](https://github.com/mermaid-js/mermaid/security/advisories/GHSA-ghcm-xqfw-q4vr).

For a file link, follow the value from tool output into the anchor and click handler. Rejecting it inside a handler is ineffective if the browser's default navigation still runs. However `target`, `rel`, browser scheme handling and Electron navigation guards affect whether a dangerous-looking URL executes in the app. P-68 confirms the validation gap, not a reproduced high-severity app XSS. Normalize an approved link once, render an inert label on failure, and suppress default navigation when handling it yourself.

Likewise, raw HTML emitted by Markdown is not automatically XSS if every consumer sanitizes it. Test the final mounted component, including the plugin extension path, and use context-appropriate encoding. Text placed inside a style element with `textContent` does not become an HTML script tag. Add a packaged renderer CSP as a second layer while keeping sink-level controls.

<a id="flow-f"></a>
### F. Renderer input must stay data across IPC, shells and the filesystem

A desktop action calls an IPC handler in the main process. The IPC sender guard establishes that the renderer may use the bridge; it does not validate every argument. In P-6, `wslPath` turns a tilde-prefixed path into part of a `sh -lc` command. Double quotes do not disable shell command substitution. The current non-tilde path already uses argv, which keeps arguments separate from executable code. Resolve the home directory separately and pass the complete literal path as one argument. Test this on Windows/WSL; a Linux string-only test cannot prove platform behavior.

In P-7, `getStore` passes a renderer-chosen store name to `electron-store`; the installed `conf` resolves that name against its directory. `../` can escape that directory. Replace the arbitrary namespace with a main-process registry of known stores and supported keys. This limits settings access without breaking normal reads and writes. Do not describe the current primitive as arbitrary binary-file writing: it operates on JSON stores.

Opening files is also an execution boundary. “Open in Terminal” should accept directories, while launching executable files needs an explicit intentional user action. A regex that recognizes some absolute paths is not filesystem isolation. Test authorized targets, symlinks, traversal and OS-specific handlers at the privileged owner.

<a id="flow-g"></a>
### G. Text and claimed sender identity are not authenticated events

A Telegram webhook reaches a transport adapter, which should verify a secret before translating the payload into a channel message. The registry accepts a prefixed secret variable, but adapter construction does not pass that resolved secret and the installed adapter reads a different variable. In the alias-only configuration, an enabled integration may lack verification (P-4). Fix the configuration producer: resolve one secret, pass it explicitly, and refuse an enabled transport with no verifier. The GitHub adapter does verify its signature; do not copy Telegram's verdict onto GitHub.

A tool result has an equally important distinction. `hostSubagentBinding` can parse a subagent-looking marker from ordinary text. A repository file or tool output can therefore claim that an unrelated session is a child (P-5). Parsing establishes syntax, not ownership. Bind the relationship only to the canonical create-subagent tool result for the matching invocation, then check the stored parent/child relationship. Keep ordinary tool text displayable without allowing it to modify authority. A unit probe proves marker acceptance; a full transcript disclosure needs the downstream access path to succeed too.

<a id="flow-h"></a>
### H. Reject expensive inputs before doing expensive work

A task request reaches the JSON decoder, which maps each plugin entry and accumulates validation errors. A byte limit alone still permits many tiny invalid entries: the bounded probe produced 2,000 errors from 1,000 entries (P-16). Check collection length before mapping and cap the error list. Return a small useful validation error to the frontend rather than constructing a huge response.

The relay has analogous boundaries. Reading a full body before acquiring a concurrency slot defeats that slot's memory budget. Checking “too many frames AND too many bytes” allows either budget alone to be exceeded (P-107). Reserve capacity first, reject on either limit, count bytes while receiving and apply backpressure to slow consumers. Long-lived SSE needs a separate budget from short control requests so a legitimate event stream cannot starve ordinary operations. Test limits with small deterministic thresholds, cancellation and cleanup; do not exhaust the developer machine to demonstrate denial of service.

## Every original finding

The proposed fix in each entry is future work. For resolved entries it describes the regression coverage to retain, not a request to restore the obsolete implementation.

### Ranked work table — first to last

This orders **all 161 original findings** using the reassessment at `e06522f6e6`; it is not a new source audit of commits after that revision. Follow the table from top to bottom. Rank is the recommended work order, not a new severity score: reachability, confidence, impact and shared fixes affect placement. Conditional or unconfirmed entries require the linked acceptance check before claiming their full exploit impact.

“Immediate” addresses the critical exposed composition. “High priority” covers consequential authority and credential boundaries. “Next fixes / validation” covers medium risks and the checks needed to establish conditional impact. “Scheduled fixes” covers narrower defects. “Hardening / latent” comes after reachable defects. “Close / consolidate” means no separate implementation ticket for the original claim; retain regression tests or merge it into the named active finding. P-102's real local exposure is already prioritized under P-84, and P-54 is a duplicate. Related rows such as P-60/P-86 and P-107/P-14/P-34/P-129 should share a coordinated fix rather than duplicate implementations.

The next-action column is the first step; each finding link opens the complete explanation, prerequisites, proposed fix and acceptance checks below.

| Order | Work band | Finding | Original → latest severity | Current status | Next action |
| --- | --- | --- | --- | --- | --- |
| 1 | Immediate | [P-81 — Unsigned plugin routes are mounted in the signed server](#finding-p-81) | CRITICAL → Critical, signed network-reachable node | Fixed; focused checks passed | Retain operator gate and mounted-app regression tests; see remediation progress. |
| 2 | High priority | [P-59 — Project management still trusts any signed caller too broadly](#finding-p-59) | HIGH → High, signed node with local execution | Fixed; focused checks passed | Retain shared project authorization, operator folder-import policy and fail-closed creation checks. |
| 3 | High priority | [P-88 — Any signed caller can enroll the server machine](#finding-p-88) | HIGH (conditional) → High, shared signed-node deployment | Fixed; focused checks passed | Retain shared operator authorization and enrollment/revocation regression checks. |
| 4 | High priority | [P-90 — Workspace lifecycle still has signed-versus-operator gaps](#finding-p-90) | MED-HIGH → High before remediation | Fixed; service and mounted-app verification | Keep canonical admission before enrollment and serving effects. |
| 5 | High priority | [P-87 — Create-existing session can mutate then roll back someone else's session](#finding-p-87) | HIGH → High, workspace editor/valid admission prerequisite | Fixed; focused checks passed | Retain canonical ownership and regression checks; see remediation progress. |
| 6 | High priority | [P-82 — PTY attach now checks access but bypasses rolling write policy](#finding-p-82) | HIGH → High residual, authorized-read prerequisite | Fixed; focused checks passed | Retain canonical ownership and regression checks; see remediation progress. |
| 7 | High priority | [S-1 — Any allowed localhost website can drive the local daemon](#finding-s-1) | HIGH → High, conditional | Partial; packaged acceptance open | Give the app a per-installation daemon capability and check it on privileged reads and writes, pin browser origins, and retain the peer check. |
| 8 | High priority | [P-84 — Local website can reconfigure the daemon's remote-control setup](#finding-p-84) | HIGH → High, hostile localhost origin | Partial; packaged acceptance open | Authenticate machine-control routes with an app-held capability, accept endpoint/credential updates only from the canonical signed handoff and protect MCP installation/config writes. |
| 9 | High priority | [P-60 — Runtime heartbeat can rewrite provisioner identity](#finding-p-60) | HIGH (CRITICAL w/ shared token) → High; Critical chain conditional | Fixed; focused checks passed | Retain provisioner-only identity, runtime-token/epoch checks and conditional liveness writes. |
| 10 | High priority | [P-86 — Lease rewrite can redirect later snapshot operations](#finding-p-86) | HIGH → High; fleet snapshot chain unverified live | Mechanism fixed; live provider unverified | Retain fake-provider A/B isolation and store race tests; verify a real provider lifecycle separately. |
| 11 | High priority | [P-94 — Session pull does not bind runtime token to route workspace](#finding-p-94) | MED → High with a leaked workspace control token | Fixed; focused checks passed | Retain workspace-token and stored-session isolation checks; see remediation progress. |
| 12 | High priority | [P-85 — Diff reads can escape through symlinks](#finding-p-85) | HIGH → High, file/symlink prerequisite | Partial; native races remain | Finish parent-directory replacement protection on macOS/Windows and native verification. |
| 13 | High priority | [P-57 — Shell workspace authorization was added but worktree targeting remains broad](#finding-p-57) | CRITICAL → High residual; original Critical chain mitigated | Fixed; focused checks passed | Retain canonical ownership and regression checks; see remediation progress. |
| 14 | High priority | [P-4 — Telegram's enabled flag and verifier read different secrets](#finding-p-4) | MED-HIGH → High, configuration-dependent | Fixed; focused checks passed | Retain canonical registry credentials and real-adapter verification tests. |
| 15 | High priority | [P-3 — Host enrollment accepts an insecure control-plane URL](#finding-p-3) | HIGH (conditional) → High, conditional | Fixed; focused checks passed | Retain canonical ownership and regression checks; see remediation progress. |
| 16 | High priority | [P-116 — Management JWKS URL permits an insecure trust anchor](#finding-p-116) | LOW → High, conditional | Fixed; focused checks passed | Retain HTTPS/redirect checks and pinned local key delivery. |
| 17 | High priority | [P-20 — HTTP introspection can trust forged authorization claims](#finding-p-20) | MED → High, conditional | Fixed; focused checks passed | Retain endpoint, redirect and temporal-claim checks; explicit loopback development only. |
| 18 | High priority | [H-1 — Runtime bearer remains in the privileged process](#finding-h-1) | HIGH → High, conditional | Partial | Separate agent and privileged runtime users/processes, remove the deployment-wide token override, and scope short-lived service credentials to a workspace and operation. |
| 19 | Next fixes / validation | [P-64 — Workspace file APIs do not enforce private-session ownership](#finding-p-64) | MED → Medium; High for sensitive cross-session files | Partial; API gates verified, commit race remains | Preserve exact authorized paths and bind committed content to the authorized index snapshot. |
| 20 | Next fixes / validation | [P-131 — Daemon document git still inherits privileged environment](#finding-p-131) | LOW-MED → Medium; High if privileged secrets reachable | Fixed; focused checks passed | Retain shared safe Git runner, narrow credential/index options and real helper/clone regression checks. |
| 21 | Next fixes / validation | [P-103 — Document capability operation comes from a header](#finding-p-103) | MED → Medium before remediation | Fixed; broker HTTP and relay integration | Keep route-owned operations and verified document/session scope. |
| 22 | Next fixes / validation | [P-104 — Agent-open checks project membership but not target session ownership](#finding-p-104) | MED-LOW → Medium before remediation | Fixed; real HTTP and writeback proof | Canonical session authority gates hydration and every writeback; revocation preserves document content. |
| 23 | Next fixes / validation | [P-11 — Runtime tools can send to sibling sessions](#finding-p-11) | MED → Medium, local runtime scope | Fixed; focused entrypoint checks passed | Keep canonical stored-parent reach and workspace anchoring for send, abort and child question replies. |
| 24 | Next fixes / validation | [P-105 — Tasks bridge loses the runtime's session confinement](#finding-p-105) | MED → Medium, unsigned local MCP | Fixed; focused entrypoint checks passed | Keep session grants, project confinement, agent-start gates and invalid-grant refusal. |
| 25 | Next fixes / validation | [P-92 — Read access to a parent can authorize child completion input](#finding-p-92) | MED → Medium | Partial; embedded admission and wake verified | Keep creation and embedded wake revocation checks; finish remote proof under P-93. |
| 26 | Next fixes / validation | [P-93 — Recovered and child-completion turns skip durable authority admission](#finding-p-93) | MED → Medium availability/integrity | Partial; embedded recovery verified | Add scoped remote recovery proof without owner impersonation or unleased execution. |
| 27 | Next fixes / validation | [P-111 — Sessionless SSE frames can outlive membership](#finding-p-111) | MED → Medium | Fixed; verified with real SQLite and open SSE | Keep renewable workspace leases and fail closed on invalid renewal or revocation. |
| 28 | Next fixes / validation | [P-91 — Workspace editors can invoke runtime-wide checkpoint control](#finding-p-91) | MED → Medium | Fixed; verified through checkpoint HTTP | Retain current workspace membership checks and scoped supervisor grants. |
| 29 | Next fixes / validation | [P-98 — Refreshing a revoked OAuth credential can reactivate it](#finding-p-98) | MED → Medium | Partial; local fixed, hosted KV open | Add authoritative hosted lifecycle fencing; retain atomic local revocation regressions. |
| 30 | Next fixes / validation | [P-17 — Expired wakes can fire before the sweep](#finding-p-17) | MED → Medium for approvals | Fixed; focused checks passed | Retain atomic deadline admission and expiry-boundary regression tests. |
| 31 | Next fixes / validation | [P-10 — Missing MCP confirmation support silently means approval](#finding-p-10) | MED → Medium | Fixed; HTTP/SDK tests passed | Retain the shared confirmation gate and positive/negative destructive-tool coverage. |
| 32 | Next fixes / validation | [P-21 — Channel reset runs before per-session authorization](#finding-p-21) | MED → Medium | Fixed; focused checks passed | Retain canonical session admission before commands and preserve binding on cancellation failure. |
| 33 | Next fixes / validation | [P-27 — Some channel identities use usernames](#finding-p-27) | MED-LOW → Medium where mutable identity is authoritative | Partial | Persist platform-stable user ids, keep usernames only for display, and reject missing stable ids. |
| 34 | Next fixes / validation | [P-108 — Localhost cookies are shared across ports](#finding-p-108) | MED → Medium | Present, deployment-dependent | Use exact trusted origins and a dedicated auth hostname/secure deployment boundary; avoid bearer-equivalent cookies on shared localhost hosts. |
| 35 | Next fixes / validation | [P-109 — Device approval may be driven through permissive local CSRF policy](#finding-p-109) | MED → Medium, HTTP embedded + hostile localhost origin | Partial exploit confirmation | Require explicit approval with exact-origin CSRF protection, make GET read-only and bind approval to the displayed device transaction. |
| 36 | Next fixes / validation | [P-89 — Workspace tunnel exposes machine credential compatibility routes](#finding-p-89) | MED-HIGH → Medium; credential write chain conditional | Fixed; tunnel and local account checks passed | Retain denial before replay and local account-management acceptance. |
| 37 | Next fixes / validation | [P-67 — MCP discovery's private-network predicate is incomplete](#finding-p-67) | MED → Medium | Present | Use canonical IP parsing and enforce destination policy at connection time and every redirect, with DNS rebinding protection. |
| 38 | Next fixes / validation | [S-12 — Repository cloning can contact internal services](#finding-s-12) | LOW-MED → Medium, deployment-dependent | Present | Apply deployment-specific repository destination policy and network egress restrictions to cloning, including resolved IPs. |
| 39 | Next fixes / validation | [P-72 — Cloning and initial network policy allow caller-selected hosts](#finding-p-72) | MED-LOW → Medium, signed clone access | Present | Apply one canonical repository admission policy before both clone and network-policy generation. |
| 40 | Next fixes / validation | [P-107 — Relay memory limits are bypassed by queue conditions](#finding-p-107) | MED → Medium | Partial; Bun bounds implemented | Finish Cloudflare and host-client bounds; retain Bun queue, body-admission and slow-consumer regressions. |
| 41 | Next fixes / validation | [P-14 — Bun buffers ordinary request and response bodies](#finding-p-14) | MED → Medium | Present | Acquire capacity before reading, enforce a byte limit, and stream responses with bounded buffering. |
| 42 | Next fixes / validation | [P-34 — Several relay lifecycle bugs were grouped together](#finding-p-34) | LOW → Medium for buffering; Low for other parts | Mixed | Track P-107, P-128, P-129 and P-130 separately. |
| 43 | Next fixes / validation | [P-129 — Long streams and WebSocket sends share weak resource limits](#finding-p-129) | LOW → Medium availability | Fixed; focused budget tests | Separate active-stream and pending-request budgets, enforce socket backpressure and preserve a small control-request budget. |
| 44 | Next fixes / validation | [P-74 — Several runtime routes parse unbounded JSON](#finding-p-74) | LOW → Medium for body DoS; Informational health | Partial; body and identity checks passed | One byte-limit reader serves runtime/document routes; process and PTY identity is authoritative. Public health diagnostics remain open. |
| 45 | Next fixes / validation | [P-16 — Invalid arrays amplify validation errors](#finding-p-16) | MED → Medium before remediation | Fixed; task HTTP proof | Reject arrays before element decoding using contract limits; bound error collection. |
| 46 | Next fixes / validation | [S-6 — Search executes a caller-provided regular expression](#finding-s-6) | LOW → Low locally; Medium on a shared node | Fixed; focused worker tests | Use bounded linear-time search, such as the existing ripgrep boundary with a timeout, or literal search. |
| 47 | Next fixes / validation | [P-6 — Tilde-prefixed paths become shell code](#finding-p-6) | MED → Medium, Windows/WSL only | Partial; source fixed, Windows acceptance open | Linux home is resolved separately and renderer paths travel as argv; verify the real Windows/WSL launch. |
| 48 | Next fixes / validation | [P-22 — Device-login URL reaches the Windows command shell](#finding-p-22) | MED → Medium, conditional | Partial; source fixed, native Windows acceptance open | Device URLs are checked against descriptor origins and the shell launcher is removed; native Windows acceptance remains. |
| 49 | Next fixes / validation | [P-7 — Renderer-selected store names escape the settings directory](#finding-p-7) | MED → Medium, renderer prerequisite | Present | Replace arbitrary names with a fixed store registry in main, validate keys and bound values. |
| 50 | Next fixes / validation | [P-8 — Opening a file can execute it](#finding-p-8) | MED → Medium, renderer prerequisite | Present | Separate opening directories in tools from opening documents. |
| 51 | Next fixes / validation | [P-26 — Browser registry accepts non-guest webContents](#finding-p-26) | MED-LOW → Medium, renderer prerequisite | Present | Record guest ownership in main when the webview attaches and require that relation on registration. |
| 52 | Next fixes / validation | [P-9 — Beta and stable share update metadata](#finding-p-9) | MED → Medium operational risk | Present | Publish separate channels and artifact names, disable automatic downgrades, and test each installed variant against its own signed release metadata. |
| 53 | Next fixes / validation | [P-23 — Web openLink does not validate schemes](#finding-p-23) | MED-LOW → Medium, potential XSS | Partial | Use one platform URL opener that accepts intended schemes and sets noopener/noreferrer. |
| 54 | Next fixes / validation | [P-5 — Tool text can invent a subagent relationship](#finding-p-5) | MED→HIGH → Medium; cross-session disclosure unconfirmed | Partial | Only accept bindings from the canonical create-subagent result for its matching tool call, then verify stored parent/child ownership. |
| 55 | Next fixes / validation | [P-96 — Usage ownership follows the requesting account](#finding-p-96) | MED → Medium | Present | Bind usage identity to the session/runtime producer when facts are created, restrict local history to the machine operator and scope quota reads. |
| 56 | Next fixes / validation | [P-97 — Task cloud starts bypass the route's admission policy](#finding-p-97) | MED → Medium; paid-product reachability conditional | Present source gap | Move cloud creation admission into the canonical creation service and call it from tasks and routes. |
| 57 | Next fixes / validation | [P-99 — Custom provider endpoint and env selection need policy](#finding-p-99) | MED → Medium transport; env-exfiltration unconfirmed | Partial | Require secure approved destinations and deliver only registry-owned provider credentials to the engine. |
| 58 | Next fixes / validation | [P-12 — Host endpoint configuration trusts arbitrary schemes](#finding-p-12) | MED → Medium, conditional | Present | Require secure schemes and reject embedded credentials; bind endpoint updates to verified control-plane configuration. |
| 59 | Next fixes / validation | [H-2 — Worker verification permits plaintext credentials](#finding-h-2) | LOW-MED → Medium, conditional | Fixed; focused checks passed | Retain canonical HTTPS endpoint and no-redirect checks across credential entry and driver use. |
| 60 | Next fixes / validation | [P-127 — Relay target parser accepts unrestricted URL strings](#finding-p-127) | LOW-MED → Medium, insecure target configuration | Partial | Parse and validate allowed schemes/destinations when resolving a target and before forwarding; use secure transport outside explicitly trusted local topology. |
| 61 | Next fixes / validation | [P-61 — Checked path and forwarded path are different](#finding-p-61) | HIGH → Medium, malicious-relay prerequisite | Fixed; HTTP/WebSocket target checks passed | Retain canonical path construction and real relay HTTP/file/PTY acceptance. |
| 62 | Scheduled fixes | [P-110 — Auth adapter traffic can miss the product request limiter](#finding-p-110) | MED-LOW → Low-Medium; edge deployment conditional | Present source/config gap | Configure the auth limiter with CF's trusted client IP and place a suitable public-auth budget before dispatch. |
| 63 | Scheduled fixes | [P-35 — Broker work is not independently bounded](#finding-p-35) | LOW → Low-Medium | Present | Add timeouts and concurrency limits around authority resolution and upstream fetch; reject conflicting credential presentations. |
| 64 | Scheduled fixes | [P-76 — Device polling can hold a request indefinitely](#finding-p-76) | LOW → Low-Medium | Mixed | Bound total polling by the provider expiry and request cancellation, then remove pending state. |
| 65 | Scheduled fixes | [P-128 — Anonymous first traffic influences relay room placement](#finding-p-128) | LOW-MED → Low-Medium availability | Present mechanism | Resolve region from authoritative workspace placement before object creation, or authenticate the hint. |
| 66 | Scheduled fixes | [P-71 — Provider command strings contain secrets](#finding-p-71) | MED-LOW → Low-Medium, provider logging dependent | Present | Use provider secret/env APIs or private files/stdin, avoid secrets in command strings and redact diagnostics. |
| 67 | Scheduled fixes | [P-29 — Host consent state and redirects need stronger boundaries](#finding-p-29) | MED-LOW → Low-Medium, conditional | Partial | Persist the accepted scope revision and explicit refusal state, and refuse credential-bearing redirects. |
| 68 | Scheduled fixes | [P-49 — CI bootstrap executes downloaded tooling without independent verification](#finding-p-49) | LOW → Low-Medium supply-chain hardening | Present | Pin versions and verify checksums/signatures, pass test arguments structurally, and constrain CI secret exposure. |
| 69 | Scheduled fixes | [H-3 — Revocation and installed credentials have different lifetimes](#finding-h-3) | LOW → Low | Partial | Make revocation trigger canonical delivery reconciliation, clear installed material, and revoke the key at its provider when needed. |
| 70 | Scheduled fixes | [R-2 — Revocation has a bounded cache delay](#finding-r-2) | LOW → Low | Present | Specify the maximum revocation delay from configured TTLs and test removal during cached HTTP requests and an open socket, including authority outage and hard token expiry. |
| 71 | Scheduled fixes | [P-125 — Unknown explicit workspace ids fall back to directory](#finding-p-125) | LOW → Low; boundary impact caller-dependent | Fixed; store and HTTP verification passed | Unknown explicit IDs cannot fall back to directory/project discovery or creation; preserve real store and metadata-route regressions. |
| 72 | Scheduled fixes | [P-36 — Workspace fallback and session audit issues differ](#finding-p-36) | LOW → Low | Fixed; focused tests | Fail closed on unknown explicit ids; retain created-session audit evidence. |
| 73 | Scheduled fixes | [P-133 — Hydration activation can use a stored capability](#finding-p-133) | LOW → Low before remediation | Fixed; mounted route checks | Session access policy authorizes the caller against the stored session before activation or resolution uses its stored capability. |
| 74 | Scheduled fixes | [P-134 — Unattributed lifecycle frames have broad visibility](#finding-p-134) | LOW → Low | Fixed; focused ownership tests | Stamp canonical workspace/session ownership at the producer and omit sensitive unowned frames. |
| 75 | Scheduled fixes | [P-32 — Auth and attachment writes lack some filesystem protections](#finding-p-32) | LOW → Low; secret exposure conditional | Present | Use atomic writes in private verified directories, explicitly set existing modes, resolve attachment parents securely, cap bytes and pass prompts through stdin. |
| 76 | Scheduled fixes | [P-121 — Existing credential seed permissions are not repaired](#finding-p-121) | LOW → Low; local filesystem prerequisite | Fixed; focused backend tests | Reject malformed seeds and enforce private ownership/modes on existing paths without following symlinks. |
| 77 | Scheduled fixes | [P-122 — Connection turn credentials are created without a visible mint path](#finding-p-122) | INFO → Low availability | Present source gap | Issue the credential at canonical authorized turn admission and expire it with the turn. |
| 78 | Scheduled fixes | [P-124 — Signed node's in-process MCP fetch lacks actor credentials](#finding-p-124) | LOW → Low availability | Present source gap | Pass a canonical verified runtime principal through the in-process boundary using the existing dispatch owner. |
| 79 | Scheduled fixes | [P-137 — Daytona runtime identity can differ from its lease identity](#finding-p-137) | LOW-MED → Low availability; live provider unverified | Partial; source identity corrected | Verify one real Daytona relay connection with the driver-owned host identity. |
| 80 | Scheduled fixes | [P-119 — Missing subscription timestamp becomes arrival time](#finding-p-119) | LOW → Low integrity | Fixed; timestamp-less webhook rejected | Retain signed-webhook rejection coverage; external authority ordering remains separately unverified. |
| 81 | Scheduled fixes | [S-10 — An SSE resume cursor can inject control lines](#finding-s-10) | LOW → Low | Fixed; focused route tests | Validate the cursor format and reject CR/LF at ingress, and update the affected Hono dependency. |
| 82 | Scheduled fixes | [P-39 — Event projection accepts unbounded identifiers and raw data](#finding-p-39) | LOW → Low availability; disclosure conditional | Fixed; focused checks passed | Retain safe keyed maps, retained-state bounds and diagnostic-surface-only raw frames. |
| 83 | Scheduled fixes | [P-40 — Runtime type guards and maps accept unexpected values](#finding-p-40) | LOW → Low | Fixed; focused checks passed | Retain own-property lookups, nested wire-value validation and explicit expected bindings at trust boundaries. |
| 84 | Scheduled fixes | [P-44 — Task identifiers, attachments and provenance need bounds](#finding-p-44) | LOW → Low | Mixed | Bound ids, verify allowed image bytes, stamp provenance from authenticated context and keep authorization on historical links. |
| 85 | Scheduled fixes | [P-45 — Wake APIs leave policy and concurrency to callers](#finding-p-45) | LOW → Low | Mixed | Require explicit policy, redact approval tokens from list views, atomically claim once receipts and reject nonfinite times. |
| 86 | Scheduled fixes | [P-135 — Prompt dedup marker precedes lease acquisition](#finding-p-135) | LOW → Low, narrow concurrency window | Fixed; focused admission tests | Represent pending admission separately from completed admission and let duplicates await the canonical result. |
| 87 | Scheduled fixes | [P-130 — Long token lifetimes can overflow timers](#finding-p-130) | LOW → Low correctness | Fixed; Bun socket tests passed | Retain bounded scheduling and signed-deadline rechecks. |
| 88 | Scheduled fixes | [S-7 — Expired file-search entries remain allocated](#finding-s-7) | LOW → Low | Fixed; focused cache tests | Use a bounded cache with eviction and discard obsolete roots. |
| 89 | Scheduled fixes | [P-77 — Root project compatibility ignores tunnel scope](#finding-p-77) | LOW → Low disclosure | Fixed; viewer/editor inventory denial passed | Retain workspace-scoped tunnel denial and positive workspace reads. |
| 90 | Scheduled fixes | [P-73 — Some GETs still create state or disclose inventory](#finding-p-73) | MED-LOW → Low | Partial | Move creation to an explicit authorized POST and scope each inventory at its owner. |
| 91 | Scheduled fixes | [P-132 — Agent discovery GET can create and start a workspace](#finding-p-132) | LOW-MED → Low; local-owner chain | Fixed; focused discovery tests | Separate read-only discovery from explicit authorized workspace creation. |
| 92 | Scheduled fixes | [M-1 — Unsigned loopback MCP grants machine-owner scope](#finding-m-1) | MED → Low; chain with S-1 | Present | Require an application-held capability for machine-wide MCP, retain socket-peer verification, and avoid publishing the loopback service through an unauthenticated proxy. |
| 93 | Scheduled fixes | [R-1 — A header cannot prove relay provenance](#finding-r-1) | MED → Low, conditional | Present | Use private network access or an authenticated relay-to-runtime channel if relay-only reachability is required. |
| 94 | Scheduled fixes | [P-15 — Relay forwards upstream cookie and CORS headers too broadly](#finding-p-15) | MED-LOW → Low, conditional | Partial | Strip upstream Set-Cookie and all access-control headers at the shared relay boundary, then emit only relay-owned CORS. |
| 95 | Scheduled fixes | [P-38 — Protocol validators accept more than transport policy should](#finding-p-38) | LOW → Low; authentication impact conditional | Fixed; focused protocol/adapter tests | Enforce semantic token validity, secure no-redirect transport, legal close codes and header names at boundaries. |
| 96 | Scheduled fixes | [P-41 — Connection persistence and gates rely on composition](#finding-p-41) | LOW → Low | Mixed | Compensate failed writes or persist both atomically, require explicit route policy, and serialize device completion. |
| 97 | Scheduled fixes | [P-42 — Adapter identifiers and transport metadata need validation](#finding-p-42) | LOW → Low; HTTP transport conditional | Mixed | Validate opaque session-id grammar, constrain credential destinations and redact error/diagnostic outputs consistently. |
| 98 | Scheduled fixes | [P-43 — CLI-generated files trust operator strings](#finding-p-43) | LOW → Low; transport risk separate | Present | Validate app/region identifiers, serialize TOML safely and escape systemd syntax. |
| 99 | Scheduled fixes | [P-55 — Channel approval parsing and administration need tightening](#finding-p-55) | INFO → Low; authorization effect conditional | Mixed | Use exact structured action values, apply the same access/rate/dedup checks on approvals, and atomically establish pairing bindings. |
| 100 | Scheduled fixes | [P-115 — Unmanaged hook updates can name unowned terminal ids](#finding-p-115) | LOW → Low | Fixed; focused hook tests | Require an existing terminal and its bound hook capability for lifecycle writes. |
| 101 | Scheduled fixes | [P-136 — Embedded cookie-plus-bearer precedence is not explicit rejection](#finding-p-136) | LOW → Low | Fixed; focused bridge tests | Reject dual presentation before authentication or change the declared contract if precedence is intentional. |
| 102 | Scheduled fixes | [P-25 — Deep links can register a caller-named project](#finding-p-25) | MED-LOW → Low, user interaction required | Present | Confirm externally initiated project registration with the resolved directory visible; never auto-submit a deep-link prompt. |
| 103 | Scheduled fixes | [P-31 — Guest content can influence prompt context](#finding-p-31) | LOW → Low | Partial | Track guest identity, navigation generation and active pick state; require user acceptance before adding context. |
| 104 | Scheduled fixes | [S-9 — Open-path grants broad OS file-opening power](#finding-s-9) | LOW → Low in isolation | Present | Use reveal-in-folder for location navigation and explicit user actions for executable opening. |
| 105 | Scheduled fixes | [P-33 — ACP Windows arguments are interpreted by a shell](#finding-p-33) | LOW → Low, configuration-dependent | Present/latent | Use real executables or robust platform launch handling and preserve each argument literally. |
| 106 | Scheduled fixes | [P-75 — Daytona list delimiters and image arguments are not locally validated](#finding-p-75) | LOW → Low, input-policy dependent | Fixed; focused validation tests | Validate hostname/CIDR lists before formatting and reject option-like image identifiers at the driver boundary. |
| 107 | Scheduled fixes | [P-46 — Small helper contracts fail on edge cases](#finding-p-46) | LOW → Low correctness/hardening | Fixed; focused helper tests | Return a typed invalid-reference error, use path-relative containment, constrain URL path inputs and private atomic writes. |
| 108 | Scheduled fixes | [S-8 — Client-supplied analytics identity is trusted](#finding-s-8) | LOW → Low | Fixed; focused route tests | Derive identity from the app/session where available, allowlist event names and bound properties and request rate. |
| 109 | Scheduled fixes | [P-113 — Signed node analytics route is anonymous](#finding-p-113) | LOW → Low | Fixed; focused app tests | Authenticate server-owned analytics or accept only a constrained public event schema with rate limits; derive identity server-side. |
| 110 | Scheduled fixes | [P-24 — Bootstrap local information is intentionally local](#finding-p-24) | MED-LOW → Low locally; signed remote leak resolved | Partial | Keep anonymous signed bootstrap minimal and protect rich local bootstrap with the same app capability as S-1. |
| 111 | Hardening / latent | [S-2 — Documents Mermaid lacks the extra SVG sanitizer](#finding-s-2) | HIGH → Low hardening; High only if XSS reproduced | Unconfirmed exploit | Route both sinks through the existing SVG sanitizer and use the shared renderer configuration. |
| 112 | Hardening / latent | [P-68 — Some transcript anchors bypass URL filtering](#finding-p-68) | MED → Low confirmed hardening; Medium XSS unconfirmed | Partial | Filter before assigning href and prevent default on rejected schemes, including modified clicks via inert hrefs. |
| 113 | Hardening / latent | [P-69 — Markdown renderer returns unsafe raw HTML attributes](#finding-p-69) | MED → Low in current app; Medium for unsanitized consumers | Partial | Escape attributes and allowlist link schemes at the shared builder; keep final sanitization. |
| 114 | Hardening / latent | [P-78 — Markdown math processing can rewrite attributes](#finding-p-78) | LOW → Low; XSS unconfirmed | Partial | Perform math rendering on text tokens/nodes before HTML serialization, escape raw HTML and retain sanitization. |
| 115 | Hardening / latent | [S-3 — Packaged renderer has no document CSP](#finding-s-3) | MED → Low hardening | Present | Define a production renderer CSP compatible with required workers, assets and connections; validate the packaged document and normal session/editor flows. |
| 116 | Hardening / latent | [P-13 — Cloudflare WebSockets lack the Bun origin check](#finding-p-13) | MED → Low hardening | Present | Share the origin policy across both adapters and test missing, trusted and hostile origins with and without a valid token. |
| 117 | Hardening / latent | [P-123 — MCP loopback helper does not inspect the socket peer](#finding-p-123) | LOW-MED → Low hardening; exploit unconfirmed | Partial | Use server-stamped peer provenance in network mounts, retain runtime credential verification, and test forged Host/Origin through the actual provider ingress. |
| 118 | Hardening / latent | [P-140 — MCP optional audience and unused permission claim are separate](#finding-p-140) | INFO → Low hardening/Informational | Fixed; focused verifier tests | Require the resource audience at the canonical OAuth verifier if that is the contract; remove unused claims or mint/verify them end to end. |
| 119 | Hardening / latent | [P-56 — Broker response and token observations overstate some effects](#finding-p-56) | INFO → Low hardening; no broker bypass established | Mixed | Retain per-request runtime validation, review forwarded response headers and query credential slots, and verify specific advisories against installed use. |
| 120 | Hardening / latent | [P-120 — Node encrypted backend shares one deployment key partition](#finding-p-120) | LOW → Low hardening | Present design assumption | If multi-tenant cryptographic separation is required, carry authoritative org identity into the backend API and key derivation. |
| 121 | Hardening / latent | [P-114 — Command-path scanner misses redirection syntax](#finding-p-114) | LOW → Low; not a shell sandbox | Fixed; focused scanner tests | Use actual process/filesystem isolation where confinement is promised; avoid claiming a regex is a sandbox. |
| 122 | Hardening / latent | [P-118 — Reading a cloud connection can start compute](#finding-p-118) | LOW-MED → Low/product policy | Present behavior | Choose and document a spend policy, then enforce entitlement/budget at ensure. |
| 123 | Hardening / latent | [P-48 — Storybook CSS writer lacks a strong request boundary](#finding-p-48) | LOW → Low, development-only | Present | Require a dev capability/origin check and canonical path containment with a separator boundary. |
| 124 | Hardening / latent | [P-47 — Development proxy forwards sensitive headers](#finding-p-47) | LOW → Low, development-only proxy | Present | Bind the proxy to loopback, strip credentials unless explicitly needed and keep it out of production artifacts. |
| 125 | Hardening / latent | [P-51 — Renderer configuration and default-session permissions are broad](#finding-p-51) | INFO → Informational/Low | Mixed | Validate persisted endpoint schemes, clamp zoom, restrict privileged browser permissions and retain sender checks. |
| 126 | Hardening / latent | [P-53 — Wake cancellation trusts possession and host scope has constraints](#finding-p-53) | INFO → Low/Informational | Partial | Make authorization explicit at exposed cancellation boundaries and test cross-session ids. |
| 127 | Hardening / latent | [P-106 — Custom verifier results lack a local expiry check](#finding-p-106) | MED → Low now; High if insecure verifier composed | Fixed; focused verifier tests | Enforce exp/nbf and a maximum lifetime after every verifier result, regardless of implementation. |
| 128 | Hardening / latent | [P-126 — Resolver headers can overwrite relay-owned authorization](#finding-p-126) | LOW (latent) → Low hardening | Fixed; focused resolver tests | Allowlist provider-specific headers and stamp reserved authentication/identity headers last. |
| 129 | Hardening / latent | [P-95 — Checkpoint helper trusts unsigned mode but outer guard blocks remote callers](#finding-p-95) | MED → Low latent helper risk | Not reachable as claimed | Keep the public-entrypoint denial test and add an explicit loopback check in the reusable helper if it can be mounted elsewhere. |
| 130 | Hardening / latent | [P-28 — Unknown broker capability is accepted](#finding-p-28) | MED-LOW → Low hardening | Fixed; focused refusal tests | Require explicit native support at the boundary where provider secrets are delivered. |
| 131 | Hardening / latent | [P-70 — Exe environment names become shell syntax](#finding-p-70) | MED → Low; Medium for unsafe embedders | Latent | Validate environment names at the driver boundary too and remove the duplicate unused shell builder. |
| 132 | Hardening / latent | [P-79 — Shared card links trust their callers](#finding-p-79) | LOW → Low hardening | Latent | Centralize safe-link construction and type validated internal/external links distinctly where useful. |
| 133 | Hardening / latent | [P-117 — Route manifest is not a complete authorization inventory](#finding-p-117) | LOW → Informational | Fixed; composition inventory test passed | Retain the composed-app route/guard inventory across all production mounts. |
| 134 | Hardening / latent | [P-18 — Event delivery has no workspace argument](#finding-p-18) | MED (design) → Informational now; Medium if exposed | Latent | Make workspace/tenant identity part of the event contract before exposing ingress. |
| 135 | Hardening / latent | [P-19 — Telemetry exports raw exception text](#finding-p-19) | MED → Informational now | Latent | Define allowed attributes and redact at event production/export before adoption. |
| 136 | Hardening / latent | [P-37 — Tracing configuration is not a consent boundary](#finding-p-37) | LOW → Informational now | Latent | Apply consent before constructing/enabling the exporter, then validate and bound attributes and trace state. |
| 137 | Hardening / latent | [R-3 — Injected host-tunnel authorization can weaken the contract](#finding-r-3) | LOW → Informational | Latent | Keep invariant host/workspace binding outside overridable policy, or require a validated-claims result. |
| 138 | Hardening / latent | [S-5 — Codex Windows shim uses a shell](#finding-s-5) | MED → Informational | Latent | Resolve the real executable where possible and keep arguments out of command strings. |
| 139 | Hardening / latent | [S-11 — Hook token uses ordinary string comparison](#finding-s-11) | LOW → Informational | Fixed; focused tests | Use the existing constant-time string helper consistently and test correct, incorrect and different-length tokens. |
| 140 | Hardening / latent | [P-112 — Pairing admin token uses ordinary equality](#finding-p-112) | LOW → Informational | Fixed; focused guard tests | Use the shared constant-time helper and narrow exemptions to actual public webhook paths. |
| 141 | Close / consolidate | [P-102 — Host-serving route belongs to desktop composition](#finding-p-102) | MED → High local exposure tracked as P-84 | Not mounted as claimed | Consolidate the real desktop exposure into P-84; signed enrollment is P-88. |
| 142 | Close / consolidate | [P-54 — This row repeats MCP and relay observations](#finding-p-54) | INFO → Informational | Duplicate | Consolidate into the linked MCP/relay findings; do not open a duplicate fix. |
| 143 | Close / consolidate | [H-4 — Old silent secret-resolution path is gone](#finding-h-4) | LOW → None | Resolved | Keep backend-outage tests on the current delivery owner. |
| 144 | Close / consolidate | [P-1 — Pi now uses the filtered harness environment](#finding-p-1) | HIGH → None for original inheritance bug | Resolved | Retain the deny-by-default namespace test and verify each new Pi child uses environment(). |
| 145 | Close / consolidate | [P-2 — All filtered harnesses deny internal namespaces by default](#finding-p-2) | HIGH → None for original namespace leak | Resolved | Keep the canonical filter on every harness spawn. |
| 146 | Close / consolidate | [P-58 — Credential discovery now requires a local request](#finding-p-58) | HIGH → None for original remote discovery bug | Resolved | Keep tests at all three routes with remote, forwarded and authorized local requests. |
| 147 | Close / consolidate | [P-62 — Runtime git now uses buildSafeEnv](#finding-p-62) | HIGH → None for original runtime git env leak | Resolved | Retain environment assertions for the actual git spawn and audit the daemon sibling separately under P-131. |
| 148 | Close / consolidate | [P-63 — Bare PTY proxy now has a loopback gate](#finding-p-63) | MED-HIGH → None for anonymous remote attach | Resolved original; see P-82 | Keep remote-anonymous denial tests. |
| 149 | Close / consolidate | [P-65 — Stored resource workspace now controls authorization](#finding-p-65) | MED → None for original selector-precedence bug | Resolved | Retain tests for same-workspace update, forbidden foreign resource, and authorized/unauthorized rebind. |
| 150 | Close / consolidate | [P-66 — Anonymous signed bootstrap is a minimal declaration](#finding-p-66) | MED → None for original signed bootstrap leak | Resolved | Test exact anonymous response fields and signed/local rich bootstrap separately. |
| 151 | Close / consolidate | [P-83 — Desktop relay now carries verified actors and private-session policy](#finding-p-83) | HIGH → None for unmanaged-local relay promotion | Resolved main claim | Retain the real desktop composition tests for stranger, owner, unavailable authority and forged relay token. |
| 152 | Close / consolidate | [P-100 — Legacy cross-organization workspace sharing is gone](#finding-p-100) | MED → None for removed workspace-sharing API | Resolved by removal | Keep organization-binding tests on current session-share APIs. |
| 153 | Close / consolidate | [P-101 — Machine heartbeat now requires a one-use signed request](#finding-p-101) | MED → None for original heartbeat replay | Resolved by replacement | Retain replay, stale timestamp, wrong body and revoked machine tests through the mounted route. |
| 154 | Close / consolidate | [P-139 — Session share doorbells compare the same subject namespace](#finding-p-139) | LOW → None for original namespace mismatch | Resolved | Retain grant/revoke fanout tests using different internal ids and identity-provider subjects. |
| 155 | Close / consolidate | [P-138 — Old token helpers were replaced or tightened](#finding-p-138) | INFO → Informational | Partial/resolved | Keep strict principal validation and tests that only trusted service code can invoke service minting. |
| 156 | Close / consolidate | [S-4 — GitHub webhook verification is delegated correctly](#finding-s-4) | MED (verify) → None for the claimed missing verification | Not reproduced | Keep signed, missing-signature and bad-signature tests at the mounted GitHub handler. |
| 157 | Close / consolidate | [M-2 — MCP sessions change when credential scope changes](#finding-m-2) | LOW → Informational | Not a bug | Document reconnect on changed scopes and make the client retry initialization with its new credential. |
| 158 | Close / consolidate | [P-30 — Provisioner availability comes from deployment credentials](#finding-p-30) | MED-LOW → Informational | Not a standalone bug | Keep provisioner configuration separate from caller authorization and align environment names. |
| 159 | Close / consolidate | [P-52 — Type declarations do not enforce runtime values](#finding-p-52) | INFO → Informational | Not a standalone security bug | Freeze stable exported tables when useful and validate external revision/usage numbers as finite integers/ranges. |
| 160 | Close / consolidate | [P-50 — Documents service RPC scaffold is not a working runtime](#finding-p-50) | INFO → Informational | Latent | Before enabling the runtime, validate request shape and grants at the RPC entrypoint and test disabled-service refusal and wrong installation identity. |
| 161 | Close / consolidate | [P-80 — Session-app has no audited implementation](#finding-p-80) | INFO → None | Not a finding | No security fix. |

### Detailed explanations and acceptance checks


<a id="finding-h-1"></a>
### H-1 — Runtime bearer remains in the privileged process

**Original severity:** HIGH. **Current:** Partial. **Reassessed severity:** High, conditional.

**What happens and why it matters:** Harness inheritance is fixed, but the runtime still receives a trusted-direct bearer and accepts it before normal relay authorization. The shared externalConfigToken override still exists. Same-UID access to the runtime process is a separate exposure; filtering child env does not establish process isolation.

**Fix and acceptance:** Separate agent and privileged runtime users/processes, remove the deployment-wide token override, and scope short-lived service credentials to a workspace and operation. Verify a token from A cannot reach B, and an agent process cannot read the runtime environment.

**Current code:** [packages/claxedo-server-core/src/hosts/workspace-runtime/env.ts](../packages/claxedo-server-core/src/hosts/workspace-runtime/env.ts); [packages/workspace-runtime/src/workspace-host-service-auth.ts](../packages/workspace-runtime/src/workspace-host-service-auth.ts); [packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts](../packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts). [Concept walkthrough B](#flow-b).

<a id="finding-h-2"></a>
### H-2 — Worker verification permits plaintext credentials

**Original severity:** LOW-MED. **Current:** Fixed; focused checks passed. **Reassessed severity:** Medium, conditional.

**What happens and why it matters:** Worker URL validation is now owned by sandbox-contract and used before credentials are stored or transmitted, including config/environment and managed-secret loading. The URL must use HTTPS and contain no user information, query or fragment. Verification and provisioning requests refuse redirects.

**Fix and acceptance:** Retain invalid-URL no-fetch/no-persistence tests, HTTPS success, driver construction rejection and redirect regression checks. Focused server, driver and contract suites passed; see remediation progress.

**Current code:** [packages/claxedo-server-core/src/credentials/operations/sandbox-verify.ts](../packages/claxedo-server-core/src/credentials/operations/sandbox-verify.ts). [Concept walkthrough C](#flow-c).

<a id="finding-h-3"></a>
### H-3 — Revocation and installed credentials have different lifetimes

**Original severity:** LOW. **Current:** Partial. **Reassessed severity:** Low.

**What happens and why it matters:** Config pushes still reconcile running workspaces. Provider delivery now has explicit empty-secret withdrawal, so “no secret retraction” is too broad. A copied provider key cannot be made unknown to an already-running process by changing a database row.

**Fix and acceptance:** Make revocation trigger canonical delivery reconciliation, clear installed material, and revoke the key at its provider when needed. Test the last-account withdrawal and a backend outage during revocation; document the measured propagation delay.

**Current code:** [packages/claxedo-server/src/workspace/supervisor/config-sync.ts](../packages/claxedo-server/src/workspace/supervisor/config-sync.ts). [Concept walkthrough B](#flow-b).

<a id="finding-h-4"></a>
### H-4 — Old silent secret-resolution path is gone

**Original severity:** LOW. **Current:** Resolved. **Reassessed severity:** None.

**What happens and why it matters:** resolveSecretsForScope is absent. Its quoted registry line now belongs to another operation, and native delivery records an unreadable-secret result. The old LOW availability finding should be closed rather than attached to the new implementation.

**Fix and acceptance:** Keep backend-outage tests on the current delivery owner. Verify an unreadable account is distinguished from a deliberate withdrawal and never silently treated as successful delivery.

**Current code:** [packages/claxedo-server-core/src/credentials/native-delivery.ts](../packages/claxedo-server-core/src/credentials/native-delivery.ts). [Concept walkthrough B](#flow-b).

<a id="finding-r-1"></a>
### R-1 — A header cannot prove relay provenance

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Low, conditional.

**What happens and why it matters:** workspace-host-service-auth still checks x-forwarded-by after verifying the relay token. Anyone already holding a valid token can forge the marker; the marker itself does not bypass signature, workspace, host or role checks. MED overstates an independent vulnerability without a stolen token or a policy bypass.

**Fix and acceptance:** Use private network access or an authenticated relay-to-runtime channel if relay-only reachability is required. Keep token validation and renewal. Test direct replay with a valid synthetic token and a forged marker.

**Current code:** [packages/workspace-runtime/src/workspace-host-service-auth.ts](../packages/workspace-runtime/src/workspace-host-service-auth.ts); [packages/workspace-relay/src/server.ts](../packages/workspace-relay/src/server.ts). [Concept walkthrough C](#flow-c).

<a id="finding-r-2"></a>
### R-2 — Revocation has a bounded cache delay

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low.

**What happens and why it matters:** The relay retains verification caching and socket activity timers. This is a deliberate consistency window, not proof that revoked access lasts indefinitely; HTTP and socket paths have different checks. Do not reuse the old report's exact timing as a universal guarantee.

**Fix and acceptance:** Specify the maximum revocation delay from configured TTLs and test removal during cached HTTP requests and an open socket, including authority outage and hard token expiry.

**Current code:** [packages/workspace-relay/src/server.ts](../packages/workspace-relay/src/server.ts); [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough D](#flow-d).

<a id="finding-r-3"></a>
### R-3 — Injected host-tunnel authorization can weaken the contract

**Original severity:** LOW. **Current:** Latent. **Reassessed severity:** Informational.

**What happens and why it matters:** The composition seam can substitute an authorization function. Trusted application code could already replace other security dependencies, so the seam alone is not a shipped bypass.

**Fix and acceptance:** Keep invariant host/workspace binding outside overridable policy, or require a validated-claims result. Add a composition test with a permissive policy and a mismatched host.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough A](#flow-a).

<a id="finding-m-1"></a>
### M-1 — Unsigned loopback MCP grants machine-owner scope

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Low; chain with S-1.

**What happens and why it matters:** The node explicitly creates fullUserCredential for unsigned loopback requests without a bearer. That is the local-owner trust model, not a remote authentication bypass by itself. A hostile local page/process or a proxy that turns remote traffic into loopback makes the boundary matter.

**Fix and acceptance:** Require an application-held capability for machine-wide MCP, retain socket-peer verification, and avoid publishing the loopback service through an unauthenticated proxy. Test an anonymous local caller separately from the authorized app.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts). [Concept walkthrough A](#flow-a).

<a id="finding-m-2"></a>
### M-2 — MCP sessions change when credential scope changes

**Original severity:** LOW. **Current:** Not a bug. **Reassessed severity:** Informational.

**What happens and why it matters:** credentialKey includes authorization fields and sorted scopes. Reusing a session with changed rights would retain the old tool context, so invalidation is the correct behavior.

**Fix and acceptance:** Document reconnect on changed scopes and make the client retry initialization with its new credential. Test that an unchanged scope set reuses a session while changed rights do not.

**Current code:** [packages/claxedo-mcp/src/server.ts](../packages/claxedo-mcp/src/server.ts). [Concept walkthrough D](#flow-d).

<a id="finding-s-1"></a>
### S-1 — Any allowed localhost website can drive the local daemon

**Original severity:** HIGH. **Current:** Partial; packaged acceptance open. **Reassessed severity:** High, conditional.

**What changed:** the mounted local application requires its daemon capability before privileged operations. Anonymous health and separately verified runtime/MCP/broker ingress retain narrow exemptions. Electron main stamps the capability only for the registered trusted top frame and exact daemon origin, and strips it on redirects. Empty configured secrets fail composition.

**Acceptance:** Five real bundled-daemon tests and 16 real Electron boundary tests passed, covering hostile localhost requests, HTTP/WebSocket capability delivery, untrusted iframe/guest windows, navigation, redirects and file-origin behavior. Signed packaged macOS remains unverified; the required Crabbox SSH profile is not configured. Native CI portability is under review.

**Current code:** [packages/claxedo-local-server/src/app/local-app.ts](../packages/claxedo-local-server/src/app/local-app.ts); [packages/claxedo-server-core/src/platform/http/peer-address.ts](../packages/claxedo-server-core/src/platform/http/peer-address.ts); [packages/claxedo-local-server/src/shell/file-browser.ts](../packages/claxedo-local-server/src/shell/file-browser.ts). [Concept walkthrough A](#flow-a).

<a id="finding-s-2"></a>
### S-2 — Documents Mermaid lacks the extra SVG sanitizer

**Original severity:** HIGH. **Current:** Unconfirmed exploit. **Reassessed severity:** Low hardening; High only if XSS reproduced.

**What happens and why it matters:** Both document preview and fullscreen assign mermaid.render output to innerHTML. However Mermaid is pinned to 11.16.0 and runs in strict mode; the inspected older advisories are patched before that version. Absence of an extra sanitizer does not establish stored XSS.

**Fix and acceptance:** Route both sinks through the existing SVG sanitizer and use the shared renderer configuration. Reproduce with the actual bundled Mermaid and Electron/browser before calling this a confirmed HIGH XSS.

**Current code:** [packages/claxedo-app/src/features/documents/editor/mermaid-block.ts](../packages/claxedo-app/src/features/documents/editor/mermaid-block.ts); [packages/claxedo-app/src/features/session/ui/mermaid-timeline.ts](../packages/claxedo-app/src/features/session/ui/mermaid-timeline.ts). [Concept walkthrough E](#flow-e).

<a id="finding-s-3"></a>
### S-3 — Packaged renderer has no document CSP

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Low hardening.

**What happens and why it matters:** The packaged window loads index.local.html from disk and the document has no CSP meta. API response security headers cannot protect this file document. This is a missing second layer, not script execution by itself.

**Fix and acceptance:** Define a production renderer CSP compatible with required workers, assets and connections; validate the packaged document and normal session/editor flows. Keep the primary sanitization fixes.

**Current code:** [packages/claxedo-desktop/src/main/windows.ts](../packages/claxedo-desktop/src/main/windows.ts). [Concept walkthrough E](#flow-e).

<a id="finding-s-4"></a>
### S-4 — GitHub webhook verification is delegated correctly

**Original severity:** MED (verify). **Current:** Not reproduced. **Reassessed severity:** None for the claimed missing verification.

**What happens and why it matters:** The installed GitHub Chat adapter requires a webhook secret or verifier and checks x-hub-signature-256 before handling an update. An unused local signature helper does not mean the production handler is unsigned. Telegram's separate configuration gap remains P-4.

**Fix and acceptance:** Keep signed, missing-signature and bad-signature tests at the mounted GitHub handler. Remove the dead helper if no public caller needs it.

**Current code:** [packages/claxedo-channels/src/transport/github.ts](../packages/claxedo-channels/src/transport/github.ts); [packages/claxedo-channels/src/transport/chat-sdk-adapters.ts](../packages/claxedo-channels/src/transport/chat-sdk-adapters.ts). [Concept walkthrough G](#flow-g).

<a id="finding-s-5"></a>
### S-5 — Codex Windows shim uses a shell

**Original severity:** MED. **Current:** Latent. **Reassessed severity:** Informational.

**What happens and why it matters:** shell:true remains for Windows command shims, but the cited Codex arguments are fixed. No untrusted argument-to-command execution was established in this path.

**Fix and acceptance:** Resolve the real executable where possible and keep arguments out of command strings. Test Windows paths containing spaces and metacharacters before admitting configurable arguments.

**Current code:** [packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.ts](../packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.ts). [Concept walkthrough F](#flow-f).

<a id="finding-s-6"></a>
### S-6 — Search executes a caller-provided regular expression

**Original severity:** LOW. **Current:** Fixed; focused worker tests. **Reassessed severity:** Low locally; Medium on a shared node.

**What changed:** grepSearch no longer evaluates the caller-supplied RegExp on the request thread: the line scan runs inside a one-off worker with cleared exec flags, heap and stack limits, a 2-second terminate deadline and a concurrency cap, returning collected matches on timeout. A catastrophic (a+)+$ input completes in about two seconds.

**Acceptance:** Focused tests cover a pathological pattern terminating on the deadline, regex semantics and the empty-on-invalid contract. Committed as bbdd0ef3d8.

**Current code:** [packages/claxedo-local-server/src/shell/files.ts](../packages/claxedo-local-server/src/shell/files.ts). [Concept walkthrough H](#flow-h).

<a id="finding-s-7"></a>
### S-7 — Expired file-search entries remain allocated

**Original severity:** LOW. **Current:** Fixed; focused cache tests. **Reassessed severity:** Low.

**What changed:** The file-search index cache is bounded: a 32-root ceiling with an expiry sweep on read and LRU eviction on insert, so expired or abandoned roots cannot accumulate.

**Acceptance:** Focused tests cover eviction past the bound and the expiry sweep. Committed as 2e6bc675a1.

**Current code:** [packages/claxedo-local-server/src/shell/files.ts](../packages/claxedo-local-server/src/shell/files.ts). [Concept walkthrough H](#flow-h).

<a id="finding-s-8"></a>
### S-8 — Client-supplied analytics identity is trusted

**Original severity:** LOW. **Current:** Fixed; focused route tests. **Reassessed severity:** Low.

**What changed:** The local analytics route derives identity from the session rather than a client-supplied distinctId, bounds event names and properties, and applies rate controls.

**Acceptance:** Focused behaviour tests cover identity derivation and the bounds. Committed as 6ba179295b.

**Current code:** [packages/claxedo-local-server/src/app/local-app.ts](../packages/claxedo-local-server/src/app/local-app.ts). [Concept walkthrough H](#flow-h).

<a id="finding-s-9"></a>
### S-9 — Open-path grants broad OS file-opening power

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low in isolation.

**What happens and why it matters:** The guarded IPC handler still calls shell.openPath for an absolute path. An authenticated renderer can invoke OS file handlers; a remote page cannot invoke the bridge merely by knowing the channel name. Script/executable handling is covered in P-8.

**Fix and acceptance:** Use reveal-in-folder for location navigation and explicit user actions for executable opening. Test file types and keep the IPC sender guard.

**Current code:** [packages/claxedo-desktop/src/main/ipc.ts](../packages/claxedo-desktop/src/main/ipc.ts). [Concept walkthrough F](#flow-f).

<a id="finding-s-10"></a>
### S-10 — An SSE resume cursor can inject control lines

**Original severity:** LOW. **Current:** Fixed; focused route tests. **Reassessed severity:** Low.

**What changed:** SSE Last-Event-ID is validated against the stream's decimal cursor grammar before admission; malformed values including CR/LF injection attempts return a structured 400 and never open a stream. Hono updated to 4.12.34.

**Acceptance:** Mounted-route tests cover malformed and injected cursors plus the valid path. Committed as 0913bce8a0.

**Current code:** [packages/workspace-runtime/src/routes/events.ts](../packages/workspace-runtime/src/routes/events.ts). [Concept walkthrough D](#flow-d).

<a id="finding-s-11"></a>
### S-11 — Hook token uses ordinary string comparison

**Original severity:** LOW. **Current:** Fixed; focused tests. **Reassessed severity:** Informational.

**What changed:** PTY hook token lookup and renewal compare with the existing constant-time string helper, including unequal-length inputs.

**Acceptance:** Focused tests cover correct, incorrect, renewal and unequal-length tokens. Committed as bdb6c2a9b6.

**Current code:** [packages/workspace-runtime/src/pty/index.ts](../packages/workspace-runtime/src/pty/index.ts). [Concept walkthrough B](#flow-b).

<a id="finding-s-12"></a>
### S-12 — Repository cloning can contact internal services

**Original severity:** LOW-MED. **Current:** Present. **Reassessed severity:** Medium, deployment-dependent.

**What happens and why it matters:** safeRepoUrl admits HTTP, SSH and scp-shaped URLs. Git is a server-side network client, so an authorized project creator can cause internal connection attempts. Allowing SSH itself is a feature; the issue is unrestricted destination access.

**Fix and acceptance:** Apply deployment-specific repository destination policy and network egress restrictions to cloning, including resolved IPs. Test private destinations and permitted private repositories under an explicit operator policy.

**Current code:** [packages/claxedo-local-server/src/workspace/routes/projects-route.ts](../packages/claxedo-local-server/src/workspace/routes/projects-route.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-1"></a>
### P-1 — Pi now uses the filtered harness environment

**Original severity:** HIGH. **Current:** Resolved. **Reassessed severity:** None for original inheritance bug.

**What happens and why it matters:** Pi environment now passes process.env through harnessSpawnEnv before piSpawnEnv. The old full-environment path is gone and the focused environment suite passes.

**Fix and acceptance:** Retain the deny-by-default namespace test and verify each new Pi child uses environment(). Same-UID runtime memory/environment exposure remains H-1.

**Current code:** [packages/agent-sdk-runtime/src/harnesses/pi/driver.ts](../packages/agent-sdk-runtime/src/harnesses/pi/driver.ts); [packages/agent-sdk-runtime/src/harnesses/pi/auth.ts](../packages/agent-sdk-runtime/src/harnesses/pi/auth.ts); [packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts](../packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-2"></a>
### P-2 — All filtered harnesses deny internal namespaces by default

**Original severity:** HIGH. **Current:** Resolved. **Reassessed severity:** None for original namespace leak.

**What happens and why it matters:** harnessEnvAllowed now rejects CLAXEDO_ and WORKSPACE_RUNTIME_ names except an explicit operational allowlist. The secret-suffix check applies to these namespaces; it is not a blanket removal of provider credentials or every secret in process.env.

**Fix and acceptance:** Keep the canonical filter on every harness spawn. Treat non-prefixed deployment secrets separately instead of claiming this isolates a child from its privileged parent.

**Current code:** [packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts](../packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts); [packages/agent-sdk-runtime/src/harnesses/claude/driver.ts](../packages/agent-sdk-runtime/src/harnesses/claude/driver.ts); [packages/agent-sdk-runtime/src/harnesses/codex/protocol.ts](../packages/agent-sdk-runtime/src/harnesses/codex/protocol.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-3"></a>
### P-3 — Host enrollment accepts an insecure control-plane URL

**Original severity:** HIGH (conditional). **Current:** Fixed; focused checks passed. **Reassessed severity:** High, conditional.

**What happens and why it matters:** Host state construction/loading and invitation redemption share canonicalControlPlaneUrl. Machine transport pins the canonical endpoint and refuses redirects; insecure non-loopback URLs are refused before invitation material is read or persisted.

**Fix and acceptance:** Retain URL rejection, no-transmission, redirect and signed path-prefix regression checks. See remediation progress for package verification.

**Current code:** [packages/claxedo-host-connector/src/machine-transport.ts](../packages/claxedo-host-connector/src/machine-transport.ts); [packages/claxedo-host-connector/src/bootstrap.ts](../packages/claxedo-host-connector/src/bootstrap.ts); [packages/claxedo-host-connector/src/host-state.ts](../packages/claxedo-host-connector/src/host-state.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-4"></a>
### P-4 — Telegram's enabled flag and verifier read different secrets

**Original severity:** MED-HIGH. **Current:** Fixed in the working tree; focused regression checks passed. **Reassessed severity:** High, configuration-dependent.

**Original mechanism:** The registry accepts the CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN alias, while adapter construction passes no config and the installed adapter reads TELEGRAM_WEBHOOK_SECRET_TOKEN. With only the alias set and a working bot token, verification is disabled and a forged sender can reach channel processing.

**Initial acceptance requirement:** Resolve one canonical configuration and pass secretToken explicitly; refuse startup if verification is missing. Test alias-only, canonical-only, wrong-secret and unsigned requests at the real adapter.

**Current code:** [packages/claxedo-channels/src/registry.ts](../packages/claxedo-channels/src/registry.ts); [packages/claxedo-channels/src/transport/chat-sdk-adapters.ts](../packages/claxedo-channels/src/transport/chat-sdk-adapters.ts). [Concept walkthrough G](#flow-g).

**Remediation:** See [remediation progress](#remediation-progress) for implementation and verification scope.

<a id="finding-p-5"></a>
### P-5 — Tool text can invent a subagent relationship

**Original severity:** MED→HIGH. **Current:** Partial. **Reassessed severity:** Medium; cross-session disclosure unconfirmed.

**What happens and why it matters:** A pure probe confirms hostSubagentBinding accepts JSON embedded in text with a foreign session id. Claude scans generic tool results. The admission store correlates observations within a parent but that is not proof of authoritative ownership of the named child; actual transcript access remains a separate check.

**Fix and acceptance:** Only accept bindings from the canonical create-subagent result for its matching tool call, then verify stored parent/child ownership. Test hostile read-file output and a real child binding.

**Current code:** [packages/agent-event-runtime/src/harnesses/host-subagent.ts](../packages/agent-event-runtime/src/harnesses/host-subagent.ts); [packages/agent-event-runtime/src/harnesses/claude/adapter.ts](../packages/agent-event-runtime/src/harnesses/claude/adapter.ts). [Concept walkthrough G](#flow-g).

<a id="finding-p-6"></a>
### P-6 — Tilde-prefixed paths become shell code

**Original severity:** MED. **Current:** Partial; source remediated, native Windows/WSL acceptance open. **Reassessed severity:** Medium, Windows/WSL only.

**Change:** The existing apps.ts owner resolves Linux HOME with a constant shell command that contains no renderer text. It passes the joined path to wslpath as an argument. Root's regression caught trimming a valid home-directory suffix; the value now stays literal. The old interpolated command is removed.

**Acceptance:** Root's five path-conversion tests pass, covering literal shell metacharacters, home whitespace, both conversion modes and the non-Windows entrypoint. The delegate ran 46 related startup/IPC/open-in tests and desktop typecheck. Root's focused lint and architecture ratchets pass without raising a ceiling. Actual Windows/WSL execution, including literal metacharacters through the native process boundary, is still required.

**Current code:** [path owner](../packages/claxedo-desktop/src/main/apps.ts); [path tests](../packages/claxedo-desktop/src/main/apps.test.ts); [IPC](../packages/claxedo-desktop/src/main/ipc.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-7"></a>
### P-7 — Renderer-selected store names escape the settings directory

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium, renderer prerequisite.

**What happens and why it matters:** getStore passes name to electron-store. Installed conf 14 resolves cwd plus configName.json with path.resolve, so parent segments or absolute names escape cwd. The effect is JSON configuration read/write/clear, not arbitrary raw-file writes.

**Fix and acceptance:** Replace arbitrary names with a fixed store registry in main, validate keys and bound values. Test ../, absolute names and valid stores using temporary data only.

**Current code:** [packages/claxedo-desktop/src/main/ipc.ts](../packages/claxedo-desktop/src/main/ipc.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-8"></a>
### P-8 — Opening a file can execute it

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium, renderer prerequisite.

**What happens and why it matters:** The open-in list still includes Terminal and powershell and the path guard checks syntax rather than directory/file kind. Passing a script to its interpreter or default OS handler can execute it after renderer compromise.

**Fix and acceptance:** Separate opening directories in tools from opening documents. Require directory targets for terminal actions, and a user-confirmed OS open for executable files. Test .command, .ps1 and executable targets without running payloads.

**Current code:** [packages/claxedo-desktop/src/main/open-in-apps.ts](../packages/claxedo-desktop/src/main/open-in-apps.ts); [packages/claxedo-desktop/src/main/open-in-guard.ts](../packages/claxedo-desktop/src/main/open-in-guard.ts); [packages/claxedo-desktop/src/main/ipc.ts](../packages/claxedo-desktop/src/main/ipc.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-9"></a>
### P-9 — Beta and stable share update metadata

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium operational risk.

**What happens and why it matters:** Both builder variants publish channel latest and autoUpdater.allowDowngrade remains true. A release workflow mistake can cross-install variants or restore an older vulnerable build; an attacker cannot publish updates solely because these values exist.

**Fix and acceptance:** Publish separate channels and artifact names, disable automatic downgrades, and test each installed variant against its own signed release metadata.

**Current code:** [packages/claxedo-desktop/electron-builder.config.ts](../packages/claxedo-desktop/electron-builder.config.ts); [packages/claxedo-desktop/src/main/index.ts](../packages/claxedo-desktop/src/main/index.ts); [packages/claxedo-desktop/scripts/finalize-latest-yml.ts](../packages/claxedo-desktop/scripts/finalize-latest-yml.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-10"></a>
### P-10 — Missing MCP confirmation support silently means approval

**Original severity:** MED. **Current:** Fixed; full package checks passed. **Reassessed severity:** Medium before remediation.

**What changed:** The canonical registry requires elicitation support and an accepted answer for every destructive tool before audit/handler execution. It refuses missing support; declined, cancelled or failed elicitation never reaches the mutation. Downstream `approved: true` is emitted only by handlers reached after confirmation. Client annotations alone do not constitute approval; user audience and scopes are still enforced.

**Acceptance:** All 190 MCP package tests passed, including real HTTP/SDK absent/declined/cancelled/failed confirmation, no downstream restore/lifecycle calls, preserved sessions on refused deletion, and accepted destructive calls. Typecheck and focused lint passed. A client that itself fabricates an accepted elicitation remains constrained by user scopes; this change enforces the MCP confirmation protocol, not an independent trusted user interface.

**Current code:** [packages/claxedo-mcp/src/tools/registry.ts](../packages/claxedo-mcp/src/tools/registry.ts); [packages/claxedo-mcp/src/tools/workspaces.ts](../packages/claxedo-mcp/src/tools/workspaces.ts); [packages/claxedo-mcp/src/server.ts](../packages/claxedo-mcp/src/server.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-11"></a>
### P-11 — Runtime tools can send to sibling sessions

**Original severity:** MED. **Current:** Fixed; focused entrypoint checks passed. **Reassessed severity:** Medium, local runtime scope before the fix.

**Change:** `assertSessionReach` owns the stored-parent rule for send, abort and child question reply. Runtime send/abort admits itself or its own children in its credential's workspace. An ID collision or a foreign runtime row naming the caller as parent cannot extend that authority. User credentials retain their existing downstream authorization. Cross-machine creation still works; later control of a newly created root is not inferred from creation, and ongoing child delegation uses the existing subagent path.

**Acceptance:** Root live MCP/composition suite passed 33 tests and session/attention suite passed 38. Tests cover own-session and child positives, sibling/foreign/colliding/forged-parent denials and no prompt/abort side effects. Delegate package types and architecture ratchets passed. Seven broader local-server failures in adoption and abandoned-session retry remain tracked separately.

**Current code:** [session-reach.ts](../packages/claxedo-mcp/src/tools/session-reach.ts); [sessions.ts](../packages/claxedo-mcp/src/tools/sessions.ts); [attention.ts](../packages/claxedo-mcp/src/tools/attention.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-12"></a>
### P-12 — Host endpoint configuration trusts arbitrary schemes

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium, conditional.

**What happens and why it matters:** decodeEndpoints accepts strings for relay and authority URLs; the tunnel converts http to ws. A legitimate control plane may choose different origins, so the fix is an authenticated endpoint policy, not blindly requiring all services on one hostname.

**Fix and acceptance:** Require secure schemes and reject embedded credentials; bind endpoint updates to verified control-plane configuration. Test HTTP/JWKS substitution and approved separate service origins.

**Current code:** [packages/claxedo-host-connector/src/machine-transport.ts](../packages/claxedo-host-connector/src/machine-transport.ts); [packages/cli/src/connect/host.ts](../packages/cli/src/connect/host.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-13"></a>
### P-13 — Cloudflare WebSockets lack the Bun origin check

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Low hardening.

**What happens and why it matters:** The CF admitClient path verifies the RAT but does not apply requireAllowedOrigin. A third-party page still needs the non-ambient bearer, so this is not cookie-based WebSocket hijacking or a standalone MED authentication bypass.

**Fix and acceptance:** Share the origin policy across both adapters and test missing, trusted and hostile origins with and without a valid token.

**Current code:** [packages/workspace-relay/src/cloudflare.ts](../packages/workspace-relay/src/cloudflare.ts); [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-14"></a>
### P-14 — Bun buffers ordinary request and response bodies

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium.

**What happens and why it matters:** directHttpRequest reads non-GET bodies into memory before acquiring its limiter and buffers ordinary responses. SSE/octet-stream responses already stream, so “all responses” is too broad.

**Fix and acceptance:** Acquire capacity before reading, enforce a byte limit, and stream responses with bounded buffering. Test concurrent oversized requests and an upstream that never finishes.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts); [packages/workspace-relay/src/cloudflare.ts](../packages/workspace-relay/src/cloudflare.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-15"></a>
### P-15 — Relay forwards upstream cookie and CORS headers too broadly

**Original severity:** MED-LOW. **Current:** Partial. **Reassessed severity:** Low, conditional.

**What happens and why it matters:** Tunnel response header copying permits Set-Cookie, and CF withCors does not consistently strip upstream CORS grants. Bearer authorization is still required; ACAO alone does not give a hostile page another user's RAT. Cross-workspace cookie effects require browser/provider behavior.

**Fix and acceptance:** Strip upstream Set-Cookie and all access-control headers at the shared relay boundary, then emit only relay-owned CORS. Test both adapters and request cookie forwarding by target type.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts); [packages/workspace-relay/src/cloudflare.ts](../packages/workspace-relay/src/cloudflare.ts); [packages/workspace-relay/src/server.ts](../packages/workspace-relay/src/server.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-16"></a>
### P-16 — Invalid arrays amplify validation errors

**Original severity:** MED. **Current:** Fixed; task HTTP proof. **Reassessed severity:** Medium before remediation.

**What changed:** The existing array reader checks `TASKS_BOUNDS` before returning plugin, skill or attachment entries to the decoder. An excessive array produces `too_many` without visiting its elements. The canonical field collector stops allocating diagnostics after 64 entries while retaining the invalid result. No partial array is admitted and existing contract limits are unchanged.

**Acceptance:** Throwing element getters prove over-limit arrays are not decoded. Valid plugin/skill arrays at the limits retain every entry. Actual task HTTP requests below the body-byte cap with 1,000 empty plugins return one error; arrays within the count cap but with many invalid fields return at most 64. No preset or session is created. `bun test src` in `packages/claxedo-tasks` passed all 245 tests; package typecheck, five-file oxlint, scoped diff checks and root architecture ratchets passed.

**Current code:** [shared reader and diagnostic collector](../packages/claxedo-tasks/src/validation.ts); [capability decoder](../packages/claxedo-tasks/src/decode.ts); [request parser](../packages/claxedo-tasks/src/http/parse.ts); [HTTP regressions](../packages/claxedo-tasks/src/http/routes.test.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-17"></a>
### P-17 — Expired wakes can fire before the sweep

**Original severity:** MED. **Current:** Fixed in the working tree; focused regression checks passed. **Reassessed severity:** Medium for approvals.

**Original mechanism:** resolve checks state expired but not expiresAt; deliverEvent finds pending rows without an expiry predicate. A stale pending approval can therefore execute after its intended deadline.

**Initial acceptance requirement:** Check the authoritative deadline inside the same compare-and-swap that fires the wake. Test just-before, at, and after expiry without running the periodic sweeper.

**Current code:** [packages/wakes/src/wakes.ts](../packages/wakes/src/wakes.ts); [packages/wakes/src/sqlite-store.ts](../packages/wakes/src/sqlite-store.ts); [packages/claxedo-server/src/deployments/hosted-workerd/wake-lane.cf.ts](../packages/claxedo-server/src/deployments/hosted-workerd/wake-lane.cf.ts). [Concept walkthrough D](#flow-d).

**Remediation:** See [remediation progress](#remediation-progress) for implementation and verification scope.

<a id="finding-p-18"></a>
### P-18 — Event delivery has no workspace argument

**Original severity:** MED (design). **Current:** Latent. **Reassessed severity:** Informational now; Medium if exposed.

**What happens and why it matters:** deliverEvent broadcasts by eventKey across pending rows. An external cross-tenant event ingress was not found, so the original MED is a future integration risk.

**Fix and acceptance:** Make workspace/tenant identity part of the event contract before exposing ingress. Test two workspaces using the same event key and ensure only the addressed one receives payload text.

**Current code:** [packages/wakes/src/wakes.ts](../packages/wakes/src/wakes.ts); [packages/claxedo-server/src/session/machine-wakes.ts](../packages/claxedo-server/src/session/machine-wakes.ts). [Concept walkthrough G](#flow-g).

<a id="finding-p-19"></a>
### P-19 — Telemetry exports raw exception text

**Original severity:** MED. **Current:** Latent. **Reassessed severity:** Informational now.

**What happens and why it matters:** withSpan records exception messages and the exporter serializes them. Searches found no production importers of this telemetry package. The data-handling concern is real but the reported production MED exposure is not established.

**Fix and acceptance:** Define allowed attributes and redact at event production/export before adoption. Test credential-bearing URLs and error bodies with synthetic values.

**Current code:** [packages/claxedo-telemetry/src/tracer.ts](../packages/claxedo-telemetry/src/tracer.ts); [packages/claxedo-telemetry/src/span.ts](../packages/claxedo-telemetry/src/span.ts); [packages/claxedo-telemetry/src/exporter.ts](../packages/claxedo-telemetry/src/exporter.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-20"></a>
### P-20 — HTTP introspection can trust forged authorization claims

**Original severity:** MED. **Current:** Implemented; focused checks passed (see [remediation progress](#remediation-progress)). **Reassessed severity:** High, conditional.

**Original mechanism (before remediation):** createHttpTokenVerifier sends the bearer in a JSON body and trusts the configured endpoint response without requiring HTTPS. A network attacker on an insecure configured link can replace claims, not just read a token.

**Fix and acceptance:** Require HTTPS outside explicit loopback development, refuse redirects, and validate claims and expiry locally after introspection. Test insecure endpoint rejection before sending any token.

**Current code:** [packages/workspace-relay-protocol/src/token-verifier.ts](../packages/workspace-relay-protocol/src/token-verifier.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-21"></a>
### P-21 — Channel reset runs before per-session authorization

**Original severity:** MED. **Current:** Fixed; focused checks passed. **Reassessed severity:** Medium before remediation.

**What changed:** Status and new-session commands now run after channel authorization. The signed server uses the existing dispatcher's private-session admission before either command touches the bound session. Abort still rechecks authority at its own entrypoint, and a refused or failed abort cannot clear the thread binding or report reset success.

**Acceptance:** All 182 channel-package tests and 31 ingress/dispatcher tests passed, including two allowed senders sharing a thread, denied status/reset with the binding preserved, canonical actor/session admission, owner success and cancellation failure. Channel/server typechecks and focused lint passed. The permission checks reuse the dispatcher rather than a second session-ownership policy.

**Current code:** [packages/claxedo-channels/src/core/command-emit.ts](../packages/claxedo-channels/src/core/command-emit.ts). [Concept walkthrough G](#flow-g).

<a id="finding-p-22"></a>
### P-22 — Device-login URL reaches the Windows command shell

**Original severity:** MED. **Current:** Partial; source remediated, native acceptance open. **Reassessed severity:** Medium, conditional.

**Change:** Both device verification URLs are checked before printing or launching against HTTP(S) origins declared by the deployment descriptor. App and control-plane origins may differ. The CLI's URL launcher uses rundll32 on Windows instead of cmd/start; the URL travels as data. There is no compatibility shell branch.

**Acceptance:** The delegate ran 90 CLI tests and CLI typecheck. Root's focused device-login/launcher tests, lint and aggregate architecture ratchets pass. Independent Devin review verified the shell/URL boundary and found a descriptor-driven plaintext issuer downgrade. That correction is implemented: descriptor endpoints require HTTPS except canonical loopback, and both HTTP request owners refuse redirects. Root ran all 98 CLI tests and a real two-server Bun redirect probe: bearer and OAuth requests refused a 307 and the destination received zero requests. A separate persisted OAuth-client identity field is also required to replace the display-identity discriminator. An actual Windows browser launch with ampersands, quotes and a long query remains unverified; recorded argv alone does not prove the native behavior.

**Current code:** [device flow](../packages/cli/src/auth/device-code.ts); [descriptor validation](../packages/cli/src/auth/auth-descriptor.ts); [URL launcher](../packages/cli/src/open-url.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-23"></a>
### P-23 — Web openLink does not validate schemes

**Original severity:** MED-LOW. **Current:** Partial. **Reassessed severity:** Medium, potential XSS.

**What happens and why it matters:** The web entry still passes URLs to window.open without a shared scheme gate; one integration dialog adds noopener but not scheme validation. The report's exact claim of execution in the current app document needs a browser-specific reproduction.

**Fix and acceptance:** Use one platform URL opener that accepts intended schemes and sets noopener/noreferrer. Test dangerous schemes and ordinary OAuth URLs through each actual caller.

**Current code:** [packages/claxedo-app/src/app/entry/main.tsx](../packages/claxedo-app/src/app/entry/main.tsx); [packages/claxedo-app/src/app/entry/local.tsx](../packages/claxedo-app/src/app/entry/local.tsx); [packages/claxedo-app/src/app/dialogs/connect-integration.tsx](../packages/claxedo-app/src/app/dialogs/connect-integration.tsx). [Concept walkthrough E](#flow-e).

<a id="finding-p-24"></a>
### P-24 — Bootstrap local information is intentionally local

**Original severity:** MED-LOW. **Current:** Partial. **Reassessed severity:** Low locally; signed remote leak resolved.

**What happens and why it matters:** An unsigned local bootstrap still includes machine paths and project metadata. Signed deployments now return only a declaration to an anonymous caller. The old remote reconnaissance claim is no longer correct.

**Fix and acceptance:** Keep anonymous signed bootstrap minimal and protect rich local bootstrap with the same app capability as S-1. Test both deployment postures.

**Current code:** [packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts](../packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-25"></a>
### P-25 — Deep links can register a caller-named project

**Original severity:** MED-LOW. **Current:** Present. **Reassessed severity:** Low, user interaction required.

**What happens and why it matters:** route-bridge accepts open-project/new-session deep links and starts the local project-open flow. The protocol is allowed by transcript links. This is not automatic command execution; opening a sensitive directory and prompt seeding are distinct from submitting a turn.

**Fix and acceptance:** Confirm externally initiated project registration with the resolved directory visible; never auto-submit a deep-link prompt. Test first-time sensitive paths and already-open projects.

**Current code:** [packages/claxedo-app/src/app/workbench/state/route-bridge.tsx](../packages/claxedo-app/src/app/workbench/state/route-bridge.tsx); [packages/ui/src/context/marked.tsx](../packages/ui/src/context/marked.tsx); [packages/claxedo-desktop/src/main/navigation-guard.ts](../packages/claxedo-desktop/src/main/navigation-guard.ts). [Concept walkthrough E](#flow-e).

<a id="finding-p-26"></a>
### P-26 — Browser registry accepts non-guest webContents

**Original severity:** MED-LOW. **Current:** Present. **Reassessed severity:** Medium, renderer prerequisite.

**What happens and why it matters:** The registry checks existence and duplicate pane ownership but does not establish that the id belongs to the intended guest webview. The sender guard still limits who can call IPC.

**Fix and acceptance:** Record guest ownership in main when the webview attaches and require that relation on registration. Test attempts to register the main window and another pane's guest.

**Current code:** [packages/claxedo-desktop/src/main/ipc.ts](../packages/claxedo-desktop/src/main/ipc.ts); [packages/claxedo-desktop/src/main/browser/handle.ts](../packages/claxedo-desktop/src/main/browser/handle.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-27"></a>
### P-27 — Some channel identities use usernames

**Original severity:** MED-LOW. **Current:** Partial; stable identity and persisted boundary verified, previously issued tokens remain open. **Reassessed severity:** Medium where mutable identity is authoritative.

**Change:** GitHub, direct Telegram and the real Chat SDK bridge use platform account IDs, reject absent/synthesized sender identity and retain names only for display. SQLite authority, D1 bindings and local projection/pairing rows carry an identity version. Existing rows remain non-authorizing; explicitly approved new bindings use the current version. Active uniqueness permits fresh approval beside an inactive legacy spelling. Seed configuration uses CLAXEDO_CHANNEL_ALLOW_IDS/allowIds; the old handle setting is removed with no fallback.

**Acceptance:** Root's isolated SQLite/D1 migration run passes 36 tests, covering an old numeric handle colliding with a different stable account ID, denial before fresh approval, successful new binding, revocation and reopening. The configured server test harness now sets temporary storage before test imports, clears inherited leaf path overrides and closes the database before cleanup. A fixture missing its cloud driver was corrected to use the actual required contract; 64 channel/isolation/database/store tests now pass from fresh temporary state. Earlier transport tests covered actual installed Chat SDK and Telegram adapter behavior; real external platform webhooks are not newly claimed.

**Remaining:** Runtime access tokens issued before the boundary do not record channel provenance, so existing tokens remain active until expiry even though renewal and new channel admission are denied. A deliberate invalidation/provenance policy is required; do not invent identity mappings. The earlier channel test incident is recorded in remediation progress and cannot be described as only a schema addition.

**Current code:** [GitHub transport](../packages/claxedo-channels/src/transport/github.ts); [Telegram transport](../packages/claxedo-channels/src/transport/telegram.ts); [Chat SDK bridge](../packages/claxedo-channels/src/transport/chat-sdk-bridge.ts); [projection store](../packages/claxedo-server/src/channels/access-store.ts); [D1 boundary migration](../packages/claxedo-server/migrations/control-plane/0038_channel_identity_version.sql). [Concept walkthrough G](#flow-g).

<a id="finding-p-28"></a>
### P-28 — Unknown broker capability is accepted

**Original severity:** MED-LOW. **Current:** Fixed; focused refusal tests. **Reassessed severity:** Low hardening.

**What changed:** Every provider-secret delivery gate now requires explicit "native" brokering rather than refusing only the literal "none": provision(), nativeProviderDeliveries, sandboxBrokeredSecrets and the MCP gateway credential mint. Missing and unknown capability values refuse.

**Acceptance:** Focused tests cover missing and unknown capability values as refusals in each package. Committed as 277d073e6f.

**Current code:** [packages/sandbox-manager/src/index.ts](../packages/sandbox-manager/src/index.ts); [packages/claxedo-server-core/src/credentials/native-delivery.ts](../packages/claxedo-server-core/src/credentials/native-delivery.ts); [packages/claxedo-server/src/credentials/sandbox-delivery.ts](../packages/claxedo-server/src/credentials/sandbox-delivery.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-29"></a>
### P-29 — Host consent state and redirects need stronger boundaries

**Original severity:** MED-LOW. **Current:** Partial. **Reassessed severity:** Low-Medium, conditional.

**What happens and why it matters:** scopeRevision remains process-local and postJson follows redirects. Restart alone does not let an attacker forge a trusted HTTPS response; the scope replay claim needs that extra control. Consent removal must also remain withdrawn when an assignment is redelivered.

**Fix and acceptance:** Persist the accepted scope revision and explicit refusal state, and refuse credential-bearing redirects. Test restart with an old response and redelivery after unack.

**Current code:** [packages/claxedo-host-connector/src/connector.ts](../packages/claxedo-host-connector/src/connector.ts); [packages/cli/src/connect/host.ts](../packages/cli/src/connect/host.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-30"></a>
### P-30 — Provisioner availability comes from deployment credentials

**Original severity:** MED-LOW. **Current:** Not a standalone bug. **Reassessed severity:** Informational.

**What happens and why it matters:** The sandbox contract reads configured environment credentials. That is an operator configuration mechanism, not user authorization. A defect exists only when a caller can spend those credentials without the separate workspace admission checks.

**Fix and acceptance:** Keep provisioner configuration separate from caller authorization and align environment names. Test unauthorized creation at the public route; see P-90 and P-97 for admission gaps.

**Current code:** [packages/sandbox-contract/src/index.ts](../packages/sandbox-contract/src/index.ts); [packages/claxedo-server/src/workspace/routes/index.ts](../packages/claxedo-server/src/workspace/routes/index.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-31"></a>
### P-31 — Guest content can influence prompt context

**Original severity:** LOW. **Current:** Partial. **Reassessed severity:** Low.

**What happens and why it matters:** The browser pane validates payload shape but does not bind every guest message to an active inspection interaction/navigation generation. A guest page is untrusted text even if a preload forwards it. This is not proof that guest JavaScript can directly call privileged main IPC.

**Fix and acceptance:** Track guest identity, navigation generation and active pick state; require user acceptance before adding context. Gate navigated schemes and test messages from stale pages.

**Current code:** [packages/claxedo-app/src/features/browser/components/browser-pane.tsx](../packages/claxedo-app/src/features/browser/components/browser-pane.tsx); [packages/claxedo-app/src/features/browser/components/browser-url.ts](../packages/claxedo-app/src/features/browser/components/browser-url.ts). [Concept walkthrough E](#flow-e).

<a id="finding-p-32"></a>
### P-32 — Auth and attachment writes lack some filesystem protections

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low; secret exposure conditional.

**What happens and why it matters:** Codex auth writes use mode on create but do not repair existing permissions or prevent symlink following. Attachment containment is lexical, and Pi evaluator arguments include prompt material. A pre-existing private parent directory may reduce exposure.

**Fix and acceptance:** Use atomic writes in private verified directories, explicitly set existing modes, resolve attachment parents securely, cap bytes and pass prompts through stdin. Test pre-existing permissive files and symlinked parents.

**Current code:** [packages/agent-sdk-runtime/src/harnesses/codex/auth-file.ts](../packages/agent-sdk-runtime/src/harnesses/codex/auth-file.ts); [packages/agent-sdk-runtime/src/harnesses/shared/prompt-attachments.ts](../packages/agent-sdk-runtime/src/harnesses/shared/prompt-attachments.ts); [packages/agent-sdk-runtime/src/harnesses/pi/driver.ts](../packages/agent-sdk-runtime/src/harnesses/pi/driver.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-33"></a>
### P-33 — ACP Windows arguments are interpreted by a shell

**Original severity:** LOW. **Current:** Present/latent. **Reassessed severity:** Low, configuration-dependent.

**What happens and why it matters:** ACP accepts configured arguments and uses shell:true for shims. Codex's related fixed-argument case is latent. If the same trusted actor can choose the entire executable, this is not a new privilege boundary by itself.

**Fix and acceptance:** Use real executables or robust platform launch handling and preserve each argument literally. Test metacharacters and paths with spaces under Windows.

**Current code:** [packages/agent-sdk-runtime/src/harnesses/acp/transport.ts](../packages/agent-sdk-runtime/src/harnesses/acp/transport.ts); [packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.ts](../packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-34"></a>
### P-34 — Several relay lifecycle bugs were grouped together

**Original severity:** LOW. **Current:** Mixed. **Reassessed severity:** Medium for buffering; Low for other parts.

**What happens and why it matters:** The AND queue bound remains. CF now does enforce a cumulative tunnel response cap, contradicting that part of the old row. Timer and region issues have separate IDs; stale-socket dispatch and rejected room-cache recovery need targeted lifecycle reproduction.

**Fix and acceptance:** Track P-107, P-128, P-129 and P-130 separately. Reject frames from replaced sockets and evict rejected room initialization promises; test reconnect races and recovery after initialization failure.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts); [packages/workspace-relay/src/cloudflare.ts](../packages/workspace-relay/src/cloudflare.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-35"></a>
### P-35 — Broker work is not independently bounded

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low-Medium.

**What happens and why it matters:** The broker verifies token/binding but upstream work inherits only request cancellation and has no own concurrency budget. The non-Bearer dual-header case does not forward the foreign credential, so it is not established credential confusion.

**Fix and acceptance:** Add timeouts and concurrency limits around authority resolution and upstream fetch; reject conflicting credential presentations. Test a hanging authority and slow upstream with valid synthetic bindings.

**Current code:** [packages/egress-broker/src/broker.ts](../packages/egress-broker/src/broker.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-36"></a>
### P-36 — Workspace fallback and session audit issues differ

**Original severity:** LOW. **Current:** Fixed; focused tests. **Reassessed severity:** Low.

**What changed:** Every reader that launders an explicit-but-empty or ||-collapsed workspace id into undefined now uses ?? so an explicit id fails closed at the store. Both /api/workspace/create handlers reject a repoUrl outside http(s)/ssh/scp forms with 400 repo_url_invalid via the shared safeRepoUrl in the sandbox contract, and session_create records the created session id through addressed().

**Acceptance:** Focused tests cover stale/empty ids, the events aggregate distinction, repo_url_invalid in both create handlers, the safeRepoUrl admit/refuse tables and the audit record. Landed inside 3b8650bfcb.

**Current code:** [packages/claxedo-local-server/src/workspace/runtime-dispatch/internals.ts](../packages/claxedo-local-server/src/workspace/runtime-dispatch/internals.ts); [packages/claxedo-mcp/src/tools/sessions.ts](../packages/claxedo-mcp/src/tools/sessions.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-37"></a>
### P-37 — Tracing configuration is not a consent boundary

**Original severity:** LOW. **Current:** Latent. **Reassessed severity:** Informational now.

**What happens and why it matters:** A sampled parent can cause recording when a sink exists, and attributes/tracestate are passed through. No production importers were found. Sampling is ordinarily a tracing choice; it should not be used as the privacy opt-out.

**Fix and acceptance:** Apply consent before constructing/enabling the exporter, then validate and bound attributes and trace state. Test sampled inbound requests when consent is disabled.

**Current code:** [packages/claxedo-telemetry/src/tracer.ts](../packages/claxedo-telemetry/src/tracer.ts); [packages/claxedo-telemetry/src/trace-context.ts](../packages/claxedo-telemetry/src/trace-context.ts); [packages/claxedo-telemetry/src/span.ts](../packages/claxedo-telemetry/src/span.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-38"></a>
### P-38 — Protocol validators accept more than transport policy should

**Original severity:** LOW. **Current:** Fixed; focused protocol and adapter tests. **Reassessed severity:** Low; authentication impact conditional.

**What changed:** isCloseCode now requires the wire-legal 1000-4999 range minus the reserved 1004/1005/1006/1015, and isTunnelHeaderMap validates field-name grammar. Every Headers-to-wire merge builds on Object.create(null) so legal __proto__/constructor names survive as data.

**Acceptance:** Protocol tests cover reserved and out-of-range codes and illegal names; adapter and host-tunnel tests cover drop-then-legal close behaviour and __proto__ surviving the real merge. Committed as 4bca0a992f.

**Current code:** [packages/workspace-relay-protocol/src/token-verifier.ts](../packages/workspace-relay-protocol/src/token-verifier.ts); [packages/workspace-relay-protocol/src/index.ts](../packages/workspace-relay-protocol/src/index.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-39"></a>
### P-39 — Event projection accepts unbounded identifiers and raw data

**Original severity:** LOW. **Current:** Fixed; focused checks passed. **Reassessed severity before fix:** Low availability; disclosure conditional.

**Change:** The ACP session's wire-keyed stores (`tools`, `assistantTextByMessageId`, `assistantThinkingByMessageId`) and the client-presentation projection's per-call stores (`partIdMap` and the `tool*ByCallId` maps) are `Map`s, so `__proto__`/`constructor`/`toString` ids read as ordinary absent entries instead of inherited members or prototype writes. Retained state is bounded: 256 tools and 256 message texts per session, 256 items per tool's content/locations/dedupe lists, 256 tool calls and 1024 part ids per projection; the oldest entries evict, so snapshot clones stay bounded. `metadata.acp` now carries only the derived view consumers read (intent, presentation fields, paths, status) and no longer copies `rawInput`, `rawOutput`, `_meta`, `stats`, `body` or the accumulated `content` array; error/output extraction reads `ToolState.rawOutput` directly. The runtime stamps `raw` only on the diagnostic-surface event types (`diagnostic`, `harness-notice`, `auth-status`, `rate-limit`, `mcp-server-status`) whose consumers forward it, instead of every event a provider frame produces.

**Acceptance:** New regression tests drive `__proto__`/`constructor`/`toString` through `toolCallId` and `messageId` as ordinary keys, fill tool and message stores past the bound and assert the oldest evicted, and assert delivered events carry no `raw` frame and no raw fields in `metadata.acp`. 266 package tests, package typecheck, focused oxlint and architecture ratchets passed.

**Current code:** [packages/agent-event-runtime/src/core/projection.ts](../packages/agent-event-runtime/src/core/projection.ts); [packages/agent-event-runtime/src/harnesses/acp/state.ts](../packages/agent-event-runtime/src/harnesses/acp/state.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-40"></a>
### P-40 — Runtime type guards and maps accept unexpected values

**Original severity:** LOW. **Current:** Fixed; contract and consumer checks passed. **Reassessed severity before fix:** Low.

**Change:** `canonicalToolName` and every string-keyed lookup consumer (`usageWindowName`, `codexWindowName`, the Claude `rateLimitType` lookup, and the token-tracker `AGENT_LABEL` table) now use `Object.hasOwn`, so `constructor`/`__proto__`/`toString`/`hasOwnProperty` read as absent. `isAgentContentPart` validates a file part's `url` scheme (data/file/http/https or relative only, with URL-parser whitespace/tab normalization) and requires a completed tool's `attachments` to be file parts. `assertAgentExecutionBinding` no longer defaults `expected` to the binding; callers asserting completeness use the new `requireAgentExecutionBinding`, while the explicit two-argument ownership checks are unchanged.

**Acceptance:** Contract tests cover all four prototype keys, unsafe and whitespace-obfuscated `file.url` schemes, and malformed attachments; consumer tests cover prototype-keyed harness/slot/rate-limit ids and `adapter.getMessages` refusing a `javascript:` file part and `attachments: [{}]` as `invalid_response`. 89 contract tests, 55 Claude adapter tests, 9 server-core usage-window tests, 10 token-tracker tests, 22+53 opencode adapter tests, 101 session-core tests and 10 session service tests passed; contract typecheck passed. Pre-existing unrelated working-tree typecheck/test failures in the parallel lane's files (acp state/projection refactor, session-core) are unchanged.

**Current code:** [packages/agent-runtime-contract/src/tool-names.ts](../packages/agent-runtime-contract/src/tool-names.ts); [packages/agent-runtime-contract/src/usage-windows.ts](../packages/agent-runtime-contract/src/usage-windows.ts); [packages/agent-runtime-contract/src/content.ts](../packages/agent-runtime-contract/src/content.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-41"></a>
### P-41 — Connection persistence and gates rely on composition

**Original severity:** LOW. **Current:** Mixed. **Reassessed severity:** Low.

**What happens and why it matters:** Credential storage happens before connection upsert without transactional compensation, so failed upsert can leave a secret behind. Route defaults are permissive, but signed compositions supply gates; that default is not proof of a public unauthenticated route.

**Fix and acceptance:** Compensate failed writes or persist both atomically, require explicit route policy, and serialize device completion. Test failed upsert, unauthorized auth-failure reports and concurrent completion.

**Current code:** [packages/claxedo-connections/src/service.ts](../packages/claxedo-connections/src/service.ts); [packages/claxedo-connections/src/routes.ts](../packages/claxedo-connections/src/routes.ts); [packages/claxedo-connections/src/impls/fetch-timeout.ts](../packages/claxedo-connections/src/impls/fetch-timeout.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-42"></a>
### P-42 — Adapter identifiers and transport metadata need validation

**Original severity:** LOW. **Current:** Mixed. **Reassessed severity:** Low; HTTP transport conditional.

**What happens and why it matters:** encodeURIComponent leaves dot-only session ids intact, allowing URL normalization to retarget within the same server. This alone does not cross origins. Error redaction and configured header policies are incomplete; Headers rejecting CR/LF is fail-closed.

**Fix and acceptance:** Validate opaque session-id grammar, constrain credential destinations and redact error/diagnostic outputs consistently. Test dot segments, redirects, invalid headers and synthetic secrets.

**Current code:** [packages/opencode-server-adapter/src/adapter.ts](../packages/opencode-server-adapter/src/adapter.ts); [packages/opencode-server-adapter/src/config.ts](../packages/opencode-server-adapter/src/config.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-43"></a>
### P-43 — CLI-generated files trust operator strings

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low; transport risk separate.

**What happens and why it matters:** The deploy command interpolates app/region into TOML and app into a filename; systemd quoting misses its own expansion rules. These are normally local operator inputs, so remote exploitation is not established. Control-plane HTTP is covered by P-3.

**Fix and acceptance:** Validate app/region identifiers, serialize TOML safely and escape systemd syntax. Test traversal-looking names, percent/dollar characters and ordinary service installation.

**Current code:** [packages/cli/src/commands/deploy.ts](../packages/cli/src/commands/deploy.ts); [packages/cli/src/connect/service.ts](../packages/cli/src/connect/service.ts); [packages/cli/src/config.ts](../packages/cli/src/config.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-44"></a>
### P-44 — Task identifiers, attachments and provenance need bounds

**Original severity:** LOW. **Current:** Mixed. **Reassessed severity:** Low.

**What happens and why it matters:** Request ids are only nonempty; attachment responses are inline and trust stored MIME. Outer security headers and accepted MIME types affect browser impact, so missing local nosniff alone is not a demonstrated XSS.

**Fix and acceptance:** Bound ids, verify allowed image bytes, stamp provenance from authenticated context and keep authorization on historical links. Test oversized ids and mislabeled attachment data through the mounted route.

**Current code:** [packages/claxedo-tasks/src/http/parse.ts](../packages/claxedo-tasks/src/http/parse.ts); [packages/claxedo-tasks/src/http/routes.ts](../packages/claxedo-tasks/src/http/routes.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-45"></a>
### P-45 — Wake APIs leave policy and concurrency to callers

**Original severity:** LOW. **Current:** Mixed. **Reassessed severity:** Low.

**What happens and why it matters:** authorize defaults to true and listForSession returns full rows. This is safe only behind a confined host. once receipts and nonfinite schedule times need independent validation; the tool caller does derive depth rather than accepting it directly from model arguments.

**Fix and acceptance:** Require explicit policy, redact approval tokens from list views, atomically claim once receipts and reject nonfinite times. Test concurrent resolution and cross-session listing.

**Current code:** [packages/wakes/src/wakes.ts](../packages/wakes/src/wakes.ts); [packages/wakes/src/tools.ts](../packages/wakes/src/tools.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-46"></a>
### P-46 — Small helper contracts fail on edge cases

**Original severity:** LOW. **Current:** Fixed; focused helper tests. **Reassessed severity:** Low correctness/hardening.

**What changed:** Document, URL and path helpers return typed invalid-reference errors, use path-relative containment, constrain URL path inputs and write private files atomically.

**Acceptance:** Focused tests cover the tightened edge cases. Committed as 895b759435.

**Current code:** [packages/claxedo-helpers/src/claxedo-document.ts](../packages/claxedo-helpers/src/claxedo-document.ts); [packages/claxedo-helpers/src/url.ts](../packages/claxedo-helpers/src/url.ts); [packages/claxedo-helpers/src/path.ts](../packages/claxedo-helpers/src/path.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-47"></a>
### P-47 — Development proxy forwards sensitive headers

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low, development-only proxy.

**What happens and why it matters:** almostnode copies incoming headers to its upstream and changes CSP; static web headers lack additional hardening. Exposure depends on actually running or deploying that development proxy.

**Fix and acceptance:** Bind the proxy to loopback, strip credentials unless explicitly needed and keep it out of production artifacts. Verify the deployed site's headers separately.

**Current code:** [packages/claxedo-web/almostnode/server.js](../packages/claxedo-web/almostnode/server.js). [Concept walkthrough C](#flow-c).

<a id="finding-p-48"></a>
### P-48 — Storybook CSS writer lacks a strong request boundary

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low, development-only.

**What happens and why it matters:** The playground plugin exposes source-file writes and uses a string prefix for containment. This is a development tool, not a shipped app endpoint; the old fixture size is not evidence of leaked credentials.

**Fix and acceptance:** Require a dev capability/origin check and canonical path containment with a separator boundary. Test a sibling-prefix path and a cross-origin write attempt against the dev server.

**Current code:** [packages/storybook/.storybook/playground-css-plugin.ts](../packages/storybook/.storybook/playground-css-plugin.ts); [packages/storybook/.storybook/main.ts](../packages/storybook/.storybook/main.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-49"></a>
### P-49 — CI bootstrap executes downloaded tooling without independent verification

**Original severity:** LOW. **Current:** Present. **Reassessed severity:** Low-Medium supply-chain hardening.

**What happens and why it matters:** Several scripts trust HTTPS downloads/installers and interpolate E2E_ARGS into remote shell text. Trusted operator-supplied shell settings are not an external injection by themselves; compromised download sources or untrusted job inputs are the relevant threat.

**Fix and acceptance:** Pin versions and verify checksums/signatures, pass test arguments structurally, and constrain CI secret exposure. Test the generated remote command and reject unexpected inputs.

**Current code:** [script/cbx-ci-remote.sh](../script/cbx-ci-remote.sh); [script/cbx-e2e-shard.sh](../script/cbx-e2e-shard.sh). [Concept walkthrough F](#flow-f).

<a id="finding-p-50"></a>
### P-50 — Documents service RPC scaffold is not a working runtime

**Original severity:** INFO. **Current:** Latent. **Reassessed severity:** Informational.

**What happens and why it matters:** enqueue delegates to requireRuntime, while the inspected worker composition does not provide a runtime. A forged request cannot reach an absent implementation. Binding possession is a service trust boundary, not an end-user credential.

**Fix and acceptance:** Before enabling the runtime, validate request shape and grants at the RPC entrypoint and test disabled-service refusal and wrong installation identity.

**Current code:** [packages/claxedo-documents-service/src/service.ts](../packages/claxedo-documents-service/src/service.ts); [packages/claxedo-documents-service/src/worker.cf.ts](../packages/claxedo-documents-service/src/worker.cf.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-51"></a>
### P-51 — Renderer configuration and default-session permissions are broad

**Original severity:** INFO. **Current:** Mixed. **Reassessed severity:** Informational/Low.

**What happens and why it matters:** The IPC bridge exposes server URL persistence and display/app lookup operations; CSP and default-session permission restrictions are incomplete. Renderer code already has some intended settings powers, so this row should not be counted as multiple remote vulnerabilities.

**Fix and acceptance:** Validate persisted endpoint schemes, clamp zoom, restrict privileged browser permissions and retain sender checks. Test a compromised-renderer input model separately from normal settings UI.

**Current code:** [packages/claxedo-desktop/src/main/ipc.ts](../packages/claxedo-desktop/src/main/ipc.ts); [packages/claxedo-desktop/src/main/apps.ts](../packages/claxedo-desktop/src/main/apps.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-52"></a>
### P-52 — Type declarations do not enforce runtime values

**Original severity:** INFO. **Current:** Not a standalone security bug. **Reassessed severity:** Informational.

**What happens and why it matters:** Readonly tables remain mutable at runtime and numeric coercion can accept surprising inputs. A caller able to mutate trusted module objects already runs application code; no independent privilege escalation was shown.

**Fix and acceptance:** Freeze stable exported tables when useful and validate external revision/usage numbers as finite integers/ranges. Test malformed wire values, not trusted internal casts.

**Current code:** [packages/claxedo-service-contract/src/index.ts](../packages/claxedo-service-contract/src/index.ts); [packages/agent-runtime-contract/src/usage-windows.ts](../packages/agent-runtime-contract/src/usage-windows.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-53"></a>
### P-53 — Wake cancellation trusts possession and host scope has constraints

**Original severity:** INFO. **Current:** Partial. **Reassessed severity:** Low/Informational.

**What happens and why it matters:** cancel accepts an id or token without an internal actor check. The tool wrapper checks session ownership, so exposure depends on another unconfined caller. The old workspace_ids statement is not a current universal rule after machine assignment withdrawal changes.

**Fix and acceptance:** Make authorization explicit at exposed cancellation boundaries and test cross-session ids. Validate empty-scope withdrawal against the current machine API rather than reviving the old constraint.

**Current code:** [packages/wakes/src/wakes.ts](../packages/wakes/src/wakes.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-54"></a>
### P-54 — This row repeats MCP and relay observations

**Original severity:** INFO. **Current:** Duplicate. **Reassessed severity:** Informational.

**What happens and why it matters:** Credential-key scope invalidation is M-2, the override seam is R-3 and missing destructive confirmation is P-10. Runtime exclusion from destructive user-only tools is a defense, not a vulnerability.

**Fix and acceptance:** Track fixes under the owning IDs and avoid counting this row as three additional bugs.

**Current code:** [packages/claxedo-mcp/src/tools/registry.ts](../packages/claxedo-mcp/src/tools/registry.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-55"></a>
### P-55 — Channel approval parsing and administration need tightening

**Original severity:** INFO. **Current:** Mixed. **Reassessed severity:** Low; authorization effect conditional.

**What happens and why it matters:** Substring matching can interpret yesterday as approval. Broad webhook exemptions still rely on inner secret/admin guards, so the prefix alone is not a bypass. Approval callback access, dedup and pairing binding behavior need separate end-to-end checks.

**Fix and acceptance:** Use exact structured action values, apply the same access/rate/dedup checks on approvals, and atomically establish pairing bindings. Test ambiguous strings, repeated actions and unbound users.

**Current code:** [packages/claxedo-server-core/src/authority/deployment-mode.ts](../packages/claxedo-server-core/src/authority/deployment-mode.ts); [packages/claxedo-channels/src/core/command-emit.ts](../packages/claxedo-channels/src/core/command-emit.ts); [packages/claxedo-channels/src/transport/chat-sdk-actions.ts](../packages/claxedo-channels/src/transport/chat-sdk-actions.ts). [Concept walkthrough G](#flow-g).

<a id="finding-p-56"></a>
### P-56 — Broker response and token observations overstate some effects

**Original severity:** INFO. **Current:** Mixed. **Reassessed severity:** Low hardening; no broker bypass established.

**What happens and why it matters:** The broker strips the actual injected credential header and checks currentRuntime on each request. A token's one-hour maximum does not imply one hour of access after teardown. A jose version claim without identifying a reachable advisory is not a confirmed bug.

**Fix and acceptance:** Retain per-request runtime validation, review forwarded response headers and query credential slots, and verify specific advisories against installed use. Test teardown with an otherwise unexpired token.

**Current code:** [packages/egress-broker/src/broker.ts](../packages/egress-broker/src/broker.ts); [packages/egress-broker/src/token.ts](../packages/egress-broker/src/token.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-57"></a>
### P-57 — Shell workspace authorization was added but worktree targeting remains broad

**Original severity:** CRITICAL. **Current:** Fixed; focused checks passed. **Reassessed severity:** High residual; original Critical chain mitigated.

**What happens and why it matters:** shellWorkspaceGate requires an opened registered workspace and admin for mutations. Destructive worktree routes now resolve the exact same-project application registration and Git worktree row, reject the primary checkout including aliases, and use Git removal without a recursive filesystem fallback.

**Fix and acceptance:** Retain positive registered-worktree reset/delete and rejection of outsiders, primary aliases, descendants, .git, and rows registered on only one side.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts); [packages/claxedo-local-server/src/shell/routes.ts](../packages/claxedo-local-server/src/shell/routes.ts); [packages/claxedo-local-server/src/platform/http/control-plane-route-auth.ts](../packages/claxedo-local-server/src/platform/http/control-plane-route-auth.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-58"></a>
### P-58 — Credential discovery now requires a local request

**Original severity:** HIGH. **Current:** Resolved. **Reassessed severity:** None for original remote discovery bug.

**What happens and why it matters:** discover, save-discovered and sync-local each call isLoopbackLocalRequest before reading host credentials. The third-pass regression warning is stale at this HEAD.

**Fix and acceptance:** Keep tests at all three routes with remote, forwarded and authorized local requests. Local app authentication remains part of S-1 rather than a regression of this fix.

**Current code:** [packages/claxedo-local-server/src/credentials/routes/credential.ts](../packages/claxedo-local-server/src/credentials/routes/credential.ts); [packages/claxedo-server-core/src/credentials/operations/sync.ts](../packages/claxedo-server-core/src/credentials/operations/sync.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-59"></a>
### P-59 — Project management still trusts any signed caller too broadly

**Original severity:** HIGH. **Current:** Implemented; focused checks passed (see [remediation progress](#remediation-progress)). **Reassessed severity:** High, signed node with local execution.

**Original mechanism (before remediation):** LocalProjectRoutes lists machine-global projects, accepts a caller-named local repository and allows PATCH after signature verification without project-specific authorization. Env-name syntax validation does not make dangerous operational variable values safe.

**Fix and acceptance:** Require operator authorization for local directory import and authoritative project access for list/update. Separate tenant-owned project metadata and constrain environment policy at execution. Test two unrelated accounts.

**Current code:** [packages/claxedo-local-server/src/workspace/routes/projects-route.ts](../packages/claxedo-local-server/src/workspace/routes/projects-route.ts); [packages/claxedo-server-core/src/workspace/store/index.ts](../packages/claxedo-server-core/src/workspace/store/index.ts); [packages/claxedo-server-core/src/workspace/project-env.ts](../packages/claxedo-server-core/src/workspace/project-env.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-60"></a>
### P-60 — Runtime heartbeat can rewrite provisioner identity

**Original severity:** HIGH (CRITICAL w/ shared token). **Current:** Implemented; focused checks passed (see [remediation progress](#remediation-progress)). **Reassessed severity:** High; Critical chain conditional.

**Original mechanism (before remediation):** updateFromRuntimeSnapshot still accepts sandboxId, url, hostId and driverResourceId and substitutes current epoch when omitted. The control token is per runtime unless the shared external override is set. A holder can influence privileged lifecycle targets.

**Fix and acceptance:** Keep lease identity owned by the provisioner; accept health/activity only, require epoch and reject identity changes. Test each field with a token for A and a target belonging to B.

**Current code:** [packages/claxedo-server/src/authority/http/protocol.ts](../packages/claxedo-server/src/authority/http/protocol.ts); [packages/claxedo-server/src/authority/http/runtime-status.ts](../packages/claxedo-server/src/authority/http/runtime-status.ts); [packages/sandbox-manager/src/index.ts](../packages/sandbox-manager/src/index.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-61"></a>
### P-61 — Checked path and forwarded path are different

**Original severity:** HIGH. **Current:** Fixed; focused tunnel checks passed. **Reassessed severity:** Medium, malicious-relay prerequisite.

**Change and evidence:** Root reproduced raw and encoded dot segments and backslashes escaping `/workspaces/:id` after the normalized admission check. The common tunnel target resolves the path and query before HTTP/WebSocket forwarding. Desktop and server composers construct the workspace URL from the same resolved path they inspect. Root's 64 surface/serving, 39 runtime relay, 9 server tunnel and 9 daemon tunnel tests pass, including ordinary raw-file/PTY flows. The malicious/nonconforming relay prerequisite remains the accurate reachability limit.

**Current code:** [packages/claxedo-host-serving/src/surface.ts](../packages/claxedo-host-serving/src/surface.ts); [packages/claxedo-host-serving/src/serving.ts](../packages/claxedo-host-serving/src/serving.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-62"></a>
### P-62 — Runtime git now uses buildSafeEnv

**Original severity:** HIGH. **Current:** Resolved. **Reassessed severity:** None for original runtime git env leak.

**What happens and why it matters:** GIT_ENV is built from buildSafeEnv instead of raw process.env. The fix covers this runGit owner, not every git invocation elsewhere in the repository.

**Fix and acceptance:** Retain environment assertions for the actual git spawn and audit the daemon sibling separately under P-131. Test a synthetic hook sees no internal credential.

**Current code:** [packages/workspace-runtime/src/git.ts](../packages/workspace-runtime/src/git.ts); [packages/workspace-runtime/src/managed-processes/manager.ts](../packages/workspace-runtime/src/managed-processes/manager.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-63"></a>
### P-63 — Bare PTY proxy now has a loopback gate

**Original severity:** MED-HIGH. **Current:** Resolved original; see P-82. **Reassessed severity:** None for anonymous remote attach.

**What happens and why it matters:** The unscoped path checks isLoopbackLocalRequest when it has a workspace target, and relayed callers go through localWorkspacePtyRefusal. Focused attach tests pass with isolated PTY history.

**Fix and acceptance:** Keep remote-anonymous denial tests. Do not treat this as proof of per-message authorization and revocation; that residual is P-82.

**Current code:** [packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts](../packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-64"></a>
### P-64 — Workspace file APIs do not enforce private-session ownership

**Original severity:** MED. **Current:** Partial; API gates verified, commit race remains. **Reassessed severity:** Medium; High for sensitive cross-session files.

**Change:** File/diff/Git routes now derive every private owner from canonical worktree registrations and use existing session authority. Recursive paths also check descendant owners; listing/diff/status exclude denied owners and rename sources. Git pathspec inputs are literal. Authorization uses the same path spelling as execution, preserving exact filenames where Git diff does. Co-located registrations retain every owner's denial. The policyless lazy diff singleton and unused file-route resolver hook were removed.

**Acceptance so far:** Root first reproduced ancestor staging (204), whitespace file-content disclosure (200), wildcard private-patch disclosure, duplicate-owner filename disclosure, and a second exact-whitespace diff disclosure. The corrected mounted HTTP suite and neighboring diff/Git/target tests pass together: 71 tests. Runtime typecheck, focused lint and architecture ratchets passed. Legitimate shared/owner access still works, while stage/unstage, commit/amend and push are checked against affected private paths.

**Remaining:** Commit-staged holds the canonical process-local Git write lock and rejects an index change while authority answers. An external process can still change the index after the final recheck and before `git commit`; immutable content binding is required to close that race. API gating does not isolate processes sharing the host filesystem. The listing filter now receives explicit filesystem/repository path bases; a failed Git-root lookup fails closed instead of substituting the served directory. Nongit filesystem listing remains supported, with focused failure and sibling-path tests.

**Current code:** [worktree target access](../packages/workspace-runtime/src/routes/worktree-target-access.ts); [Git routes](../packages/workspace-runtime/src/routes/git-worktree.ts); [target owner](../packages/workspace-runtime/src/target.ts); [mounted regression tests](../packages/workspace-runtime/src/workspace/worktree-file-access.test.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-65"></a>
### P-65 — Stored resource workspace now controls authorization

**Original severity:** MED. **Current:** Resolved. **Reassessed severity:** None for original selector-precedence bug.

**What happens and why it matters:** Session metadata PUT and network-policy PUT first authorize the existing stored workspace, then separately authorize a different requested workspace. A caller cannot substitute a workspace it owns for the victim's stored workspace.

**Fix and acceptance:** Retain tests for same-workspace update, forbidden foreign resource, and authorized/unauthorized rebind. Use this pattern for other resource updates.

**Current code:** [packages/claxedo-local-server/src/session/routes/meta-routes.ts](../packages/claxedo-local-server/src/session/routes/meta-routes.ts); [packages/claxedo-local-server/src/sandbox/network/network-policy-routes.ts](../packages/claxedo-local-server/src/sandbox/network/network-policy-routes.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-66"></a>
### P-66 — Anonymous signed bootstrap is a minimal declaration

**Original severity:** MED. **Current:** Resolved. **Reassessed severity:** None for original signed bootstrap leak.

**What happens and why it matters:** BootstrapRoutes now uses unauthenticatedDeclarationBody when the server declares sessions. It exposes deployment metadata needed for login, not home directory/project inventory.

**Fix and acceptance:** Test exact anonymous response fields and signed/local rich bootstrap separately. Do not require login merely to learn the authentication posture.

**Current code:** [packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts](../packages/claxedo-local-server/src/deployments/shared-routes/bootstrap.ts); [packages/claxedo-server-core/src/authority/deployment-mode.ts](../packages/claxedo-server-core/src/authority/deployment-mode.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-67"></a>
### P-67 — MCP discovery's private-network predicate is incomplete

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium.

**What happens and why it matters:** isPrivateAddress uses string/range checks and does not resolve DNS or normalize embedded IPv4 forms. HTTPS does not prevent SSRF to private services. The latest call sites do use discoverMcpOAuth; the old “skip entirely” claim should not be assumed.

**Fix and acceptance:** Use canonical IP parsing and enforce destination policy at connection time and every redirect, with DNS rebinding protection. Test mapped IPv6, private DNS results and allowed public endpoints.

**Current code:** [packages/claxedo-server-core/src/agent-plugins/mcp/discovery.ts](../packages/claxedo-server-core/src/agent-plugins/mcp/discovery.ts); [packages/claxedo-server/src/agent-plugins/mcp/catalog-auth.ts](../packages/claxedo-server/src/agent-plugins/mcp/catalog-auth.ts); [packages/claxedo-server/src/agent-plugins/mcp/runtime-preparation.ts](../packages/claxedo-server/src/agent-plugins/mcp/runtime-preparation.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-68"></a>
### P-68 — Some transcript anchors bypass URL filtering

**Original severity:** MED. **Current:** Partial. **Reassessed severity:** Low confirmed hardening; Medium XSS unconfirmed.

**What happens and why it matters:** FilePartDisplay binds part.url directly and the click helper returns without preventing an invalid scheme. However this file anchor has target=_blank and noopener; the report does not prove javascript execution in the existing app document. Other tool-link targets need browser-specific tests.

**Fix and acceptance:** Filter before assigning href and prevent default on rejected schemes, including modified clicks via inert hrefs. Test each actual anchor in browser and packaged Electron.

**Current code:** [packages/session-ui/src/components/message-part.tsx](../packages/session-ui/src/components/message-part.tsx); [packages/session-ui/src/components/transcript-link.ts](../packages/session-ui/src/components/transcript-link.ts). [Concept walkthrough E](#flow-e).

<a id="finding-p-69"></a>
### P-69 — Markdown renderer returns unsafe raw HTML attributes

**Original severity:** MED. **Current:** Partial. **Reassessed severity:** Low in current app; Medium for unsanitized consumers.

**What happens and why it matters:** The custom renderer interpolates href/title without attribute escaping. Current consumers sanitize generated HTML, so the raw builder defect is not a demonstrated app XSS. Theme textContent writes can inject CSS rules but are not automatically HTML/script execution.

**Fix and acceptance:** Escape attributes and allowlist link schemes at the shared builder; keep final sanitization. Validate theme token names/values and test hostile markup through the real consumer.

**Current code:** [packages/ui/src/context/marked.tsx](../packages/ui/src/context/marked.tsx); [packages/ui/src/theme/parse.ts](../packages/ui/src/theme/parse.ts); [packages/ui/src/theme/loader.ts](../packages/ui/src/theme/loader.ts). [Concept walkthrough E](#flow-e).

<a id="finding-p-70"></a>
### P-70 — Exe environment names become shell syntax

**Original severity:** MED. **Current:** Latent. **Reassessed severity:** Low; Medium for unsafe embedders.

**What happens and why it matters:** The exe driver quotes values but interpolates keys. Current projectEnv validates key grammar, so that producer blocks the example payload. Other embedders could supply malformed keys.

**Fix and acceptance:** Validate environment names at the driver boundary too and remove the duplicate unused shell builder. Test invalid names without invoking a real provider.

**Current code:** [packages/sandbox-manager/src/drivers/exe.ts](../packages/sandbox-manager/src/drivers/exe.ts); [packages/sandbox-manager/src/command.ts](../packages/sandbox-manager/src/command.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-71"></a>
### P-71 — Provider command strings contain secrets

**Original severity:** MED-LOW. **Current:** Present. **Reassessed severity:** Low-Medium, provider logging dependent.

**What happens and why it matters:** Exe and Box serialize runtime env into exec command text; Box also embeds registry-login material. The provider already executes the workload, but command logs and process listings can widen access and retention.

**Fix and acceptance:** Use provider secret/env APIs or private files/stdin, avoid secrets in command strings and redact diagnostics. Test generated payloads with synthetic secrets and inspect provider log policy separately.

**Current code:** [packages/sandbox-manager/src/drivers/exe.ts](../packages/sandbox-manager/src/drivers/exe.ts); [packages/sandbox-manager/src/drivers/box.ts](../packages/sandbox-manager/src/drivers/box.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-72"></a>
### P-72 — Cloning and initial network policy allow caller-selected hosts

**Original severity:** MED-LOW. **Current:** Present. **Reassessed severity:** Medium, signed clone access.

**What happens and why it matters:** The clone boundary admits HTTP/SSH/scp hosts. Hosted source setup also derives initial egress needs from the repository URL. This permits network reachability, not arbitrary metadata-response exfiltration in every Git protocol.

**Fix and acceptance:** Apply one canonical repository admission policy before both clone and network-policy generation. Test internal IPs, redirects and explicitly approved private Git servers.

**Current code:** [packages/claxedo-local-server/src/workspace/routes/projects-route.ts](../packages/claxedo-local-server/src/workspace/routes/projects-route.ts); [packages/claxedo-server/src/routes/hosted/workspace.ts](../packages/claxedo-server/src/routes/hosted/workspace.ts); [packages/sandbox-manager/src/hosted-network-policy.ts](../packages/sandbox-manager/src/hosted-network-policy.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-73"></a>
### P-73 — Some GETs still create state or disclose inventory

**Original severity:** MED-LOW. **Current:** Partial. **Reassessed severity:** Low.

**What happens and why it matters:** The local resolve route and agent paths retain creation behavior. Signed shell agent requests are now gated, and signed workspace listing uses authority paths; the original blanket claim about all inventories is too broad. LocalProjectRoutes remains machine-global.

**Fix and acceptance:** Move creation to an explicit authorized POST and scope each inventory at its owner. Test repeated GETs leave storage unchanged and unrelated users see no machine project list.

**Current code:** [packages/claxedo-local-server/src/workspace/routes/resolve-route.ts](../packages/claxedo-local-server/src/workspace/routes/resolve-route.ts); [packages/claxedo-local-server/src/shell/routes.ts](../packages/claxedo-local-server/src/shell/routes.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-74"></a>
### P-74 — Several runtime routes parse unbounded JSON

**Original severity:** LOW. **Current:** Partial; body limits and identity checks verified, public health contract open. **Reassessed severity:** Medium for body DoS; Informational health.

**Change:** Session, checkpoint, worktree and Git routes use the canonical bounded reader before their effects. The duplicate document JSON reader and error class are deleted; strict document parsing shares the same byte-accounting and cancellation owner while retaining required-body, malformed-JSON and fatal UTF-8 validation. Process lease labels and PTY environment/observer identity come from the runtime's assigned workspace. Caller headers and PTY environment fields cannot supply that identity; without an assigned ID, the observer uses its real directory and no workspace ID is injected.

**Acceptance:** Root ran 107 mounted body-limit, document hydration/broker, process, target and PTY tests. Declared and chunked oversize inputs are refused, denied requests do not reach provider/store effects, malformed UTF-8 is refused, split valid UTF-8 decodes correctly, readers release their locks and forged workspace labels do not reach the PTY producer. Typecheck, focused lint, scoped diff checks and architecture ratchets pass without ceiling changes. The delegate's wider runtime run had one hook-delivery test failure that passed alone; this is an observed unresolved full-suite failure, not proof that the whole package passes or that the failure predates the change.

**Remaining:** Anonymous /global/health still exposes runtime diagnostics. Narrow public liveness and retain authenticated diagnostics only where a real consumer needs them; verify the affected daemon/runtime health flows. Native PTY and full relay acceptance were not rerun for this slice.

**Current code:** [shared reader](../packages/workspace-runtime/src/routes/http.ts); [session routes](../packages/workspace-runtime/src/routes/session-core.ts); [checkpoint routes](../packages/workspace-runtime/src/routes/checkpoint.ts); [process identity](../packages/workspace-runtime/src/routes/process.ts); [PTY identity](../packages/workspace-runtime/src/routes/pty.ts); [document hydration](../packages/workspace-runtime/src/routes/document-hydration.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-75"></a>
### P-75 — Daytona list delimiters and image arguments are not locally validated

**Original severity:** LOW. **Current:** Fixed; focused validation tests. **Reassessed severity:** Low, input-policy dependent.

**What changed:** Daytona network and domain allowlist entries are validated before joining, and sandbox image references reject empty, whitespace-containing and option-like values at the driver boundary.

**Acceptance:** Focused tests cover malformed allowlist entries and rejected image references. Committed as 077507c67e.

**Current code:** [packages/sandbox-manager/src/daytona-allow-list.ts](../packages/sandbox-manager/src/daytona-allow-list.ts); [packages/sandbox-manager/src/drivers/docker.ts](../packages/sandbox-manager/src/drivers/docker.ts); [packages/sandbox-manager/src/drivers/box.ts](../packages/sandbox-manager/src/drivers/box.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-76"></a>
### P-76 — Device polling can hold a request indefinitely

**Original severity:** LOW. **Current:** Mixed. **Reassessed severity:** Low-Medium.

**What happens and why it matters:** The pending OAuth entry has an initial TTL check, but exchangeDeviceTokens loops on pending responses without an overall deadline. ReDoS and host-serving issues duplicate S-6 and P-84.

**Fix and acceptance:** Bound total polling by the provider expiry and request cancellation, then remove pending state. Test perpetual pending, cancellation and success near expiry.

**Current code:** [packages/claxedo-local-server/src/credentials/provider-auth/service.ts](../packages/claxedo-local-server/src/credentials/provider-auth/service.ts); [packages/claxedo-local-server/src/shell/files.ts](../packages/claxedo-local-server/src/shell/files.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-77"></a>
### P-77 — Root project compatibility ignores tunnel scope

**Original severity:** LOW. **Current:** Fixed; focused tunnel checks passed. **Reassessed severity:** Low disclosure.

**Change and acceptance:** The tunnel no longer has a root project compatibility branch. Viewer and editor frames requesting inventory, current/foreign project metadata or project mutation receive tunnel-level 403 without reaching the daemon. Authorized workspace reads still pass. The daemon capability gate had already denied the former root paths in the current composition; this fix removes the second machine-root surface itself. See P-89 for the actual WebSocket/daemon fixture limits.

**Current code:** [packages/claxedo-host-serving/src/surface.ts](../packages/claxedo-host-serving/src/surface.ts); [packages/claxedo-local-server/src/shell/project-routes.ts](../packages/claxedo-local-server/src/shell/project-routes.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-78"></a>
### P-78 — Markdown math processing can rewrite attributes

**Original severity:** LOW. **Current:** Partial. **Reassessed severity:** Low; XSS unconfirmed.

**What happens and why it matters:** renderMathExpressions splits around code tags but processes other HTML as text, including attribute values. The fence branch returning token.text still exists but no reachable sanitizer bypass was demonstrated.

**Fix and acceptance:** Perform math rendering on text tokens/nodes before HTML serialization, escape raw HTML and retain sanitization. Test dollar-delimited text inside titles and code blocks.

**Current code:** [packages/ui/src/context/marked.tsx](../packages/ui/src/context/marked.tsx); [packages/ui/src/context/marked-math.ts](../packages/ui/src/context/marked-math.ts). [Concept walkthrough E](#flow-e).

<a id="finding-p-79"></a>
### P-79 — Shared card links trust their callers

**Original severity:** LOW. **Current:** Latent. **Reassessed severity:** Low hardening.

**What happens and why it matters:** Shared components bind supplied href values directly. Trusted host callbacks normally build routes, so an unsafe prop API is not a proven attack path until an untrusted caller supplies it.

**Fix and acceptance:** Centralize safe-link construction and type validated internal/external links distinctly where useful. Test malformed schemes at the component boundary.

**Current code:** [packages/session-ui/src/components/basic-tool.tsx](../packages/session-ui/src/components/basic-tool.tsx); [packages/session-ui/src/components/tool-error-card.tsx](../packages/session-ui/src/components/tool-error-card.tsx); [packages/session-ui/src/v2/components/tool-error-card-v2.tsx](../packages/session-ui/src/v2/components/tool-error-card-v2.tsx). [Concept walkthrough E](#flow-e).

<a id="finding-p-80"></a>
### P-80 — Session-app has no audited implementation

**Original severity:** INFO. **Current:** Not a finding. **Reassessed severity:** None.

**What happens and why it matters:** The old row explicitly describes a stub/no source surface. It should not count as a security bug or receive a remediation priority.

**Fix and acceptance:** No security fix. Audit the package if executable source is introduced later.

**Current code:** No current implementation at packages/session-app; original stub-only row. [Concept walkthrough H](#flow-h).

<a id="finding-p-81"></a>
### P-81 — Unsigned plugin routes are mounted in the signed server

**Original severity:** CRITICAL. **Current:** Fixed in the working tree; focused regression checks passed. **Reassessed severity:** Critical, signed network-reachable node.

**Original mechanism:** startSelfHostedServer unconditionally composes local plugins. The signed global guard steps aside and the contributed source/activation/signed-runtime routers lack authentication. Caller-supplied runtime configuration can persist executable MCP definitions for later harness launch. This pass confirms the source chain, not a live RCE deployment.

**Initial acceptance requirement:** Mount a signed operator-authorized plugin composition and authenticate all local plugin control routes, including reads. Test anonymous rejection through startSelfHostedServer's full composition and authorized plugin installation with synthetic nonexecuting artifacts.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/start.ts](../packages/claxedo-server/src/deployments/self-hosted-node/start.ts); [packages/claxedo-local-server/src/agent-plugins/activation/signed-runtime-routes.ts](../packages/claxedo-local-server/src/agent-plugins/activation/signed-runtime-routes.ts); [packages/claxedo-local-server/src/agent-plugins/activation/routes.ts](../packages/claxedo-local-server/src/agent-plugins/activation/routes.ts); [packages/claxedo-server-core/src/platform/governance/route-ownership.ts](../packages/claxedo-server-core/src/platform/governance/route-ownership.ts). [Concept walkthrough A](#flow-a).

**Remediation:** See [remediation progress](#remediation-progress) for implementation and exact verification scope.

<a id="finding-p-82"></a>
### P-82 — PTY attach now checks access but bypasses rolling write policy

**Original severity:** HIGH. **Current:** Fixed; focused checks passed. **Reassessed severity:** High residual, authorized-read prerequisite.

**What happens and why it matters:** Both PTY entrypoints now use authorizePtyAttach and createAuthorizedPtyConnection. Read admission precedes attachment and scrollback, every output send observes the read deadline, and ordered input requires a current write lease. Raw embedded attachment and duplicate route lifecycle code are removed.

**Fix and acceptance:** Retain real proxy read-only/revocation checks and deadline, queued input, close-race and invalid lease regressions. Packaged macOS acceptance remains blocked by missing remote-host configuration.

**Current code:** [packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts](../packages/claxedo-local-server/src/deployments/local/server-workspace-pty-proxy.ts); [packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts](../packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts); [packages/workspace-runtime/src/routes/pty.ts](../packages/workspace-runtime/src/routes/pty.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-83"></a>
### P-83 — Desktop relay now carries verified actors and private-session policy

**Original severity:** HIGH. **Current:** Resolved main claim. **Reassessed severity:** None for unmanaged-local relay promotion.

**What happens and why it matters:** start-local-server composes localHostRelayActor, verifyRelayIngress and localHostSessionAccessPolicy. Ingress rejects unverifiable relayed requests, and focused desktop authority tests pass. “Desktop member always equals owner” is stale; root compatibility and PTY lifetime remain separate findings.

**Fix and acceptance:** Retain the real desktop composition tests for stranger, owner, unavailable authority and forged relay token. Address P-77/P-89 and P-82 without removing the new policy.

**Current code:** [packages/claxedo-local-server/src/app/start-local-server.ts](../packages/claxedo-local-server/src/app/start-local-server.ts); [packages/claxedo-local-server/src/deployments/local/host-session-authority.ts](../packages/claxedo-local-server/src/deployments/local/host-session-authority.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-84"></a>
### P-84 — Local website can reconfigure the daemon's remote-control setup

**Original severity:** HIGH. **Current:** Partial; packaged acceptance open. **Reassessed severity:** High, hostile localhost origin.

**What changed:** the mounted local application requires its daemon capability before privileged operations. Anonymous health and separately verified runtime/MCP/broker ingress retain narrow exemptions. Electron main stamps the capability only for the registered trusted top frame and exact daemon origin, and strips it on redirects. Empty configured secrets fail composition.

**Acceptance:** Five real bundled-daemon tests and 16 real Electron boundary tests passed, covering hostile localhost requests, HTTP/WebSocket capability delivery, untrusted iframe/guest windows, navigation, redirects and file-origin behavior. Signed packaged macOS remains unverified; the required Crabbox SSH profile is not configured. Native CI portability is under review.

**Current code:** [packages/claxedo-local-server/src/workspace/host-serving-routes.ts](../packages/claxedo-local-server/src/workspace/host-serving-routes.ts); [packages/claxedo-host-serving/src/serving.ts](../packages/claxedo-host-serving/src/serving.ts); [packages/claxedo-local-server/src/app/local-app.ts](../packages/claxedo-local-server/src/app/local-app.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-85"></a>
### P-85 — Diff reads can escape through symlinks

**Original severity:** HIGH. **Current:** Partial; native parent races remain. **Reassessed severity:** High, file/symlink prerequisite.

**What happens and why it matters:** Diff/status content reads now share the secure working-tree reader. Symlinks are represented as links; final-component identity is checked; Linux verifies the opened file descriptor through /proc/self/fd. Parent-directory replacement during open remains unresolved on macOS/Windows.

**Fix and acceptance:** Complete native parent-directory confinement without a second path policy. The focused Linux lane passed 39 tests with one platform-specific skip, including the parent-swap regression. Windows validation is ongoing; packaged macOS is blocked by missing Crabbox host configuration.

**Current code:** [packages/workspace-runtime/src/workspace-files/diff.ts](../packages/workspace-runtime/src/workspace-files/diff.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-86"></a>
### P-86 — Lease rewrite can redirect later snapshot operations

**Original severity:** HIGH. **Current:** Implemented; focused checks passed (see [remediation progress](#remediation-progress)). **Reassessed severity:** High; fleet snapshot chain unverified live.

**Original mechanism (before remediation):** P-60 still lets runtime snapshots change the resource id consumed by checkpoint lifecycle. Driver snapshot/restore uses lease identity. This supports the confused-deputy risk, but deterministic-id knowledge, provider behavior and restart materialization are conditions, not proven fleet compromise in this review.

**Fix and acceptance:** Fix P-60 at the producer and verify provider targets against immutable lease ownership before checkpoint/restore/destroy. Test with a fake provider containing A and B; A's token must never invoke operations on B.

**Current code:** [packages/sandbox-manager/src/index.ts](../packages/sandbox-manager/src/index.ts); [packages/sandbox-manager/src/checkpoint-manager.ts](../packages/sandbox-manager/src/checkpoint-manager.ts); [packages/claxedo-server/src/workspace/supervisor/sandbox.ts](../packages/claxedo-server/src/workspace/supervisor/sandbox.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-87"></a>
### P-87 — Create-existing session can mutate then roll back someone else's session

**Original severity:** HIGH. **Current:** Fixed; focused checks passed. **Reassessed severity:** High, workspace editor/valid admission prerequisite.

**What happens and why it matters:** The create route validates the caller-held reservation before reading its target. Existing unreserved child identities require session-scoped authorization before configuration or adapter-model changes. Only newly created rows are removed for configuration failure. The existing identity claim now also excludes concurrent deletion, and successful explicit deletion retires only its matching startup owner; failed-start compensation keeps its diagnostic record.

**Fix and acceptance:** Retain two-user real-authority acceptance, ambiguous registration retry, preservation on configuration failure, compensation and concurrent creation tests.

**Current code:** [packages/workspace-runtime/src/routes/session-core.ts](../packages/workspace-runtime/src/routes/session-core.ts); [packages/claxedo-server-core/src/authority/adapters/sqlite/private-session-authority.ts](../packages/claxedo-server-core/src/authority/adapters/sqlite/private-session-authority.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-88"></a>
### P-88 — Any signed caller can enroll the server machine

**Original severity:** HIGH (conditional). **Current:** Fixed in the working tree; focused regression checks passed. **Reassessed severity:** High, shared signed-node deployment.

**Original mechanism:** RemoteAccessMachineRoutes delegates to enable after signed authentication; enable proves the machine key using server-held identity under that caller. It lacks an operator ownership gate. Heartbeats are now machine-signed, so “cached user bearer forever” is not the exact current mechanism.

**Initial acceptance requirement:** Require deployment-operator authorization before enrolling this process and bind the enrollment to its operator. Test two signed accounts, revocation and re-enrollment without allowing one account to take over the other's machine.

**Current code:** [packages/claxedo-server/src/routes/remote-access.ts](../packages/claxedo-server/src/routes/remote-access.ts); [packages/claxedo-server/src/deployments/self-hosted-node/remote-access-service.ts](../packages/claxedo-server/src/deployments/self-hosted-node/remote-access-service.ts). [Concept walkthrough A](#flow-a).

**Remediation:** See [remediation progress](#remediation-progress) for implementation and verification scope.

<a id="finding-p-89"></a>
### P-89 — Workspace tunnel exposes machine credential compatibility routes

**Original severity:** MED-HIGH. **Current:** Fixed; focused tunnel checks passed. **Reassessed severity:** Medium; original credential-write chain conditional.

**Change and acceptance:** Removed the root compatibility route and its configuration, auth, provider OAuth and project inventory mappings. A workspace connection now yields either refusal or its workspace surface. Real WebSocket tunnel replay into the actual daemon denies viewer/editor credential and inventory requests, leaves credentials unchanged and retains legitimate workspace reads and local account management. Root's daemon fixture passes all nine tests; it substitutes the relay/JWKS actor verifier and session-authority response explicitly, so this is not a deployed relay/signature acceptance claim. The current daemon capability gate already blocked the original credential chain; the fix makes tunnel scope independently correct.

**Current code:** [packages/claxedo-host-serving/src/surface.ts](../packages/claxedo-host-serving/src/surface.ts); [packages/claxedo-local-server/src/shell/project-routes.ts](../packages/claxedo-local-server/src/shell/project-routes.ts); [packages/claxedo-local-server/src/credentials/routes/provider-auth.ts](../packages/claxedo-local-server/src/credentials/routes/provider-auth.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-90"></a>
### P-90 — Workspace lifecycle still has signed-versus-operator gaps

**Original severity:** MED-HIGH. **Current:** Fixed; service and mounted-app verification. **Reassessed severity:** High before remediation.

**What changed:** local machine deletion and sharing require operator authority; cloud creation always runs current organization/project admission. Host-assignment admission has one canonical owner in SQLite and D1, shared by preflight and the actual assignment. `remote-access-service.assignWorkspace` applies it before enrollment and serving changes for every caller. The route's missing-owner heuristic and duplicate preflight are removed. Authority conflicts retain their typed HTTP status.

**Acceptance:** Real SQLite service tests prove revoked membership, unresolved workspace owners and non-operators produce no machine effects; authorized cold sharing succeeds. A signed operator requesting a foreign workspace through the mounted self-hosted app receives 404 with zero enrollment, assignment or request rows. Delegate suites passed 397, 493, 146 and 254 tests across the affected service/routes/adapters/core; typechecks and architecture ratchets passed. Successful mounted-app relay heartbeat is not independently proven; positive service sharing uses the actual SQLite authority and a fake tunnel. Invitation-enrolled connector assignments use their existing direct authority path, including invitation tenant resolution.

**Current code:** [remote access service](../packages/claxedo-server/src/deployments/self-hosted-node/remote-access-service.ts); [workspace routes](../packages/claxedo-server/src/workspace/routes/index.ts); [SQLite authority](../packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts); [D1 host authority](../packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-91"></a>
### P-91 — Workspace editors can invoke runtime-wide checkpoint control

**Original severity:** MED. **Current:** Fixed and verified through checkpoint HTTP. **Reassessed severity:** Medium before remediation.

**What changed:** checkpoint mutations require current workspace admin/owner authority. Embedded callbacks resolve the actor and role from SQLite on each operation instead of trusting the request-stamped role. Supervisor recovery uses the existing signed management verifier with a checkpoint-specific scope and workspace/host binding. Config and checkpoint share one verdict normalizer; invalid management headers cannot fall through to user authority.

**Acceptance:** Real SQLite plus the relay-mounted runtime proves an admin can freeze, every checkpoint mutation rejects the same token after a viewer downgrade, state remains frozen, and restoring admin authority permits resume. The runtime suite also covers supervisor grants, wrong target/scope/signature/expiry, editors/viewers, and local-owner behavior. The final embedded HTTP/SSE suite passed four tests; combined runtime stream/checkpoint checks passed 76, and server/D1 checks passed 82. Typechecks, lint and architecture ratchets passed.

**Current code:** [packages/workspace-runtime/src/routes/checkpoint.ts](../packages/workspace-runtime/src/routes/checkpoint.ts); [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts); [embedded authority integration](../packages/claxedo-server/src/deployments/self-hosted-node/embedded-host-authority.test.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-92"></a>
### P-92 — Read access to a parent can authorize child completion input

**Original severity:** MED. **Current:** Partial; parent admission and embedded wake delivery verified, remote recovery open. **Reassessed severity:** Medium.

**What changed:** Creating a child checks parent prompt authority before provider effects. Both canonical session authorities require parent `agent_turn` access when reserving a fork, before starting it and before publishing its registration. D1 also checks parent access in the reservation/registration transaction so a downgrade between the earlier read and write cannot publish a child.

**Acceptance so far:** Real SQLite and Miniflare D1 conformance proves workspace creation is available to the test actor, then denies a follow-only parent, admits a send grant, refuses startup and registration after parent revocation and succeeds after a fresh grant. A real D1 race test downgrades the share just before each batch and confirms no session row and no new reservation (or an unchanged reserved row). Runtime HTTP denies before reservation/provider creation and admits a current parent writer. SQLite: 12 passing tests; D1: all 16 tests passed together; runtime child/core routes: 137 passing tests. All three typechecks and focused lint passed.

**Wake acceptance:** The embedded path now persists the originating actor, reopens that state and reauthorizes it at delivery. Real SQLite tests show revocation prevents the parent prompt and producer row; a valid grant produces the expected actor-attributed durable transcript. Remote recovery still lacks a scoped durable proof and fails closed. P-93 tracks that remaining lifecycle work; this finding is not closed.

**Current code:** [child create route](../packages/workspace-runtime/src/routes/session-core.ts); [SQLite private-session authority](../packages/claxedo-server-core/src/authority/adapters/sqlite/private-session-authority.ts); [D1 private-session authority](../packages/claxedo-server/src/authority/adapters/d1/session-authority.ts); [shared conformance](../packages/claxedo-server-core/src/platform/auth/private-session-authority.conformance.ts). [Concept walkthrough G](#flow-g).

<a id="finding-p-93"></a>
### P-93 — Recovered and child-completion turns skip durable authority admission

**Original severity:** MED. **Current:** Partial; embedded recovery verified, remote proof missing. **Reassessed severity:** Medium availability; the embedded unleased path is closed.

**Change:** Child creation captures the verified original actor and workspace authority into the canonical `session_subagent` row, once. Wake delivery/recovery reads that origin separately from the child's display author. Managed host turns reject missing identity before provider effects, acquire the same durable turn lease used for request-driven work, and refuse an adapter-only composition that cannot enforce it. Failed provider setup releases its acquired lease instead of renewing indefinitely. Legacy rows with no origin remain pending in managed mode; no identity is synthesized.

**Acceptance:** Root's latest 99 child/queue/lease tests, 89 actual Node SQLite store checks and 15 embedded authority tests passed. Local and relayed provenance is persisted explicitly, with legacy rows remaining unknown. The combined live MCP/Tasks run now passes all 33 tests with successful teardown after correcting host-close/event-pump ordering and awaiting iterator cleanup. Eleven focused shutdown/event-pump tests cover pending startup, pending reads, host failure and pending iterator cleanup. Broader platform acceptance remains open. The SQLite integration actually closes/reopens runtime storage, proves current authorization produces the correct actor-attributed producer/transcript, and proves parent-share revocation leaves no prompt or producer. Runtime typecheck and focused lint passed. Source closure also now cancels pending event decisions: 69 event/stream checks and 145 wider runtime checks passed without the previously observed closed-database errors.

**Remaining contract:** The remote policy requires a credential or accepted lease to acquire a turn. Persisted actor/workspace strings are not proof, and background work carries neither a live request credential nor a renewable remote grant. Remote wakes/recovered prompts therefore fail closed. Add a scoped durable execution proof bound to canonical actor, workspace, target and authorized intent, reuse the existing authority/producer mechanisms, and verify remote expiry, revocation, restart and D1 parity. Do not substitute the workspace owner or an unleased branch.

**Current code:** [host turn composition](../packages/workspace-runtime/src/routes/session.ts); [child lifecycle](../packages/workspace-runtime/src/routes/session-children.ts); [runtime store](../packages/workspace-runtime/src/store.ts); [durable delivery owner](../packages/workspace-runtime/src/session/delivery-owner.ts); [remote authority](../packages/workspace-runtime/src/remote-session-authority.ts); [real SQLite wake tests](../packages/claxedo-server/src/deployments/self-hosted-node/embedded-child-wake-authority.test.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-94"></a>
### P-94 — Session pull does not bind runtime token to route workspace

**Original severity:** MED. **Current:** Fixed in the working tree; focused regression checks passed. **Reassessed severity:** High with a leaked workspace control token.

**Original mechanism:** The three session-pull handlers call authContext but not assertRuntimeMutationAuth. A runtime token becomes unsigned-local authority and the pull resolves the workspace from the URL. Signed callers do get session checks. This is a direct cross-workspace control-token boundary defect.

**Initial acceptance requirement:** Bind token workspace to the route before any pull or projection write and assert session membership in that workspace. Test token A against route B and a valid A session.

**Current code:** [packages/claxedo-server/src/authority/http/session-pull.ts](../packages/claxedo-server/src/authority/http/session-pull.ts); [packages/claxedo-server/src/authority/http/index.ts](../packages/claxedo-server/src/authority/http/index.ts). [Concept walkthrough A](#flow-a).

**Remediation:** See [remediation progress](#remediation-progress) for implementation and exact verification scope.

<a id="finding-p-95"></a>
### P-95 — Checkpoint helper trusts unsigned mode but outer guard blocks remote callers

**Original severity:** MED. **Current:** Not reachable as claimed. **Reassessed severity:** Low latent helper risk.

**What happens and why it matters:** authorized returns owner for allowUnsignedLocal, but the shipped self-hosted app mounts unsignedLocalRequestGuard before WorkspaceCheckpointRoutes. That guard denies nonloopback workspace paths. The old anonymous-remote destruction chain omits this guard.

**Fix and acceptance:** Keep the public-entrypoint denial test and add an explicit loopback check in the reusable helper if it can be mounted elsewhere. Do not call this a confirmed remote MED vulnerability.

**Current code:** [packages/claxedo-server/src/workspace/routes/checkpoints.ts](../packages/claxedo-server/src/workspace/routes/checkpoints.ts); [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-96"></a>
### P-96 — Usage ownership follows the requesting account

**Original severity:** MED. **Current:** Present. **Reassessed severity:** Medium.

**What happens and why it matters:** LocalUsageRoutes can flush unclaimed machine facts under caller identity and expose machine history/quota. This is not necessarily provider billing theft; the confirmed issue is attribution integrity and metadata exposure on a shared signed node.

**Fix and acceptance:** Bind usage identity to the session/runtime producer when facts are created, restrict local history to the machine operator and scope quota reads. Test two accounts racing to claim pending facts.

**Current code:** [packages/claxedo-server-core/src/usage/routes.ts](../packages/claxedo-server-core/src/usage/routes.ts); [packages/claxedo-server-core/src/usage/adapters/sqlite-usage-ledger.ts](../packages/claxedo-server-core/src/usage/adapters/sqlite-usage-ledger.ts); [packages/claxedo-local-server/src/usage/outbox-sync.ts](../packages/claxedo-local-server/src/usage/outbox-sync.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-97"></a>
### P-97 — Task cloud starts bypass the route's admission policy

**Original severity:** MED. **Current:** Present source gap. **Reassessed severity:** Medium; paid-product reachability conditional.

**What happens and why it matters:** The tasks cloud target path calls createCloudWorkspace and sandboxManager.ensure without reusing the workspace-create entitlement/cap gate. The exact paid deployment mount remains an acceptance item; a request-guard exemption import is not proof of the entire shipped flow.

**Fix and acceptance:** Move cloud creation admission into the canonical creation service and call it from tasks and routes. Test an exhausted account and concurrent starts through task_start.

**Current code:** [packages/claxedo-tasks/src/ports/authorization.ts](../packages/claxedo-tasks/src/ports/authorization.ts); [packages/claxedo-tasks/src/ports/session-bridge.ts](../packages/claxedo-tasks/src/ports/session-bridge.ts); [packages/claxedo-server/src/workspace/origin-cloud-workspace.ts](../packages/claxedo-server/src/workspace/origin-cloud-workspace.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-98"></a>
### P-98 — Refreshing a revoked OAuth credential can reactivate it

**Original severity:** MED. **Current:** Partial; local registry fixed, hosted KV open. **Reassessed severity:** Medium.

**What happens and why it matters:** The SQLite registry now preserves revoked status atomically when secret rotation or health verification completes. Provider health and operator revocation remain separate decisions. The hosted KV adapter still rewrites the lifecycle-bearing record on health updates and lacks an atomic cross-worker fence.

**Fix and acceptance:** Retain local before/during-refresh and held-backend-write regressions, plus explicit restoration coverage. Move hosted lifecycle decisions to an authoritative atomic owner before closing the whole finding; an in-process lock cannot establish cross-worker correctness.

**Current code:** [packages/claxedo-local-server/src/credentials/routes/credential.ts](../packages/claxedo-local-server/src/credentials/routes/credential.ts); [packages/claxedo-server-core/src/credentials/registry.ts](../packages/claxedo-server-core/src/credentials/registry.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-99"></a>
### P-99 — Custom provider endpoint and env selection need policy

**Original severity:** MED. **Current:** Partial. **Reassessed severity:** Medium transport; env-exfiltration unconfirmed.

**What happens and why it matters:** readCustomProvider validates env-name syntax but does not restrict which names may be selected and accepts HTTP base URLs. The last hop resolving arbitrary names from privileged process.env was not established, so control-plane secret theft remains unconfirmed.

**Fix and acceptance:** Require secure approved destinations and deliver only registry-owned provider credentials to the engine. Test an internal-secret env name end to end without using real secrets.

**Current code:** [packages/claxedo-server-core/src/credentials/custom-provider.ts](../packages/claxedo-server-core/src/credentials/custom-provider.ts); [packages/claxedo-local-server/src/agent-config/routes/provider-routes.ts](../packages/claxedo-local-server/src/agent-config/routes/provider-routes.ts); [packages/claxedo-server-core/src/credentials/opencode-provider-catalog.ts](../packages/claxedo-server-core/src/credentials/opencode-provider-catalog.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-100"></a>
### P-100 — Legacy cross-organization workspace sharing is gone

**Original severity:** MED. **Current:** Resolved by removal. **Reassessed severity:** None for removed workspace-sharing API.

**What happens and why it matters:** grantWorkspaceShare and canonicalShareTarget are absent from current authority implementation. Session sharing replaced the old workspace share path; stale line numbers now point to unrelated machine lifecycle code.

**Fix and acceptance:** Keep organization-binding tests on current session-share APIs. Do not recreate legacy workspace sharing as a fix.

**Current code:** [packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts](../packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts); [packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority-store.ts](../packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority-store.ts); [packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts](../packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-101"></a>
### P-101 — Machine heartbeat now requires a one-use signed request

**Original severity:** MED. **Current:** Resolved by replacement. **Reassessed severity:** None for original heartbeat replay.

**What happens and why it matters:** Public heartbeat uses verifyMachineRequest with timestamp/body/path and nonce verification; SQLite consumeNonce inserts a unique enrollment/nonce pair. The old reusable bearer-plus-signature endpoint is gone.

**Fix and acceptance:** Retain replay, stale timestamp, wrong body and revoked machine tests through the mounted route. The machine-auth unit suite passes in this review.

**Current code:** [packages/claxedo-server-core/src/platform/auth/machine-auth.ts](../packages/claxedo-server-core/src/platform/auth/machine-auth.ts); [packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts](../packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-102"></a>
### P-102 — Host-serving route belongs to desktop composition

**Original severity:** MED. **Current:** Not mounted as claimed. **Reassessed severity:** High local exposure tracked as P-84.

**What happens and why it matters:** HostServingRoutes lacks its own auth but is mounted by local-app, not the signed self-hosted app. The signed node uses RemoteAccessMachineRoutes instead. Calling this an anonymous signed-server endpoint without that composition is incorrect.

**Fix and acceptance:** Authenticate the desktop control surface under P-84 and separately fix signed-node operator enrollment under P-88. Add mount inventories that distinguish these products.

**Current code:** [packages/claxedo-local-server/src/workspace/host-serving-routes.ts](../packages/claxedo-local-server/src/workspace/host-serving-routes.ts); [packages/claxedo-local-server/src/app/local-app.ts](../packages/claxedo-local-server/src/app/local-app.ts); [packages/claxedo-server/src/routes/remote-access.ts](../packages/claxedo-server/src/routes/remote-access.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-103"></a>
### P-103 — Document capability operation comes from a header

**Original severity:** MED. **Current:** Fixed; broker HTTP and relay integration. **Reassessed severity:** Medium before remediation.

**What changed:** GET content, GET index and PUT select `read`, `resolve` and `write` respectively, independent of the caller's operation header. Verified job claims supply document lookup, project scope, response organization and write attribution; a mismatched body session is denied. Index results respect the token's document selection and local-workspace boundary. Queued writes recheck active job state before accessing the backend. The unused local relay `resolve` request path is removed; conflict resolution remains on its existing separate runtime endpoint.

**Acceptance:** A signed read capability plus valid installation credential and matching version cannot PUT, and a write-only token cannot GET. A forged body session causes no write. A document-specific index capability sees only that document; wildcard discovery excludes another workspace. Other organization/project/session headers are denied. Authorized read/write/discovery and full hosted hydration, writeback, renewal and conflict resolution still pass. All 259 server document tests and three runtime broker tests passed; server/runtime typechecks, lint and diff checks passed.

**Current code:** [installation broker](../packages/claxedo-server/src/documents/backends/local/installation-broker.ts); [relay integration](../packages/claxedo-server/src/documents/backends/hosted/local-relay.test.ts); [runtime transport](../packages/workspace-runtime/src/routes/local-document-broker.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-104"></a>
### P-104 — Agent-open checks project membership but not target session ownership

**Original severity:** MED-LOW. **Current:** Fixed; real HTTP and writeback proof. **Reassessed severity:** Medium before remediation.

**What changed:** The local backend uses the injected canonical `authorizeSessionWrite` authority before hydrating a signed caller's target session. Its writeback callback rechecks the same actor and stored workspace/session binding before every document mutation. Missing signed authority fails closed. Both self-hosted and local-daemon composition inject their existing authority; unsigned machine-owner behavior uses the existing local policy.

**Acceptance:** Real SQLite authority with two private sessions in one project rejects cross-session direct and HTTP agent-open, permits the caller's own session, permits a granted participant and its writeback, then rejects writeback after participant revocation without changing canonical document content. Missing authority returns 503 before hydration. All 261 server document tests, server/local-server typechecks, focused lint and architecture ratchets passed.

**Current code:** [local document backend](../packages/claxedo-server-core/src/documents/backends/local/backend.ts); [real authority and HTTP regression](../packages/claxedo-server/src/documents/backends/local/backend.test.ts); [session hydration owner](../packages/claxedo-server-core/src/documents/session-hydration.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-105"></a>
### P-105 — Tasks bridge loses the runtime's session confinement

**Original severity:** MED. **Current:** Fixed; focused entrypoint checks passed. **Reassessed severity:** Medium, unsigned local MCP before the fix.

**Change:** The local MCP mount issues a process-local per-session Tasks grant and presents it to the existing capability authenticator. The canonical confined bridge and agent-start gates enforce project scope, session provenance and presets approved for agents. Invalid, malformed, previous-process or disabled bearer grants are refused by unsigned authentication instead of becoming the machine owner. Signed authentication still verifies its own bearer; genuine desktop requests without a bearer retain their daemon-authorized person identity.

**Acceptance:** Real mounted MCP tests deny cross-project starts without effects, deny non-agent presets, and start an allowed task while preserving caller provenance. Mounted HTTP tests deny invalid grants for writes/start-preview and prove only legitimate person/session writes persist. Root ran the 33-test live MCP/composition suite; the delegate's server/core/MCP checks, types and architecture ratchets passed. The full local-server suite remains red on seven separately diagnosed adoption/retry failures.

**Current code:** [local composition](../packages/claxedo-local-server/src/tasks/local-composition.ts); [Tasks authorization](../packages/claxedo-server-core/src/tasks-host/authorization.ts); [session grants](../packages/claxedo-server-core/src/tasks-host/session-grants.ts); [local MCP mount](../packages/claxedo-local-server/src/app/local-app.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-106"></a>
### P-106 — Custom verifier results lack a local expiry check

**Original severity:** MED. **Current:** Fixed; focused verifier tests. **Reassessed severity:** Low now; High if insecure verifier composed.

**What changed:** Relay token verification enforces exp/nbf and a maximum lifetime after every verifier result, whatever the verifier implementation returns.

**Acceptance:** Focused tests cover expired, not-yet-valid and over-lifetime claims. Committed as 8d26187bcb.

**Current code:** [packages/workspace-relay/src/server.ts](../packages/workspace-relay/src/server.ts); [packages/workspace-relay/src/auth.ts](../packages/workspace-relay/src/auth.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-107"></a>
### P-107 — Relay memory limits are bypassed by queue conditions

**Original severity:** MED. **Current:** Partial; Bun bounds implemented. **Reassessed severity:** Medium.

**What changed:** Bun rejects when either pre-open queue bound is exceeded, caps each pending HTTP response's overflow buffer, and acquires direct-request capacity before bounded body reads. Both slow-consumer failure conditions use the existing pending-response teardown. Streaming responses remain streaming; a cumulative response-size ceiling would break legitimate large transfers and is not the same as a buffered-memory bound.

**Acceptance and remaining work:** The implementation delegate reports 106 Bun adapter tests passed, including real HTTP/WebSocket byte-only, frame-only, positive-burst and request-body admission cases. Root confirmed all 106 Bun tests, then corrected the independent review's missing slow-consumer CORS headers and added cumulative-frame coverage: six focused tests, package typecheck and lint pass. Cancellation and wider resource budgets remain open. Cloudflare and runtime host-client queue predicates still need correction. Aggregate admission, direct-response buffering, and cancellation remain tracked under overlapping P-14/P-129; the full relay finding is not closed.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-108"></a>
### P-108 — Localhost cookies are shared across ports

**Original severity:** MED. **Current:** Present, deployment-dependent. **Reassessed severity:** Medium.

**What happens and why it matters:** Embedded auth uses a host-scoped session cookie and broad localhost trusted origins. Cookies do not isolate ports. A second localhost server can receive a cookie sent to it; HttpOnly prevents JavaScript reads but not receipt by that server. HTTPS public-origin mode has a stricter browser guard.

**Fix and acceptance:** Use exact trusted origins and a dedicated auth hostname/secure deployment boundary; avoid bearer-equivalent cookies on shared localhost hosts. Test a second port receiving no usable auth credential.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/embedded-auth.ts](../packages/claxedo-server/src/deployments/self-hosted-node/embedded-auth.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-109"></a>
### P-109 — Device approval may be driven through permissive local CSRF policy

**Original severity:** MED. **Current:** Partial exploit confirmation. **Reassessed severity:** Medium, HTTP embedded + hostile localhost origin.

**What happens and why it matters:** The claim/approve flow exists and embedded trusted origins include all localhost ports. The report's zero-click chain depends on actual browser cookie/content-type behavior and was not reproduced here; arbitrary remote websites are not the same as a trusted localhost origin.

**Fix and acceptance:** Require explicit approval with exact-origin CSRF protection, make GET read-only and bind approval to the displayed device transaction. Test a hostile second localhost origin in a browser.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/device-login.test.ts](../packages/claxedo-server/src/deployments/self-hosted-node/device-login.test.ts); [packages/claxedo-server/src/deployments/self-hosted-node/embedded-auth.ts](../packages/claxedo-server/src/deployments/self-hosted-node/embedded-auth.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-110"></a>
### P-110 — Auth adapter traffic can miss the product request limiter

**Original severity:** MED-LOW. **Current:** Present source/config gap. **Reassessed severity:** Low-Medium; edge deployment conditional.

**What happens and why it matters:** The worker has an authRoute dispatch before the hosted app guard. Installed Better Auth defaults to x-forwarded-for unless configured otherwise; no trusted CF header override was found in the auth configuration. Exact edge rewriting must be checked before asserting unlimited bypass.

**Fix and acceptance:** Configure the auth limiter with CF's trusted client IP and place a suitable public-auth budget before dispatch. Test varying spoofed XFF while keeping the trusted client IP constant.

**Current code:** [packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts](../packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.cf.ts); [packages/claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts](../packages/claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-111"></a>
### P-111 — Sessionless SSE frames can outlive membership

**Original severity:** MED. **Current:** Fixed and verified with real SQLite and open SSE. **Reassessed severity:** Medium before remediation.

**What changed:** embedded workspace streams use the existing signed stream-lease format and recheck canonical current membership on renewal. Leases bind actor, organization, workspace and embedded transport. Managed stream admission requires a finite future lease; the relay oracle no longer grants unleased workspace access when signing fails. Delivery checks workspace renewal before sessionless frames, rejects malformed renewals and terminates a stalled renewal at the lease deadline. Private-session admission also refuses missing or invalid stream authority.

**Acceptance:** An already-open SSE stream carries a process-status frame for a real SQLite viewer, then closes before the next process frame after membership removal. Real D1 tests cover viewer admission, the unchanged default editor requirement, admin/outsider denial and membership revocation. Runtime tests cover absent, blank, expired, NaN and infinite leases plus stalled renewals; the authority oracle tests unavailable signing. The same focused checks, typechecks, lint and architecture ratchets as P-91 passed.

**Current code:** [embedded policy](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts); [stream admission](../packages/workspace-runtime/src/routes/session-event-privacy.ts); [event delivery](../packages/workspace-runtime/src/event-delivery.ts); [embedded authority integration](../packages/claxedo-server/src/deployments/self-hosted-node/embedded-host-authority.test.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-112"></a>
### P-112 — Pairing admin token uses ordinary equality

**Original severity:** LOW. **Current:** Fixed; focused guard tests. **Reassessed severity:** Informational.

**What changed:** The pairing admin bearer compares with the shared constant-time helper, and the unsigned-local exemption narrowed from the whole /api/channels/ prefix to the five actual provider webhook paths.

**Acceptance:** Mounted-route and guard tests cover the denied admin path and each allowed webhook. Committed as 194fb4d0a1.

**Current code:** [packages/claxedo-server/src/channels/control-plane.ts](../packages/claxedo-server/src/channels/control-plane.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-113"></a>
### P-113 — Signed node analytics route is anonymous

**Original severity:** LOW. **Current:** Fixed; focused app tests. **Reassessed severity:** Low.

**What changed:** Signed-node analytics requires verified control-plane authentication; identity derives from the verified user subject in signed mode and "local" in loopback-bounded unsigned-local mode. Client-supplied distinctId is no longer trusted.

**Acceptance:** Focused app tests cover signed and unsigned-local modes. Committed as 4305cb6d8f.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-114"></a>
### P-114 — Command-path scanner misses redirection syntax

**Original severity:** LOW. **Current:** Fixed; focused scanner tests. **Reassessed severity:** Low; not a shell sandbox.

**What changed:** The command-path scan catches redirection-adjacent paths so a scanner-informed decision sees the same paths the redirection operators would touch.

**Acceptance:** Focused tests cover redirection-adjacent forms. Committed as 4e96d4236a.

**Current code:** [packages/workspace-runtime/src/target.ts](../packages/workspace-runtime/src/target.ts). [Concept walkthrough F](#flow-f).

<a id="finding-p-115"></a>
### P-115 — Unmanaged hook updates can name unowned terminal ids

**Original severity:** LOW. **Current:** Fixed; focused hook tests. **Reassessed severity:** Low.

**What changed:** Unmanaged agent-hook lifecycle writes require a live terminal and cannot name a terminal already bound to a hook capability; ownership and runtime state are checked before writes are accepted.

**Acceptance:** Focused tests cover live versus absent terminals, ownership, bound/unbound capability behaviour and lifecycle retention. Committed as c9d3162f9b.

**Current code:** [packages/workspace-runtime/src/routes/agent-hook.ts](../packages/workspace-runtime/src/routes/agent-hook.ts). [Concept walkthrough G](#flow-g).

<a id="finding-p-116"></a>
### P-116 — Management JWKS URL permits an insecure trust anchor

**Original severity:** LOW. **Current:** Implemented; focused checks passed (see [remediation progress](#remediation-progress)). **Reassessed severity:** High, conditional.

**Original mechanism (before remediation):** loadWorkspaceRuntimeManagementVerificationKey passes any configured URL to createRemoteJWKSet. If HTTP is configured across an attacker-observable network, forged keys could validate forged management tokens. LOW understates this conditional impact.

**Fix and acceptance:** Require HTTPS or a pinned local key and refuse redirects/unapproved trust-anchor changes. Test HTTP refusal before fetching keys and wrong-key token rejection.

**Current code:** [packages/workspace-runtime/src/management-auth.ts](../packages/workspace-runtime/src/management-auth.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-117"></a>
### P-117 — Route manifest is not a complete authorization inventory

**Original severity:** LOW. **Current:** Implemented; focused checks passed (see [remediation progress](#remediation-progress)). **Reassessed severity:** Informational.

**What happens and why it matters:** The manifest omits additional document/broker/root mounts. That does not prove they lack middleware; route order and separate guards determine exposure.

**Fix and acceptance:** `route-inventory.guard.test.ts` composes `createWorkspaceRuntimeApp` at the relay boundary with every conditional mount (placed target/worktrees, transcripts, the management channel and a host route contribution), enumerates `app.routes`, and requires each mounted route to classify as a manifest family or a declared additional mount — an unclassified mount fails the inventory — and asserts every manifest family is actually mounted. Anonymous requests are refused at every enumerated entrypoint (401 `relay_host_token_required`), a relay token scoped to another workspace is refused at each (403), a correctly scoped token reaches real handlers, and the management channel refuses relay-only and wrong management tokens. `GET /global/health` is the declared deliberate pre-auth liveness mount. The manifest is annotated as the public `/api/wr` family-prefix contract rather than the whole mount surface. Focused runs passed: 5 inventory tests plus the route-inventory/http and server/public-api suites; scoped lint clean. Package typecheck carries pre-existing errors in unrelated modified files; the touched files produce none.

**Current code:** [packages/workspace-runtime/src/routes/manifest.ts](../packages/workspace-runtime/src/routes/manifest.ts). [Concept walkthrough A](#flow-a).

**Current code:** [packages/workspace-runtime/src/routes/manifest.ts](../packages/workspace-runtime/src/routes/manifest.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-118"></a>
### P-118 — Reading a cloud connection can start compute

**Original severity:** LOW-MED. **Current:** Present behavior. **Reassessed severity:** Low/product policy.

**What happens and why it matters:** The connection path ensures a sandbox after open authorization. A viewer may legitimately need a running runtime to view a session; the behavior is not inherently privilege escalation.

**Fix and acceptance:** Choose and document a spend policy, then enforce entitlement/budget at ensure. Test dormant workspace reads and account limits rather than forbidding all viewer reads by default.

**Current code:** [packages/claxedo-server/src/workspace/runtime-token-guards.ts](../packages/claxedo-server/src/workspace/runtime-token-guards.ts); [packages/claxedo-server/src/connections/hosted-connection-info.ts](../packages/claxedo-server/src/connections/hosted-connection-info.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-119"></a>
### P-119 — Missing subscription timestamp becomes arrival time

**Original severity:** LOW. **Current:** Fixed; timestamp-less webhook rejected. **Reassessed severity:** Low integrity.

**What changed:** `subscriptionEventToApplyArgs` now rejects events without a usable provider modified/created timestamp. The arrival-time fallback is deleted. Customer-state translation already used this policy. The existing signed webhook entrypoint acknowledges an unattributable event without calling the billing store.

**Acceptance:** Root ran `node node_modules/vitest/vitest.mjs run src/billing/apply-polar-state.test.ts src/billing/routes.test.ts`: 35 passed. A correctly signed older cancellation without provider time arrives after a newer active subscription and cannot write or downgrade state. Delegate validation covers all 114 billing tests, typecheck and scoped lint. This closes the missing-timestamp producer defect; the external authority's monotonic comparison for otherwise valid timestamps is not exercised by the in-process store fake and is not claimed as live acceptance.

**Current code:** [packages/claxedo-server/src/billing/apply-polar-state.ts](../packages/claxedo-server/src/billing/apply-polar-state.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-120"></a>
### P-120 — Node encrypted backend shares one deployment key partition

**Original severity:** LOW. **Current:** Present design assumption. **Reassessed severity:** Low hardening.

**What happens and why it matters:** backend-registry uses a configured org id or deployment for the secret backend. Metadata lookup still scopes credentials by org, so this is not a demonstrated cross-org read by itself.

**Fix and acceptance:** If multi-tenant cryptographic separation is required, carry authoritative org identity into the backend API and key derivation. Test identical ids in distinct org scopes.

**Current code:** [packages/claxedo-server-core/src/credentials/backend-registry.ts](../packages/claxedo-server-core/src/credentials/backend-registry.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-121"></a>
### P-121 — Existing credential seed permissions are not repaired

**Original severity:** LOW. **Current:** Fixed; focused backend tests. **Reassessed severity:** Low; local filesystem prerequisite.

**What changed:** The local credential backend validates seed length and enforces private ownership and modes on existing directory and file paths without following symlinks.

**Acceptance:** Focused tests cover permissive existing paths and malformed seeds. Committed as 5a2460c204.

**Current code:** [packages/claxedo-server-core/src/credentials/backends/local.ts](../packages/claxedo-server-core/src/credentials/backends/local.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-122"></a>
### P-122 — Connection turn credentials are created without a visible mint path

**Original severity:** INFO. **Current:** Present source gap. **Reassessed severity:** Low availability.

**What happens and why it matters:** Self-hosted composition creates turnCredentials and passes it to the connections host, but no mint call is wired in that composition. This fails closed for session-owned credential access; it is not token theft.

**Fix and acceptance:** Issue the credential at canonical authorized turn admission and expire it with the turn. Verify through a real signed session connection request and a denied foreign session.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts); [packages/claxedo-server/src/connections/turn-credentials.ts](../packages/claxedo-server/src/connections/turn-credentials.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-123"></a>
### P-123 — MCP loopback helper does not inspect the socket peer

**Original severity:** LOW-MED. **Current:** Partial. **Reassessed severity:** Low hardening; exploit unconfirmed.

**What happens and why it matters:** The helper checks URL host and Origin. A network adapter that trusts a client Host header could make this insufficient, but MCP still requires its own credential and the runtime's outer auth. A trusted-direct bearer alone does not prove MCP tool access.

**Fix and acceptance:** Use server-stamped peer provenance in network mounts, retain runtime credential verification, and test forged Host/Origin through the actual provider ingress.

**Current code:** [packages/claxedo-mcp/src/endpoint/loopback.ts](../packages/claxedo-mcp/src/endpoint/loopback.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-124"></a>
### P-124 — Signed node's in-process MCP fetch lacks actor credentials

**Original severity:** LOW. **Current:** Present source gap. **Reassessed severity:** Low availability.

**What happens and why it matters:** The in-process local fetch stamps a workspace id but no bearer, while the runtime dispatcher requires a relay actor on signed nodes. Expected effect is refusal, not broader access.

**Fix and acceptance:** Pass a canonical verified runtime principal through the in-process boundary using the existing dispatch owner. Test authorized tools work and unrelated sessions remain denied.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/app.ts](../packages/claxedo-server/src/deployments/self-hosted-node/app.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-125"></a>
### P-125 — Unknown explicit workspace ids fall back to directory

**Original severity:** LOW. **Current:** Fixed; store and public HTTP checks passed. **Reassessed severity before fix:** Low; boundary impact caller-dependent.

**Change:** resolveWorkspace now treats an explicit ID as the lookup target and returns absent when it does not exist, including empty IDs. It never falls through to directory lookup or creation. The public resolve route preserves explicit empty input, and session metadata routes refuse a missing explicit workspace before consulting project/directory state. Suppressed workspace errors and the project-ID prefix guess are removed. Directory-only creation and project-only discovery remain explicit operations.

**Acceptance:** Root reproduced the wrong-workspace result through both actual HTTP routers (200 instead of 404), then verified 79 store/integrity tests and 33 resolve/metadata/projection tests. Cases cover missing and empty IDs with a different valid directory, create=true, denied metadata writes without stored effects, valid ID lookup, directory creation and a project whose ID starts with ws_. Server-core/local-server typechecks, six-file lint and scoped diff checks passed. No production imports changed.

Independent Devin source review completed with no defects found. It did not rerun tests; the root verification above remains the execution evidence.

**Current code:** [workspace store](../packages/claxedo-server-core/src/workspace/store/index.ts); [resolve HTTP](../packages/claxedo-local-server/src/workspace/routes/resolve-route.ts); [metadata HTTP](../packages/claxedo-local-server/src/session/routes/meta-routes.ts); [store tests](../packages/claxedo-server/src/workspace/store/index.test.ts); [resolve tests](../packages/claxedo-local-server/src/workspace/routes/resolve-route.test.ts); [metadata tests](../packages/claxedo-local-server/src/session/routes/meta-routes.test.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-126"></a>
### P-126 — Resolver headers can overwrite relay-owned authorization

**Original severity:** LOW (latent). **Current:** Fixed; focused resolver tests. **Reassessed severity:** Low hardening.

**What changed:** Resolver-provided headers are allowlisted and relay-owned authorization and identity headers are stamped last so a provider response cannot overwrite them.

**Acceptance:** Focused tests cover allowlisted and reserved-header collisions. Committed as 8d26187bcb.

**Current code:** [packages/workspace-relay/src/server.ts](../packages/workspace-relay/src/server.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-127"></a>
### P-127 — Relay target parser accepts unrestricted URL strings

**Original severity:** LOW-MED. **Current:** Partial. **Reassessed severity:** Medium, insecure target configuration.

**What happens and why it matters:** baseUrl is shape-checked only and later used for fetch. HTTP credential exposure is valid; “every non-HTTP scheme exfiltrates a token” is not, because fetch may reject it or treat it without a network request.

**Fix and acceptance:** Parse and validate allowed schemes/destinations when resolving a target and before forwarding; use secure transport outside explicitly trusted local topology. Test HTTP and unsupported schemes with no real credentials.

**Current code:** [packages/workspace-relay/src/server.ts](../packages/workspace-relay/src/server.ts); [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-128"></a>
### P-128 — Anonymous first traffic influences relay room placement

**Original severity:** LOW-MED. **Current:** Present mechanism. **Reassessed severity:** Low-Medium availability.

**What happens and why it matters:** CF chooses a location hint from request region before Durable Object routing/auth inside the room. A hint is not a guarantee of exact placement, so the original “permanently pins to an attacker-chosen region” is too absolute.

**Fix and acceptance:** Resolve region from authoritative workspace placement before object creation, or authenticate the hint. Test unauthenticated requests cannot change the chosen placement input.

**Current code:** [packages/workspace-relay/src/cloudflare.ts](../packages/workspace-relay/src/cloudflare.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-129"></a>
### P-129 — Long streams and WebSocket sends share weak resource limits

**Original severity:** LOW. **Current:** Fixed; focused budget tests. **Reassessed severity:** Medium availability.

**What changed:** Event streams count against a separate 64-stream budget instead of the pending-request cap, pre-start stream requests leave a four-slot control reserve, one deletion point prevents budget leaks, and a shared buffered-byte guard covers every socket send path with the existing 1011 close policy.

**Acceptance:** Focused tests cover streams plus ordinary HTTP under saturation, stream-cap refusal with upstream abort, and both cloud send directions under backpressure. Committed as a1a93e5d28.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough H](#flow-h).

<a id="finding-p-130"></a>
### P-130 — Long token lifetimes can overflow timers

**Original severity:** LOW. **Current:** Fixed; Bun socket tests passed. **Reassessed severity:** Low correctness before remediation.

**What changed:** The existing socket authorization watcher bounds each timer to 2,147,483,647 ms and re-evaluates the signed expiry at every wake. Long lifetimes no longer overflow into an immediate close, and bounded wakes never extend the deadline. Socket cleanup clears the currently armed timer; nonfinite deadlines fail closed.

**Acceptance:** A real Bun relay socket with a 30-day token is exercised across the timer boundary using an injected clock: the first wake reschedules, traffic remains usable, and the expiry wake closes with code 1008. All 101 Bun adapter tests passed, including existing expiry/revocation and backpressure checks; package typecheck and focused lint passed. This finding concerns the Bun adapter; no Node adapter behavior is claimed.

**Current code:** [packages/workspace-relay/src/bun.ts](../packages/workspace-relay/src/bun.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-131"></a>
### P-131 — Daemon document git still inherits privileged environment

**Original severity:** LOW-MED. **Current:** Fixed; focused checks passed. **Reassessed severity:** Medium; High if privileged secrets reachable.

**What happens and why it matters:** Both document compositions use the same adapter onto the canonical bounded Git runner and safe child environment. Shell Git and project clone paths reuse that runner. Caller environment overrides admit only the scratch index; clone authentication uses an explicit HTTPS host-bound credential option. Worktree startup scripts also receive the canonical safe environment.

**Fix and acceptance:** Retain real Git helper tests with synthetic privileged secrets planted before module import, successful document commit/scratch-index checks, host-scoped credential checks and real clone success/failure. Environment filtering closes this hand-off; broader same-user process/filesystem privilege remains H-1.

**Current code:** [packages/claxedo-local-server/src/app/local-documents.ts](../packages/claxedo-local-server/src/app/local-documents.ts); [packages/claxedo-server-core/src/documents/repository/git-authority.ts](../packages/claxedo-server-core/src/documents/repository/git-authority.ts). [Concept walkthrough B](#flow-b).

<a id="finding-p-132"></a>
### P-132 — Agent discovery GET can create and start a workspace

**Original severity:** LOW-MED. **Current:** Fixed; focused discovery tests. **Reassessed severity:** Low; local-owner chain.

**What changed:** Discovery GETs no longer pass create for a caller-supplied directory, so a caller-named unregistered path resolves or 404s without creating a workspace or starting a runtime. The dedicated resolve/create route keeps explicit creation.

**Acceptance:** Focused tests cover unregistered-path discovery and preserved explicit creation. Committed as 2ae9a5fa87.

**Current code:** [packages/claxedo-local-server/src/agent-config/routes/index.ts](../packages/claxedo-local-server/src/agent-config/routes/index.ts); [packages/claxedo-local-server/src/workspace/sandbox-fetch-options.ts](../packages/claxedo-local-server/src/workspace/sandbox-fetch-options.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-133"></a>
### P-133 — Hydration activation can use a stored capability

**Original severity:** LOW. **Current:** Fixed; mounted relay route checks. **Reassessed severity:** Low before remediation.

**What changed:** Activation and conflict resolution now authorize the caller through the runtime's existing session access policy before the stored document or its stored job capability is consulted. Both routes classify as a new `document_write` session-control operation, and the composed relay mount hands the route family the same `sessionAccessPolicy` every other session surface uses. A missing policy fails closed for verified remote callers; local compositions without a policy keep their existing behavior.

**Acceptance:** Mounted-app tests deny a caller the session authority refuses on activation and on resolution — including one presenting a fresh valid capability — leave the stored document pending, and prove the authorized caller still hydrates, activates and resolves a conflicted document. The hosted documents integration exercises activation through the real remote session policy. Focused runtime tests passed (79 tests); server document integration passed (3 tests). The package typecheck reports only pre-existing errors in unrelated modified files; focused lint and architecture ratchets passed.

**Current code:** [packages/workspace-runtime/src/routes/document-hydration.ts](../packages/workspace-runtime/src/routes/document-hydration.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-134"></a>
### P-134 — Unattributed lifecycle frames have broad visibility

**Original severity:** LOW. **Current:** Fixed; focused ownership tests. **Reassessed severity:** Low.

**What changed:** Unattributed agent-hook lifecycle writes stamp the runtime's configured workspace identity and resolve sessionId through the bound terminal; the delivery side sheds provider ids, transcript paths and ref names from unowned frames and drops foreign-workspace session.lifecycle frames.

**Acceptance:** Focused tests cover unattributed frames delivered as status-only and foreign-workspace frames dropped. Producer stamping committed as 83fe627a09; delivery-side redaction landed via e9e678acfa.

**Current code:** [packages/workspace-runtime/src/routes/events.ts](../packages/workspace-runtime/src/routes/events.ts); [packages/workspace-runtime/src/event-delivery.ts](../packages/workspace-runtime/src/event-delivery.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-135"></a>
### P-135 — Prompt dedup marker precedes lease acquisition

**Original severity:** LOW. **Current:** Fixed; focused admission tests. **Reassessed severity:** Low, narrow concurrency window.

**What changed:** promptAdmissions entries hold the pending admission's promised Response: a racing retry awaits and clones the canonical answer instead of deduplicating on sight, the admission body settles the deferred on success or with the onError response on failure, and pre-execution failures still release the id for later retries.

**Acceptance:** Focused tests gate a blocked turns.start to prove racing-join-failure, racing-join-success and post-completion dedup. Committed as ab8766f5e2.

**Current code:** [packages/workspace-runtime/src/routes/session-core.ts](../packages/workspace-runtime/src/routes/session-core.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-136"></a>
### P-136 — Embedded cookie-plus-bearer precedence is not explicit rejection

**Original severity:** LOW. **Current:** Fixed; focused bridge tests. **Reassessed severity:** Low.

**What changed:** The embedded bridge rejects simultaneous cookie and Authorization presentation with 401 ambiguous_credentials, matching the declared reject-cookie-and-authorization policy.

**Acceptance:** Focused tests cover dual presentation and each single-credential path. Committed as 209ddca634.

**Current code:** [packages/claxedo-server/src/deployments/self-hosted-node/embedded-browser-auth.ts](../packages/claxedo-server/src/deployments/self-hosted-node/embedded-browser-auth.ts); [packages/claxedo-server/src/platform/auth/better-auth-d1-request-authentication.ts](../packages/claxedo-server/src/platform/auth/better-auth-d1-request-authentication.ts). [Concept walkthrough C](#flow-c).

<a id="finding-p-137"></a>
### P-137 — Daytona runtime identity can differ from its lease identity

**Original severity:** LOW-MED. **Current:** Partial; source identity corrected. **Reassessed severity:** Low availability; live provider unverified.

**What changed:** The supervisor's lease environment no longer overwrites `WORKSPACE_RUNTIME_HOST_ID` with the provider sandbox UUID. The driver's boot environment owns the host identity it also returns as `target.hostId`, subsequently persisted by the lease store. Passing an acquire-time lease ID would still be wrong because the final driver target is not known then. The unused `WORKSPACE_RUNTIME_SANDBOX_ID` write is removed; provider identity remains in `driverResourceId`.

**Acceptance and remaining work:** Root ran the configured runtime-boot and supervisor cloud suites: 120 passed. Delegate validation includes the real Daytona driver's generated command environment, 163 server tests, 128 driver tests, three package typechecks, lint and ratchets. A real Daytona sandbox registering with the relay and serving a routed request remains unverified. The identical target-environment helpers in server-core and sandbox-manager remain a separate consolidation item.

**Current code:** [packages/claxedo-server/src/workspace/supervisor/sandbox.ts](../packages/claxedo-server/src/workspace/supervisor/sandbox.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-138"></a>
### P-138 — Old token helpers were replaced or tightened

**Original severity:** INFO. **Current:** Partial/resolved. **Reassessed severity:** Informational.

**What happens and why it matters:** The old D1 token-method references no longer identify those methods, and SQLite recordRuntimeAccessTokenForService now checks current workspace/user role or an explicit owner service principal. Service trust still needs careful composition, but the old “lax” summary is stale.

**Fix and acceptance:** Keep strict principal validation and tests that only trusted service code can invoke service minting. Remove dead paths rather than maintaining two token authorities.

**Current code:** [packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts](../packages/claxedo-server/src/authority/adapters/d1/host-access-authority.ts); [packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts](../packages/claxedo-server-core/src/authority/adapters/sqlite/workspace-authority.ts). [Concept walkthrough A](#flow-a).

<a id="finding-p-139"></a>
### P-139 — Session share doorbells compare the same subject namespace

**Original severity:** LOW. **Current:** Resolved. **Reassessed severity:** None for original namespace mismatch.

**What happens and why it matters:** event-visibility now compares event.ownerUserId to principal.subject explicitly. The original comparison to an internal usr id is absent. This closes that specific fail-closed notification mismatch.

**Fix and acceptance:** Retain grant/revoke fanout tests using different internal ids and identity-provider subjects.

**Current code:** [packages/claxedo-server/src/session/session-people-contract.ts](../packages/claxedo-server/src/session/session-people-contract.ts); [packages/claxedo-server-core/src/platform/http/event-visibility.ts](../packages/claxedo-server-core/src/platform/http/event-visibility.ts). [Concept walkthrough D](#flow-d).

<a id="finding-p-140"></a>
### P-140 — MCP optional audience and unused permission claim are separate

**Original severity:** INFO. **Current:** Fixed; focused verifier tests. **Reassessed severity:** Low hardening/Informational.

**What changed:** The canonical OAuth verifier requires the exact MCP resource audience; absent audience fails like a wrong one. The never-minted permissionMode claim was removed from the credential type, keying and conversion.

**Acceptance:** Focused tests cover missing and wrong audience. Committed as 54e2a7fa25.

**Current code:** [packages/claxedo-server/src/mcp/oauth-credential.ts](../packages/claxedo-server/src/mcp/oauth-credential.ts); [packages/workspace-runtime/src/first-party-mcp/credential.ts](../packages/workspace-runtime/src/first-party-mcp/credential.ts). [Concept walkthrough A](#flow-a).

## Verification performed

Source inspection covered all 161 original IDs, current callers and deployment mounts, relevant installed dependency behavior, and the intervening implementation history. Searches included removed legacy helpers, current authorization producers, process launch environments, and actual package importers. A resolved path was not assumed resolved merely because the original report's header said so.

| Working directory | Exact command | Outcome |
| --- | --- | --- |
| `packages/agent-sdk-runtime` | `bun test src/harnesses/shared/spawn-env.secrets.test.ts` | 7 passed, 0 failed. |
| `packages/workspace-runtime` | `bun test src/pty/env.secrets.test.ts` | 12 passed, 0 failed. |
| `packages/claxedo-local-server` | `node node_modules/vitest/vitest.mjs run src/deployments/local/server-workspace-pty-proxy.test.ts src/deployments/local/host-session-authority.test.ts src/app/desktop-session-authority.test.ts` | 18 passed; 4 PTY cases failed during fixture creation, before authorization assertions. |
| `packages/claxedo-local-server` | `node node_modules/vitest/vitest.mjs run src/deployments/local/server-workspace-pty-proxy.test.ts > /tmp/security-pty-test.log 2>&1` | Reproduced fixture failure: ENOENT writing PTY history under the default home state directory. |
| `packages/claxedo-local-server` | `WORKSPACE_RUNTIME_PTY_HISTORY_DIR=/tmp/claxedo-security-review-pty-history node node_modules/vitest/vitest.mjs run src/deployments/local/server-workspace-pty-proxy.test.ts > /tmp/security-pty-isolated.log 2>&1` | 4 passed, 0 failed using the supported isolated history directory. No production/test code changed. |
| `packages/claxedo-server-core` | `node node_modules/vitest/vitest.mjs run src/platform/auth/machine-auth.test.ts > /tmp/security-machine-auth.log 2>&1` | 48 passed, 0 failed. |
| Repository root | `bun /tmp/security-review-probes.ts` | Six bounded source probes passed; assertions reproduced below. |

An initial attempt to invoke package Bun tests from the repository root hit the repository's explicit root-test prohibition; tests were rerun from their package directories. The local server runner also emitted watcher-limit warnings. The successful isolated run establishes the four existing PTY tests, not the missing read-only-write/revocation acceptance for P-82.

The passing package runs cover **89 tests** in total, counting the four PTY cases only once. They are targeted evidence; they do not test every proposed fix. No production imports changed, so the architecture-ratchet trigger does not apply. No full product build or live provider exploit was run for this documentation review.

### Bounded probe assertions

These are historical pre-remediation assertions from the temporary probe, with imports made relative to the repository root. P-61 and P-16 assertions intentionally describe the old defect and no longer pass after their fixes; use the current regression suites above for acceptance. They use synthetic identifiers, execute no attacker command and contact no external service. Save the snippet in a temporary `.ts` file at the repository root and run it with Bun if repeating it; do not interpret its parser/string assertions as full remote exploit demonstrations.

```ts
import assert from "node:assert/strict"
import { hostServingSurface } from "./packages/claxedo-host-serving/src/surface.ts"
import { canonicalToolName } from "./packages/agent-runtime-contract/src/tool-names.ts"
import { hostSubagentBinding } from "./packages/agent-event-runtime/src/harnesses/host-subagent.ts"
import { decodeExecution } from "./packages/claxedo-tasks/src/decode.ts"
import { decodeContext } from "./packages/claxedo-tasks/src/validation.ts"
import { claxedoDocumentReferenceId } from "./packages/claxedo-helpers/src/claxedo-document.ts"
import { formatDaytonaDomainAllowList } from "./packages/sandbox-manager/src/daytona-allow-list.ts"

const target = hostServingSurface({
  localBaseUrl: "http://127.0.0.1:2593",
  workspaceId: "ws_probe",
  path: "/../../file/content?directory=/",
})
assert.equal(target.kind, "workspace")
assert.equal(target.url.pathname, "/file/content") // P-61: normalized outside prefix
assert.equal(typeof canonicalToolName("constructor"), "function") // P-40
assert.equal(hostSubagentBinding(JSON.stringify({
  kind: "claxedo.subagent", subagentKey: "probe", sessionId: "foreign",
}))?.sessionId, "foreign") // P-5: binding parser only
const ctx = decodeContext()
decodeExecution(ctx, {
  placement: "cloud",
  capabilities: {
    mode: "selected", plugins: Array.from({ length: 1000 }, () => ({})), skills: [],
  },
}, "execution")
assert.equal(ctx.fields.fields.length, 2000) // P-16
assert.throws(() => claxedoDocumentReferenceId("claxedo://document/%"), URIError) // P-46
assert.equal(formatDaytonaDomainAllowList(["good.test,extra.test"]),
  "good.test,extra.test") // P-75: serializer only; upstream reachability is separate
```

For S-10, the runtime's Hono 4.10.7 is below the SSE control-field patch in 4.12.4. The advisory establishes the library behavior; this review separately identifies the application's resume-cursor sink and does not claim cross-user injection. See the [Hono SSE advisory](https://github.com/honojs/hono/security/advisories/GHSA-p6xx-57qc-3wxr).

## Acceptance that remains unverified

This table records the initial review's follow-ups. The remediation progress and finding-specific updates above supersede rows whose focused acceptance has since passed; remaining platform/deployed-service gaps are not evidence that conditional exploit chains were reproduced.

| Owner | Unverified requirement and current evidence | Follow-up |
| --- | --- | --- |
| Self-hosted composition / plugins | P-81 source chain is present; no exposed signed deployment was exercised. | Start an isolated signed node through the public startup composition. Assert anonymous and non-operator writes fail after the fix, and authorized installation succeeds with a nonexecuting fixture. |
| Runtime / session authority | P-82 initial attachment tests pass; rolling read revocation and per-message write permission are not covered by them. | Open a read-only socket through the local proxy, attempt input, revoke the grant and observe output termination. Compare the direct runtime route. |
| Sandbox lifecycle | P-60/P-86/P-137 source permits identity changes or mismatches; a real provider snapshot/destruction/relay chain was not exercised. | Use a disposable provider account/resource and prove mismatched identity cannot change the lease or operate on another resource. Verify the generated runtime identity matches its lease. |
| Frontend / desktop security | S-2/P-68/P-69 final browser exploit is unconfirmed; sinks and current sanitizers were inspected. | Mount actual document/transcript components in the packaged renderer and browser; verify inert payloads at preview, fullscreen and link clicks, plus legitimate rendering. |
| Windows desktop | P-6 shell interpolation exists; Windows/WSL execution was unavailable in this review. | Run literal metacharacter path tests on Windows/WSL without executing a malicious payload. |
| Embedded auth / hosted edge | P-109 browser CSRF chain and P-110 actual edge header/limiter behavior were not reproduced. | Use two localhost origins for device approval and a deployed test worker for trusted-IP rate limiting. Measure the actual cookie and header behavior. |
| Channels / agent events | P-4 installed adapter configuration and P-5 text parser are confirmed; forged end-to-end channel work/transcript disclosure was not run. | Test the mounted webhook in each secret configuration and hostile generic tool text against real parent/child authorization. |
| Authority / documents / MCP | Other source-confirmed ownership gaps have not all received mounted multi-user regression tests. | Use separate synthetic users, organizations, workspaces and private sessions; exercise each finding's stated positive and negative acceptance checks at the public entrypoint. |

After fixes, rerun the affected package checks and the listed public-entrypoint acceptance before closing the findings. Keep resource identity, environment production and authorization in their canonical owners; do not make the frontend invent missing ownership, emit substitute authority events or silently fall back to a more privileged path.
