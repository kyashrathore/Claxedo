# ACP form pattern validation

Status: backend implemented and verified, 2026-09-20; browser worker integration and packaged UI acceptance are a separate lane. Sections below retain implementation requirements; the evidence and deviations here describe the delivered backend.

Backend evidence: contract tests 7/7, focused ACP suite 214/214, SDK source shape/typecheck/build, contract build/typecheck, and architecture ratchets passed. `scripts/pattern-validation-package.test.mjs` passes through the built public ACP factory under Node22.23.2, Node26.8.1, and Bun1.3.14. External-watchdog tests prove both runtimes terminate a catastrophic regex worker and exit; timeout tests prove a subsequent validation succeeds. Logs: `/tmp/acp-pattern-full.log`, `/tmp/acp-pattern-node-package.log`, `/tmp/acp-pattern-bun-package.log`, `/tmp/acp-pattern-node22-package.log`, `/tmp/acp-pattern-ratchets.log`.

Delivered API: `validateElicitationResponse(schema, value, evaluator, signal?)` and `ElicitationValidationError` in the contract package. The worker-only package subpath exports `evaluateNativeElicitationPatterns`. Runtime workers serialize that self-contained trusted function into a fixed bootstrap; only `workerData` carries agent input. Consequently the runtime has no external worker asset to relocate or omit; built-package tests exercise this exact serialization. Browser integration still uses an explicit Vite worker asset. Runtime admission is bounded to two jobs with an explicit busy error and no queue. Resource limits remain the proposed values below. The shared primitive validator now counts Unicode code points for JSON Schema string length.

## Outcome and semantic contract

Accept ACP string `pattern` constraints using native ECMAScript regular expressions in an isolated, terminable worker. Preserve the exact agent schema and submitted values. A timeout means validation could not complete; it must never mean valid, invalid, consent, or permission approval.

ACP v1 `StringPropertySchema.pattern` accepts a string or null. JSON Schema uses ECMAScript patterns with Unicode support and substring matching. The shared evaluator uses `new RegExp(pattern, "u").test(value)` with no synthesized anchors or agent-supplied flags. Empty pattern matches; null/omitted pattern imposes no constraint. [JSON Schema core §6.4](https://json-schema.org/draft/2020-12/json-schema-core#section-6.4) explicitly recommends the `u` flag or equivalent Unicode support; ACP describes this as a JSON Schema, without adding a different regex dialect. Syntax unsupported by an installed native engine produces an explicit validation error, not a translated approximation.

Do not use RE2 as an invisible substitute. A read-only probe of `re2js@2.8.6` found `\\s` does not match NBSP and `.` matches carriage return, unlike native Unicode ECMAScript matching. Its translator does not correct those differences; lookahead and backreferences reject. No regex dependency is proposed.

## Current authoritative flow

1. `packages/agent-sdk-runtime/src/harnesses/acp/elicitation.ts`, `AcpElicitationInteractions.create`, calls `readElicitationSchema` before persisting `question.asked`. The contract reader currently rejects every non-null pattern.
2. `packages/agent-runtime-contract/src/elicitation.ts` owns structural schema reading and synchronous primitive/content validation. Both runtime and UI use this package. It has no worker or platform imports.
3. `packages/claxedo-app/src/features/session/ui/composer/session-elicitation-dock.tsx`, `finish`, validates the draft synchronously and submits serialized content through the existing question reply route. Draft values are a Solid store and need a plain snapshot before structured cloning.
4. `AcpElicitationInteractions.respond` parses that JSON and validates again, then `finish` commits `question.replied`, deletes the live resolver, and resolves the ACP request. Startup replies and bound-session replies share this path.
5. `packages/agent-sdk-runtime/src/harnesses/acp/index.ts`, `replySessionStartQuestion`, currently calls `interactions.replyStart` without returning/awaiting it. This is safe only while the callee is synchronous. Audit both normal and startup forwarding, adapter contracts, and public routes when introducing async work.

The runtime remains the authoritative acceptance boundary. Browser validation is an early, equivalent check; a direct HTTP client cannot bypass runtime validation.

## Scoped implementation

### Contract package

- Keep `readElicitationSchema` synchronous and restricted to structural checks, including string/null pattern type and resource bounds. It must never compile untrusted regex on its calling thread.
- Keep synchronous primitive validation with an accurate name if splitting the existing API. Export one async complete validator that calls the primitive validation and delegates pattern checks to an injected `ElicitationPatternEvaluator`. Return validated `ElicitationContent`; TypeScript async functions cannot return assertion signatures.
- Add a small platform-neutral worker protocol and pure evaluator in a dedicated worker-only subpath. It receives bounded `{id, checks: [{field, pattern, value?}]}` data; compilation-only admission omits `value`. It returns typed syntax/mismatch/success outcomes. Only this worker-only implementation constructs `RegExp`.
- Do not export worker evaluation from the eager contract barrel. Add explicit package exports/build entries so browser and runtime worker entrypoints import the same code. Preserve schema JSON as supplied; compiled regex objects and worker identities are not durable data.
- Define resource constants and typed errors once. Initial proposed limits for measurement: 64 patterned fields, 4 KiB per pattern, 64 KiB per value, 256 KiB total job payload, 250 ms execution deadline and 2 s worker-start deadline. These are client resource limits, not protocol limits; document and test exact boundaries. Tune from real acceptance evidence before shipping.

### Worker execution owner

- One worker per validation job initially. Bound concurrent jobs per runtime and renderer (proposed two) and bound waiting jobs (proposed sixteen). Queue timeout, cancellation, and overload must settle explicitly. No unbounded cache or pool of stuck workers.
- The parent owns timers. A timer inside the regex worker cannot interrupt a synchronous regex. Start the execution timer at the worker's ready handshake and bound startup separately; never reset deadlines because a worker sends messages.
- Timeout/abort/error terminates the worker, removes listeners, and rejects exactly once. Do not just race a promise and leave CPU work running. Ignore late responses and mismatched job IDs. Terminate successful one-shot workers too.
- Node runtime wrapper uses `node:worker_threads`, a real built entry asset, and awaits `terminate()`. Use supported `resourceLimits` as an additional guard, not a promise of total process memory containment. Clear inherited preload/exec arguments where needed and never pass credentials or environment values as job data.
- Bun needs explicit compatibility verification. Its documentation calls worker termination experimental and says a close event may precede full thread exit. Prove actual cancellation with a catastrophic regex on the installed version. If interruption cannot be demonstrated, the runtime evaluator must use an explicitly owned killable subprocess instead; do not claim bounded execution from promise timeout alone.
- Browser uses a dedicated Web Worker with no fetch, dynamic code evaluation, or user-derived script source. Only pattern/value data crosses `postMessage`. Cancellation is `Worker.terminate()`.

### Runtime admission, response, and races

- Compile schema patterns through the bounded evaluator before publishing a renderable form. Malformed/too-expensive schemas fail the elicitation request explicitly. Propagate ACP request cancellation during compilation; cancellation before persistence must not emit an orphan question.
- `respond` becomes async. Mark the specific pending question as validating before awaiting; a duplicate accept must not launch another job. Keep rejection/cancellation available and let them abort the job.
- After await, verify `this.pending.get(id) === capturedPending`, request scope, and live ownership before committing. A disconnected/replaced session or completed startup must not resurrect its resolver or produce a second terminal event.
- Store a validation AbortController with live pending state. `finish`, `cancelSession`, process death, and `dispose` abort it. Validation mismatch/timeout releases the validation lease but leaves the question pending for correction or decline. No `question.replied` on failure.
- Return/await the async result through normal and startup adapter methods and question routes. The HTTP response must not report success before authoritative validation and durable commit finish.
- Keep human-wait leases active throughout validation. Do not execute the original prompt again after a validation error.

### UI

- Set busy before any validation await. Capture a plain immutable draft snapshot and request identity; submit exactly that validated snapshot, not subsequently edited live store values.
- Await complete validation before `onSubmit` and network submission. Show syntax/timeout/mismatch errors honestly. Preserve draft content and the durable question on failure.
- Abort validation on unmount, request change, cancel, and decline. Cancel/decline controls must remain usable while local validation is running. A stale completion cannot dispatch removal or clear another question's persisted draft.
- Do not use HTML `pattern` as authoritative validation; native input constraint semantics differ and execute outside the controlled worker path.

## Build, CSP, and packaged runtime constraints

- Browser precedent exists: `packages/session-ui/src/components/markdown-worker.ts` imports `markdown-shiki.worker.ts?worker&url`, then constructs a module Worker; `src/pierre/worker.ts` does the same. Reuse this explicit Vite asset pattern for an app-local wrapper importing the shared evaluator.
- Vite also supports literal `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`. Keep its URL literal and at the constructor so Vite can discover it. A variable assembled by a generic factory is not an adequate asset declaration.
- Do not introduce Blob or eval workers. The hosted app's `public/_headers` currently enforces frame ancestors and separately reports a broader policy containing `worker-src 'self' blob:`. Self-hosted `app.ts` also includes that report-only worker directive. Existing permissive/report-only behavior is not proof that a packaged worker loads. Test under enforcing `worker-src 'self'` as well; no CSP broadening is required for a same-origin emitted worker.
- Electron's `packages/claxedo-desktop/src/main/windows.ts` uses `loadFile` in production. Its renderer origin is `file://`, not the dev server. `vite.renderer.ts` has a worker build configuration. Verify the emitted relative asset inside the actual packaged application/ASAR; a dev-server test does not establish packaged worker availability. Do not disable web security to make it load.
- SDK `scripts/build.ts` uses explicit esbuild entries, Node22 target, ESM splitting, and `.mjs` output. Add the runtime worker as an explicit output entry. Verify the wrapper's asset URL after chunk relocation; `new URL` alone does not ensure esbuild packages the worker. Include the entry in package-manifest checks and installed-package tests.
- Inspect downstream workspace-runtime/desktop daemon bundling too. A worker asset must survive final consumer bundling/packaging, not merely SDK `dist`. Existing desktop `scripts/node-worker-bundles` illustrates explicit worker preservation but is not automatically applicable to daemon outputs.
- New production imports require architecture ratchets and affected closure verification. No regex engine dependency or broad browser-to-Node import edge is intended.

## Acceptance matrix

| Case | Expected proof |
| --- | --- |
| `abc`, value `xabcx`; `^abc$`, same value | Substring succeeds; anchored pattern fails |
| Empty pattern; null/omitted; invalid `[` | Empty succeeds; absent skips; syntax error before renderable question |
| `\\s` with NBSP; `.` with CR/LF/U+2028/U+2029 | Matches native Unicode ECMAScript semantics |
| `^.$` with emoji; Unicode property escapes | Same accepted outcomes in Node, Bun, and Chromium |
| `(?=a)a`; `(?<=a)b`; `(a)\\1` | Lookaround/backreferences retain native semantics |
| `^(a+)+$`, long `a` suffix `!`; `^(a|aa)+$` | Bounded timeout or valid engine completion; parent heartbeat continues; worker actually stops |
| Deep groups, huge repetition, large pattern/value/batch | Limits reject explicitly; no main-thread compilation or unbounded clone/allocation |
| Duplicate accepts; accept versus decline/cancel | One terminal durable event and one ACP response at most |
| Dispose/process loss/startup cancellation during validation | Worker retired; resolver not revived; no late acceptance |
| Invalid answer then corrected answer | Same question remains live; valid retry commits once |
| Cross-session/start-operation answer | Ownership fails before spawning validation work |
| Worker startup failure/CSP denial/missing built asset | Visible error; no automatic acceptance or main-thread fallback |
| Direct public HTTP reply, skipping UI | Same authoritative rejection and success behavior |
| Reload/unmount/edit during validation | Draft retained appropriately; captured answer cannot mutate or clear another request |
| Built SDK under Node22 and installed Bun; production web and packaged Electron | Actual asset load, timeout termination, successful reply and UI responsiveness |

Use a test-process deadline as a second containment boundary for adversarial runtime tests; never execute malicious patterns directly in the test runner. Browser tests need real workers, not only happy-dom mocks. Measure parent heartbeat and worker termination, not only elapsed rejection time. A benign job after timeout must complete without waiting on the poisoned worker.

## Primary sources

- [ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json): `StringPropertySchema.pattern`.
- [JSON Schema string](https://json-schema.org/understanding-json-schema/reference/string) and [regular expressions](https://json-schema.org/understanding-json-schema/reference/regular_expressions): ECMAScript and substring semantics.
- [Node worker threads](https://nodejs.org/api/worker_threads.html): termination and resource limit contracts; verify against supported Node22 during implementation.
- [Bun workers](https://bun.sh/docs/runtime/workers): termination caveat and runtime-specific lifecycle.
- [Web Worker termination](https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate): browser cancellation.
- [Vite worker support](https://vite.dev/guide/features#web-workers): build-time worker discovery.
- [RE2JS](https://github.com/le0pard/re2js): candidate evaluated and rejected as a semantic substitute.
