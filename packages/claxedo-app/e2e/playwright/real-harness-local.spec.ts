/**
 * SPEC: Real harness journeys, local lane (Tier R)
 *
 * PURPOSE — Tier M (33 specs) mocks every route through `installMockRuntime`,
 * and Tier L (5 specs) needs real credentials so it runs in no CI lane at all.
 * That leaves the seam where the app meets a real model provider covered by
 * nothing a PR can see: the July managed-server -> SDK migration shipped an
 * app whose core opencode turn fails ("Couldn't reach Anthropic — Not Found"),
 * whose claude harnesses never resolve a model catalog, and whose codex
 * harnesses never create a session — five expressions of one broken seam, all
 * invisible to CI. This spec closes that hole. Everything is real: the app, a
 * genuinely spawned `claxedo-server` (embedded OpenCode engine, no
 * `OPENCODE_URL` override — the "absent OPENCODE_URL = embedded" contract from
 * `project_embed_opencode_engine`), a real git worktree, the real
 * `claude`/`codex` binaries, the real workspace-runtime and its SQLite journal.
 * The ONLY fake is the model HTTP endpoint: `e2e/helpers/scripted-model-server.ts`
 * stands where api.anthropic.com / api.openai.com would. That makes the whole
 * journey hermetic and credential-free, so it belongs on every PR — which is
 * the entire point of the tier (`e2e/INVARIANTS.md` rule 6).
 *
 * STATE MODEL — identical client-side state machine to `core-first-prompt-local`
 * and `live-real-harness-smoke` (draft -> optimistic user row -> `POST /session`
 * -> `POST /session/:id/prompt_async` (204, fire-and-forget) -> real
 * `/global/event` SSE delivers `session.status busy` -> `message.updated`
 * (pending) -> `message.part.delta`* -> `message.updated`(completed) ->
 * `session.idle`). Every one of those events is produced by the REAL server
 * driving a REAL harness backend, never by `e2e/helpers/mock-runtime.ts`. The
 * substitution happens strictly BELOW the harness: the provider config /
 * base-URL env the server process carries (see HARNESS NOTES) redirects the
 * model call and nothing else. Harness selection persists server-side
 * per-directory (`GET/POST /api/claxedo/agent-config/harness?directory=...`),
 * so a directory previously switched to a harness auto-hydrates a fresh draft
 * onto it; this spec avoids that cross-test coupling by giving every scenario
 * its own freshly `git init`-ed scratch worktree and driving the harness
 * `<Select>` explicitly. Message persistence after reload is the real
 * `workspace-runtime` `RuntimeStore` (SQLite under `CLAXEDO_DATA_DIR`), so the
 * reload in each scenario exercises the real replay read path. Server-process
 * lifetime is the whole file (`beforeAll`/`afterAll`); the scripted server's
 * request log is reset per scenario so per-scenario counts are exact.
 *
 * ANATOMY — reuses the selectors `core-first-prompt-local` and
 * `core-harness-ownership-local` document; this spec does not re-derive them,
 * since the DOM contract is identical against a real backend:
 *   `[data-claxedo]` — shell root, presence == app painted.
 *   `[role="textbox"][aria-label*="Ask anything"]` — composer editor.
 *   `[data-action="prompt-submit"]` — send/stop control (`turn-oracle.ts`'s
 *     `submitControlReady` asserts `data-icon !== "stop"` once settled).
 *   `[data-slot="session-turn-assistant-content"]` (not `aria-hidden="true"`) —
 *     the oracle's DOM-truth target (`e2e/helpers/turn-oracle.ts`).
 *   `[data-slot="session-turn-message-content"]` — user turn row; counted via
 *     `turn-oracle-extras.ts`'s `expectLiveUserRowCount` because a real reply
 *     can render more than one assistant row per turn (reasoning + text).
 *   `[data-action="prompt-harness-model"]` — the combined harness/model/effort
 *     trigger. Its model label and the picker's Harness summary are asserted
 *     separately; the trigger intentionally renders the harness as an icon.
 *   `[data-component='composer-notice']` with `data-notice="runtime-unavailable"`
 *     — the single unavailable-harness surface (`core-harness-ownership-local`
 *     behavior 5); the cursor scenario asserts against it.
 *
 * BEHAVIORS —
 *   1. The `opencode` harness (embedded engine, scripted `tier-real` provider,
 *      no external binary) completes 3 turns in one session, each proven by the
 *      full three-layer oracle, and a page reload re-renders all 3 replies from
 *      the real persisted store with no duplication.
 *   2. The `claude-acp` harness (a genuinely spawned `claude-agent-acp`
 *      subprocess, `packages/agent-sdk-runtime/src/harnesses/acp/*`) completes
 *      the same 3-turn + reload journey against the scripted Messages endpoint.
 *   3. The `claude-sdk` harness (in-process `@anthropic-ai/claude-agent-sdk`
 *      driver, no subprocess) completes the same 3-turn + reload journey.
 *   4. The `codex-acp` harness (a genuinely spawned `codex-acp` subprocess)
 *      completes the same 3-turn + reload journey against the scripted
 *      Responses endpoint.
 *   5. The `codex-app-server` (native Codex SDK) harness completes the same
 *      3-turn + reload journey.
 *   6. Every scenario's model traffic actually went through the scripted
 *      endpoint: the scenario's own dialect logs one call per turn (plus at
 *      most one for the engine's title turn — see HARNESS NOTES), and the
 *      dialects belonging to OTHER providers log zero. This is what makes the
 *      tier's central claim ("no real provider was contacted") an assertion
 *      rather than a hope: a harness that silently fell back to a real endpoint
 *      would leave the scripted counter at zero while the reply still rendered.
 *   7. Selecting `Cursor` never routes the turn through another provider.
 *      Cursor's endpoint is proprietary and has no base-URL knob, so it cannot
 *      be redirected at the scripted server; this spec therefore proves the
 *      invariant-4 half that matters — either the harness locks in and renders
 *      its own model control, or it reports itself unavailable and blocks
 *      submit, and in BOTH cases the scripted server receives zero requests.
 *      No silent fallback to OpenCode either way.
 *   8. Harness selection is locked once a session exists, even against the real
 *      backend (the contract `core-harness-ownership-local` pins against a
 *      mock) — checked once per harness scenario as a cheap supplement.
 *   9. Gating: with `CLAXEDO_TIER_REAL_E2E` unset, every test is skipped with a
 *      visible reason (this lane bakes its own backend origin into the app
 *      build, so it cannot ride a core shard). With the flag set, `claxedo-server`
 *      failing to boot FAILS the file loudly in `beforeAll` with the server's
 *      own log tail — never a silent skip. A missing OPTIONAL binary
 *      (`claude`/`codex`) throws `GATING:` under `CI` and `test.skip`s with a
 *      visible reason locally (see HARNESS NOTES for why the two differ).
 *  10. The timeline turn picker stays absent through 10 turns, appears on turn
 *      11, previews only the hovered user/assistant pair, and scrolls to the
 *      selected turn. Settled history is seeded into the real embedded engine's
 *      isolated SQLite projection; no browser route or application endpoint is mocked.
 *  11. Every executable harness journey ends at the real account-menu Usage
 *      entrypoint. The unmocked dashboard API must expose that harness's exact
 *      settled tokens in the visible breakdown, the cost projection must keep
 *      its billing disclaimer, Total must include the Claxedo row, and closing
 *      the dialog must restore focus. This closes the last seam from provider
 *      response -> runtime event -> SQLite ledger -> local route -> production UI.
 *  12. Selecting Local -> New local worktree on a draft provisions a real Git
 *      worktree, waits for the server's real `worktree.ready` event, dispatches
 *      the first prompt in that new directory, and renders the scripted reply.
 *
 * INVARIANTS — completed assistant content is never hidden by stale busy state
 *   (#3 in `e2e/INVARIANTS.md`): every oracle call here proves it against REAL
 *   busy/completed/idle timing from a real server, not staged mock timing.
 *   Harness ownership (#1): the selected harness is locked after creation
 *   (behavior 8) and nothing falls back to plain OpenCode. No silent fallback
 *   (#4): behaviors 6 and 7 turn that from a UI claim into a wire-level one.
 *   Submit gating (#5): every wait is a deterministic DOM/count assertion; this
 *   spec adds zero `waitForTimeout` sleeps as the sole guard of anything. Tier
 *   R (#6): zero `page.route()` calls appear in this file — the substitution is
 *   entirely process-env-level, below the browser.
 *
 *   THE PER-DIALECT COUNTERS ARE LOAD-BEARING, not a supplement. Read
 *   `expectScriptedTraffic` as a primary assertion: it is the only thing in
 *   this file that can tell a real provider's answer from the scripted one.
 *   Every content assertion — markers, row counts, the oracle — passes just as
 *   happily when a REAL provider answered, because a real provider echoes the
 *   marker too. Three silent misroutes have been caught here, each invisible to
 *   every other assertion in the suite:
 *     1. `codex-app-server` rendered 3 correct turns with ZERO scripted
 *        requests — real OpenAI answered, billed to someone's quota.
 *     2. `codex-acp` completed the round trip against a version whose frame
 *        shapes had drifted from the fixture's.
 *     3. `opencode` ran all 3 turns on `anthropic/claude-sonnet-4-6` because
 *        the app writes its own model into session config, overriding the
 *        engine's `OPENCODE_CONFIG_CONTENT` pin — and this lane's
 *        `ANTHROPIC_BASE_URL` then routed that to the scripted MESSAGES
 *        endpoint, so the markers echoed correctly from the WRONG dialect.
 *        `selectScriptedModel` exists for exactly this.
 *   A scenario whose counters are unasserted is a scenario that cannot fail
 *   for the tier's own reason to exist. Never soften them to make a lane green.
 *
 * HARNESS NOTES —
 *   - VERIFIED INJECTION TABLE. Each row was proven against the real binary by
 *     `e2e/helpers/scripted-model-server.probe.ts` (3/3 passing), not inferred:
 *
 *     | harness | mechanism | dialect |
 *     |---|---|---|
 *     | opencode (embedded engine) | `OPENCODE_CONFIG_CONTENT` on the server process, carrying a `provider.tier-real.options.baseURL` block | chat/completions |
 *     | claude-acp, claude-sdk | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` + `CLAUDE_CONFIG_DIR` | messages |
 *     | codex-acp, codex-app-server | scratch `CODEX_HOME` holding a generated `config.toml` with a `model_providers.scripted` block (`wire_api="responses"`); `CODEX_CONFIG` additionally for the codex-acp wrapper | responses |
 *     | cursor | IMPOSSIBLE — proprietary endpoint, no base-URL knob | (none) |
 *
 *     `CLAUDE_CONFIG_DIR` is not decoration, it is load-bearing: the claude
 *     CLI's own `settings.json` `env` block OVERRIDES the process environment,
 *     so a developer whose global Claude settings set `ANTHROPIC_BASE_URL` (a
 *     local proxy, a corporate gateway) would silently hijack the turn — the
 *     scripted server would see zero requests while the test went green against
 *     the wrong backend, i.e. exactly the false-positive this tier exists to
 *     prevent. Pointing `CLAUDE_CONFIG_DIR` at a scratch directory is what makes
 *     the redirect trustworthy, and behavior 6's counter assertion is what
 *     makes it checkable.
 *
 *     Codex ignores `OPENAI_BASE_URL` entirely in ChatGPT auth mode; the
 *     `model_providers` override is the only way in. `requires_openai_auth:
 *     false` is what lets the scripted lane run with no ChatGPT session at all.
 *   - WHY THE CODEX ROW IS `CODEX_HOME` AND NOT `CODEX_CONFIG` — paid for by a
 *     false-green this spec caught on its first run. `CODEX_CONFIG` is a
 *     convention of the `@agentclientprotocol/codex-acp` WRAPPER (its
 *     `startAcpServer()` reads `process.env.CODEX_CONFIG`), not an env var the
 *     codex binary understands: `strings $(which codex)` contains no such name.
 *     `codex-app-server` never sees it at all —
 *     `packages/agent-sdk-runtime/src/harnesses/codex/driver.ts:630` spawns
 *     `codex app-server --listen stdio://` with no `-c` override, and
 *     `ensureProcess` (driver.ts:406) passes only `CODEX_HOME` plus an optional
 *     `OPENAI_API_KEY`. With `CODEX_CONFIG` alone, BOTH codex harnesses fell
 *     through to the developer's real `~/.codex/config.toml`: three correct
 *     markers rendered on screen, zero scripted requests, answered by the
 *     `model` pinned in that real config (`gpt-5.6-sol`, visible in the UI
 *     alongside a real "skills context budget" warning) on the machine owner's
 *     own quota. Writing a `config.toml` into a scratch home and setting
 *     `CODEX_HOME` — which `CodexDriver` already honors (driver.ts:149) —
 *     redirects both variants with NO product change, verified against the real
 *     binary. `CODEX_CONFIG` is kept alongside it for the wrapper's own path.
 *   - The "harness silently reverts to OpenCode" symptom this spec first
 *     reported was TWO separate bugs, both now fixed — recorded because the
 *     misreading is easy to repeat:
 *       * A REAL product bug: `harness-options-loader.ts` raised
 *         `optionsLoading` on entry and every abandon path (superseded seq, or
 *         the scope moved harness) returned WITHOUT clearing it. The model
 *         control renders "Loading models" straight off that flag with no other
 *         exit, so a switch that outran its own in-flight request stranded the
 *         control for the life of the scope. Fixed by the `abandon()` helper;
 *         pinned by three unit tests in `harness-options-loader.test.ts` that
 *         go red if it is removed. This is what broke `claude-sdk`.
 *       * A SPEC bug that looked identical: `switchDraftHarness` waited for a
 *         button labelled "OpenCode", which only exists for the first scenario
 *         in a run (see that helper's doc). Later scenarios timed out on a
 *         trigger that was never going to say "OpenCode", and the screenshot —
 *         taken after the failed wait — showed the composer still on the
 *         PREVIOUS scenario's harness, which reads exactly like a revert.
 *     Lesson for the next reader: a screenshot proves what the DOM contained,
 *     not why. Confirm a suspected product revert against the server's own
 *     `GET /api/claxedo/agent-config/harness/options` (which answered
 *     correctly, in under a second, throughout) before filing it.
 *   - Draft harness switch can silently not commit: the listbox accepts the
 *     click (the option is visible and clicked) and the composer is then found
 *     back on its previous harness with the menu closed. `switchDraftHarness`
 *     re-opens and re-clicks up to 3 times and then throws `GATING:` rather
 *     than proceeding onto the wrong harness — a scenario that silently ran
 *     against the previous harness would produce a meaningless green. Note the
 *     landing check reads the TRIGGER's label, not the option's
 *     `aria-selected`: while the listbox is open EVERY option renders
 *     `aria-selected="false"`, including the selected one (verified by dumping
 *     the live listbox HTML), and the listbox unmounts on close. The label
 *     cannot distinguish a harness's ACP and native-SDK variants, so the
 *     per-variant proof is behavior 6's dialect counters, not this check.
 *   - FIXED (behavior 4, codex-acp): the responses emitter must stream the FULL
 *     delta sequence, not just created/output_item.done/completed. `codex
 *     app-server` only emits the `item/agentMessage/delta` notification — the
 *     one `@agentclientprotocol/codex-acp` turns into an ACP
 *     `agent_message_chunk` — when it SEES the text arrive as
 *     `output_text.delta`. Against the terminal-only shape it completed the
 *     turn with correct token usage and emitted no delta at all, so the wrapper
 *     forwarded no assistant text. Proven by driving `codex app-server`
 *     directly over its own JSON-RPC: streamed shape -> `item/agentMessage/
 *     delta` present with the marker; terminal-only shape -> absent. See
 *     `respondResponses` in `scripted-model-server.ts`; do not drop those
 *     frames.
 *
 *     Two dead ends recorded so nobody re-walks them. (1) The `exec` custom
 *     tool this codex build advertises in an `additional_tools` developer
 *     message is a red herring: answering that contract (function_call ->
 *     function_call_output -> message) completes the round trip and STILL
 *     produces no chunk. (2) `codex exec --json` is NOT a proxy for the
 *     app-server — it parses the terminal-only shape happily and prints the
 *     text, which is exactly why this looked like a wrapper bug until the
 *     app-server protocol was driven directly.
 *   - OPEN (behavior 3, claude-sdk): intermittent, ~2/5 passing, and it is NOT
 *     the driver. Proven server-side by driving `POST /session/:id/
 *     prompt_async` three times directly against a real claxedo-server with the
 *     claude-sdk harness: every turn reaches the scripted endpoint (messages
 *     counter moves each turn) and every marker lands in
 *     `GET /session/:id/message`. So the SDK driver's `resume` path
 *     (`claude/driver.ts:170-172`) is fine — the standalone CLI resume is fine
 *     too (`claude -p --resume <id>` returns the second marker). What fails is
 *     client-side: the composer stays stuck on "Stop" (busy) and the reply the
 *     server already holds never renders. The failing turn is NOT always turn 2
 *     — observed on T2 and T3 — so it is a settle/delivery race, not a
 *     turn-2-specific bug. Locus is the client store / SSE ingest path
 *     (`src/features/session/store/message-page.ts` and friends), which is
 *     fenced to the duplicate-render work; whoever owns that file should take
 *     this with the evidence above rather than re-deriving it here.
 *
 *     This race is NOT claude-specific. After behavior 4's fix, codex-acp was
 *     seen failing the same way once in a combined run (reply for T2 never
 *     rendered) while passing 3/3 solo and passing the combined run before and
 *     after. So any Tier R scenario can lose it; claude-sdk just loses it most
 *     often. That is one more reason it is a client-side delivery race rather
 *     than a per-harness defect.
 *
 *     RESOLVED (2026-08-02). Behaviors 1 and 3 were TWO defects, not one, and
 *     the paragraph that used to sit here — "server side is fully exonerated,
 *     the SSE stream carries complete correctly-keyed frames for all three
 *     turns" — was wrong and is superseded. That trace had been taken on a run
 *     that PASSED; it could not have shown the failure. Do not cite it.
 *
 *       * behavior 1 was a client-store defect: one reply arrives under two
 *         ids (the announced `${userMessageId}_r` and the id the engine picks),
 *         and both merge paths keyed on id alone, so it filed as two messages
 *         and rendered twice. Fixed in `opencode-conversation.ts`
 *         (`assistantTurnIndex`), NOT in `message-page.ts` as guessed above.
 *       * behavior 3 was a SERVER defect with no client involvement: the
 *         session busy lock was released in the adapter's `sendMessage`
 *         generator `finally`, which runs only after the consumer's
 *         post-terminal work (commits, fan-out, an auto-title round-trip).
 *         Measured lag 514-516ms. A prompt landing inside it was refused with
 *         "Session is already processing a message" — for a turn that had been
 *         over for half a second. One run missed the release by ONE
 *         millisecond. Fixed by releasing at terminal emission
 *         (`sdk-runtime-adapter.ts`), `finally` kept as idempotent backstop.
 *
 *     Three lessons from the hunt, each of which cost real time here:
 *       1. A UI state is not a cause. "Loading models" and a stuck
 *          "Thinking"/Stop were both read as the defect and both turned out to
 *          be downstream symptoms — the second of a send that had already been
 *          swallowed.
 *       2. Never synthesise across runs of different colours. A timeline built
 *          from a passing run and a failing one produced a coherent, wrong
 *          story. Stamp every probe's run red or green before reading it.
 *       3. Probe silence is not evidence. Three separate "this code never
 *          runs" conclusions were instrumentation failures: a `require()` in an
 *          ESM bundle, a scripted edit that corrupted the module (vite reported
 *          `Pre-transform error`; every marker vanished), and a `page.evaluate`
 *          that threw in the failure path. Prove the probe fires on a path
 *          known to execute BEFORE trusting its absence. Note also that
 *          `@claxedo/agent-sdk-runtime` and `@claxedo/workspace-runtime` both
 *          resolve to `dist` from claxedo-server: a source edit in either is
 *          invisible until that package is rebuilt.
 *   - RESOLVED cross-scenario coupling. Before `seedDefaultHarness` (see its
 *     doc) full runs were nondeterministic: 0/6 to 4/6 with identical code, and
 *     the failing SET moved between runs, because each scenario's switch
 *     rewrote the server-global harness seed the next scenario hydrated from.
 *     After it, consecutive full runs became REPRODUCIBLE — the same set
 *     passed and the same set failed, every time. The old symptom (the composer
 *     stuck on the previous scenario's harness reading "Loading models") no
 *     longer occurs. That reproducibility is what turned the three failures it
 *     left into diagnosable defects rather than noise — behaviors 1, 3 and 4,
 *     all since fixed (see above and the codex note); the lane now runs 6/6.
 *     Behaviors 2 and 5 passed even then, which is what demonstrated the tier's
 *     core claim early: a real ACP subprocess and a real native-SDK harness
 *     both complete 3 turns against the scripted endpoint, with the
 *     cross-dialect counters proving no real provider was contacted.
 *
 *     What is RULED OUT for the cross-scenario coupling, each by direct
 *     experiment rather than reasoning — do not re-spend this time:
 *       * The scripted fixture and the binaries. A standalone `claude -p`
 *         against the fixture returns the marker with counts `{messages: 2}`,
 *         re-verified after the failures started.
 *       * The server. `GET /harness/options` answers in 0.4s warm / 3.8s cold,
 *         measured over five consecutive cold worktrees; both claude and codex
 *         return full catalogs.
 *       * The option locator. Now `[role="option"][data-key=…]`, confirmed
 *         against dumped live listbox HTML; a standalone driver clicking it
 *         shows the trigger on "Claude" within 1s and a settled catalog by 5s,
 *         repeatably.
 *       * Machine load. The same spread appears at load average 3 and 13.
 *       * The server-global harness default. `GET /harness` answers from
 *         `defaultHarness(await loadUserConfig())`
 *         (`agent-config-harness-routes.ts:60`), and `loadUserConfig()` reads
 *         ONE file under `CLAXEDO_DATA_DIR` (`agent-config.ts:67`) — genuinely
 *         shared across scenarios. `resetDefaultHarness` below puts it back to
 *         `opencode` per scenario through the app's own POST route. It is kept
 *         because it is correct, but it did NOT fix the flake: an A/B with and
 *         without it fails identically.
 *       * The client-side draft default. Keyed by `serverUrl` + `workspaceKey`,
 *         and `sessionPaneWorkspaceKey` falls back to the DIRECTORY
 *         (`session-workspace.ts:67`), so the per-scenario worktree plus
 *         `seedOneProject`'s `localStorage.clear()` already isolate it. The
 *         original "server-scoped draft default" hypothesis was WRONG.
 *       * Commit `3b667f550` (loopback proxy relay-token fix), suspected
 *         because it touches the browser's proxy path and landed near the
 *         regression. Reverting it locally changes nothing — a scenario fails
 *         identically against the pre-commit proxy.
 *
 *     One observed failure is the pre-existing draft->session handoff race that
 *     `playwright.config.ts` already documents as unfixed ("a confirmed `POST
 *     /session -> 201` sometimes leaves the URL on the draft route") — inherited
 *     by this tier, not introduced by it.
 *
 *     Where to look next: something makes the composer ABANDON a harness it has
 *     already adopted (`switchDraftHarness` confirms the trigger label before
 *     returning, yet the failure screenshot shows "OpenCode"), which points at a
 *     late hydration overwriting a confirmed selection rather than at anything
 *     in this file. The two `optionsLoading` leaks fixed in
 *     `harness-options-loader.ts` and `harness-switcher.ts` were real and are
 *     pinned by unit tests, but they were not the whole story.
 *     Individual scenarios pass in isolation — a standalone driver that opens a
 *     draft, clicks `[data-key="claude-acp"]` and polls shows the trigger on
 *     "Claude" within 1s and the model control settled on a real catalog by 5s,
 *     repeatably — and the same scenario passes in some full runs and not
 *     others, with the residual failure always "Loading models past 45s" on a
 *     composer still showing the previous scenario's harness. What is already
 *     ruled out: the server (options answer in 0.4s warm / 3.8s cold, measured
 *     over five consecutive cold worktrees), the option locator (now
 *     `data-key`, unambiguous), and machine load (the same 1/6-vs-4/6 spread
 *     appears at load 3 and load 13). What is NOT ruled out and is the place to
 *     start: scenarios share one server AND one server/workspace-scoped draft
 *     default (INVARIANTS #2), so each scenario's switch mutates what the next
 *     one hydrates onto — the per-scenario worktree does NOT isolate this.
 *     Prime suspect is a hydration racing the next scenario's switch. A fix
 *     probably means resetting the draft default between scenarios (or giving
 *     each its own server), not another timeout bump.
 *   - Why these env vars reach every harness: the drivers spawn with
 *     `{...process.env}` and `harnessSpawnEnv`
 *     (`packages/agent-sdk-runtime/src/harnesses/shared/spawn-env.ts`) scrubs
 *     only 9 Claxedo-internal names. Setting them on the `claxedo-server`
 *     process therefore reaches the embedded engine, the in-process SDK
 *     drivers, and every spawned subprocess alike.
 *   - `OPENCODE_DISABLE_MODELS_FETCH=true` is mandatory for hermeticity: the
 *     engine otherwise fetches the live models.dev catalog at boot, which is
 *     both a real network call and a boot-time flake source in CI.
 *   - Call-count shape (behavior 6), measured against the scripted endpoint
 *     with the real binaries rather than assumed: the embedded engine issues
 *     one extra `chat` call per session for the title (auto-answered with
 *     `SCRIPTED_TITLE`), and the claude CLI issues TWO `messages` calls for a
 *     single one-token turn — the second carries a `system-reminder` context
 *     block, confirmed by logging both requests' prompts from a standalone
 *     `claude -p` run against the fixture. So "one HTTP call per turn" is not a
 *     real contract and this spec does not assert it: the lower bound (>= one
 *     call per turn on the scenario's own dialect) is the load-bearing claim,
 *     the upper bound only catches a runaway loop, and cross-dialect counts —
 *     zero, except the engine's one title call on `chat` — are what actually
 *     pin routing.
 *   - The marker echo must match the LAST occurrence in the transcript. From
 *     turn 2 on, the request body carries every previous turn's prompt too, so
 *     a first-match capture answers every turn with turn 1's marker forever.
 *     The fixture's `MARKER_PROMPT` regex is therefore `g` + `.at(-1)`. This is
 *     invisible to a single-turn probe and, in a multi-turn spec, presents as a
 *     product bug (the reply renders, it is just the wrong turn's text) — which
 *     is how it was found.
 *   - Binary-gating asymmetry (behavior 9): locally, `claude`/`codex` may
 *     genuinely be absent on a contributor's machine and a `test.skip` with a
 *     visible reason is the right answer (`e2e/INVARIANTS.md`'s complaint is
 *     about SILENT no-reason skips). In CI the lane installs both CLIs as part
 *     of the job, so a missing binary there is a broken job, not a
 *     configuration choice — it throws `GATING:` and turns the lane red. Note
 *     no authentication is needed for either binary in this lane: the scripted
 *     server is the endpoint and accepts the dummy `test-key`.
 *   - Real per-turn latency is far lower here than in Tier L (the scripted
 *     server answers instantly), but subprocess spawn + ACP handshake still
 *     costs real seconds on the first turn of each harness. Scenario timeout is
 *     raised in `beforeEach` accordingly.
 *   - Cursor (behavior 7) has no scripted path by construction. Its scenario is
 *     deliberately a config-materialization + no-fallback check, not a turn.
 *
 * OUT OF SCOPE — the cloud/relay half of this tier (`real-cloud-relay.spec.ts`:
 *   real relay, real tunnel, `kind:"cloud"` workspace); the full per-harness
 *   ownership/model/effort/payload matrix against a pinned mock
 *   (`core-harness-ownership-local`); per-harness event/tool-rendering fidelity
 *   (`core-harness-rendering-matrix`); tool round-trips (the scripted server's
 *   `scriptTool()` exists for a future spec — Tier R smoke turns are text-only);
 *   busy/abort/error escalation UI (`core-busy-abort-errors`); real-credential
 *   coverage (`live-real-harness-smoke`, Tier L).
 */
import { expect, test, type Locator, type Page } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
// `node:sqlite` needs Node >= 22.5, but Playwright LOADS this file during
// collection in every lane (grep filters tests, not files), and the browser
// lanes run under Node 20 where a top-level import kills the whole run with
// "No such built-in module". Required lazily inside the one Tier-R seeding
// helper that uses it, so only the lane that actually opens the engine
// database needs the newer runtime.
import { createRequire } from "node:module"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  claudeScriptedEnv,
  codexScriptedConfigJson,
  codexScriptedConfigToml,
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
  type ScriptedDialect,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"
import { expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"
import { expectLiveTurnsSettledAfterReload, expectLiveUserRowCount } from "../helpers/turn-oracle-extras"
import { expectRailRowVisible } from "../helpers/rail-oracle"

const execFileAsync = promisify(execFile)

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const BACKEND_PORT = Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const TURNS = 3
const TURN_PICKER_TURNS = 11

let scripted: ScriptedModelServer | undefined
let server: ChildProcess | undefined
let serverLog = ""
let dataDir = ""
const scratchDirs: string[] = []

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Per-probe `AbortSignal.timeout`: a health probe against a server that
 * accepted the TCP connection but never answers would otherwise hang the whole
 * boot budget on the FIRST attempt and report a misleading timeout.
 */
async function waitForHealth(url: string, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      .then((res) => res.ok)
      .catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(
    `GATING: Tier R claxedo-server did not become healthy at ${url} within ${timeoutMs}ms — this is a real setup ` +
      `failure (CLAXEDO_TIER_REAL_E2E=1), not a skip. Server log tail:\n${serverLog.split("\n").slice(-60).join("\n")}`,
  )
}

/** Harvested from live-claxedo-mcp-tools.spec.ts — never adopt a port this file did not spawn. */
async function assertPortFree(port: number, label: string) {
  const found = await execFileAsync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN", "-t"]).catch(() => undefined)
  const pids =
    found?.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  if (pids.length > 0) {
    throw new Error(
      `GATING: ${label} port ${port} is already owned by PID(s) ${pids.join(", ")} that this file did not spawn. ` +
        `Free it or set CLAXEDO_TIER_REAL_BACKEND_PORT before retrying — adopting a foreign server would silently ` +
        `run this tier against an un-redirected backend.`,
    )
  }
}

async function startServer() {
  await assertPortFree(BACKEND_PORT, "Tier R claxedo-server")
  scripted = await startScriptedModelServer()
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-tier-real-data-"))
  const claudeConfigDir = path.join(dataDir, "claude-config")
  await fs.mkdir(claudeConfigDir, { recursive: true })
  // The scratch CODEX_HOME is what actually redirects codex — see the
  // injection table and `codexScriptedConfigToml`'s doc. Without it, both codex
  // harnesses read the developer's real ~/.codex/config.toml and spend real
  // provider quota while the scripted server sits at zero requests.
  const codexHome = path.join(dataDir, "codex-home")
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(path.join(codexHome, "config.toml"), codexScriptedConfigToml(scripted.v1Url))

  server = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      // TokenTracker-backed history must scan only this hermetic fixture home;
      // a release test may never inspect a contributor's real provider logs.
      HOME: dataDir,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      // The whole tier, in four env vars — see HARNESS NOTES' injection table.
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(scripted.v1Url)),
      TIER_REAL_API_KEY: "test-key",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      CLAXEDO_PI_MODEL: "anthropic/claude-sonnet-4-6",
      ...claudeScriptedEnv(scripted.url, claudeConfigDir),
      // Both codex knobs: CODEX_HOME redirects the CLI itself (the load-bearing
      // one, for both codex-app-server and codex-acp), CODEX_CONFIG additionally
      // reaches the codex-acp wrapper's own startup path.
      CODEX_HOME: codexHome,
      CODEX_CONFIG: codexScriptedConfigJson(scripted.v1Url),
      CODEX_THREAD_ID: undefined,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
      CODEX_CI: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      // claude-agent-acp gates `allowDangerouslySkipPermissions` on
      // `!IS_ROOT || IS_SANDBOX`, but the claude CLI refuses
      // --dangerously-skip-permissions under root even when IS_SANDBOX is set.
      // On a root box an ambient IS_SANDBOX therefore makes every session/new
      // exit 1, which surfaces as a 502 from /harness/options and a composer
      // stuck on "Couldn't load Claude models". CI runs non-root and never hits
      // it; scrub the var so a root sandbox reproduces CI rather than a ghost.
      IS_SANDBOX: undefined,
      OPENAI_API_KEY: "test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk) => (serverLog += chunk.toString()))
  server.stderr?.on("data", (chunk) => (serverLog += chunk.toString()))
  await waitForHealth(`${BACKEND_URL}/api/claxedo/health`)
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      server?.once("exit", () => resolve())
      setTimeout(resolve, 5_000)
    })
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  server = undefined
  await scripted?.close()
  scripted = undefined
}

/** Harvested from live-real-harness-smoke.spec.ts's resolveBinary(). */
async function resolveBinary(name: string, envVar: string) {
  const override = process.env[envVar]?.trim()
  const binary = override || name
  try {
    if (binary.includes("/")) {
      await execFileAsync(binary, ["--version"], { timeout: 10_000 })
      return binary
    }
    const found = await execFileAsync("which", [binary], { timeout: 10_000 })
    const resolved = found.stdout.trim() || binary
    await execFileAsync(resolved, ["--version"], { timeout: 10_000 })
    return resolved
  } catch {
    return undefined
  }
}

/**
 * Behavior 9's asymmetry in one place: absent binary is a contributor's local
 * reality (visible skip) but a broken CI job (loud GATING throw), because the
 * lane installs both CLIs itself. Neither path is ever silent.
 */
function requireBinary(binary: string | undefined, name: string, hint: string) {
  if (binary) return
  const reason =
    `${name} binary not found on PATH (or its override failed \`--version\`) — ${hint} ` +
    `No authentication is required for this tier: the scripted model server is the endpoint.`
  if (process.env.CI) throw new Error(`GATING: ${reason}`)
  test.skip(true, reason)
}

async function makeWorkspace(name: string, harnessKey = "opencode") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `claxedo-tier-real-${name}-`)))
  scratchDirs.push(dir)
  await execFileAsync("git", ["init"], { cwd: dir })
  await fs.writeFile(path.join(dir, "README.md"), `real-harness-local fixture: ${name}\n`)
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: dir })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], {
    cwd: dir,
  })
  await registerWorkspace(dir)
  await seedDefaultHarness(dir, harnessKey)
  return dir
}

/**
 * Sets the server's harness default to this scenario's TARGET harness before
 * the browser ever opens the draft.
 *
 * The cross-scenario coupling is real and server-side: `GET /harness` answers
 * from `defaultHarness(await loadUserConfig())`
 * (`packages/claxedo-local-server/src/agent-config/routes/harness-routes.ts:60`), and
 * `loadUserConfig()` reads ONE server-global file — `user-agent-config.json`
 * under `CLAXEDO_DATA_DIR` (`agent-config.ts:231/67`) — with no workspace
 * keying at all. So every scenario's harness switch rewrites the seed the NEXT
 * scenario's fresh draft hydrates from, and a per-scenario `git init` worktree
 * cannot isolate it. (The CLIENT-side draft default is separately keyed by
 * `serverUrl` + `workspaceKey`, and `sessionPaneWorkspaceKey` falls back to the
 * directory — `session-workspace.ts:67` — so that half was already isolated by
 * the worktree plus `seedOneProject`'s `localStorage.clear()`.)
 *
 * Seeding the TARGET rather than resetting to `opencode` is the part that
 * matters. Resetting to opencode was tried first and did NOT help: it left the
 * hydration racing the UI switch, just from a different starting point, and an
 * A/B with and without it failed identically. Seeding the target instead makes
 * hydration and the UI selection AGREE — whichever lands last, the composer
 * ends on the harness the scenario wants, so there is no race to lose. The
 * scenario still drives the `<Select>` explicitly afterwards, so the
 * user-visible switch path is still exercised.
 *
 * This posts to the exact route the app's own harness selector posts to, so it
 * is a real precondition (same category as `registerWorkspace`), not a test
 * backdoor.
 */
async function seedDefaultHarness(dir: string, harnessKey: string) {
  const url = `${BACKEND_URL}/api/claxedo/agent-config/harness?directory=${encodeURIComponent(dir)}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: harnessKey, directory: dir }),
  })
  if (!res.ok) {
    throw new Error(
      `GATING: failed to seed the server harness default to "${harnessKey}" via ${url} (${res.status}) — ` +
        `${await res.text().catch(() => "<no body>")}. Without this every scenario inherits the previous one's ` +
        `harness (see this function's doc).`,
    )
  }
}

/**
 * Registers `dir` as a real local workspace via the same `GET /api/workspace/
 * resolve?directory=...&create=true` the app's own bootstrap fires on first
 * navigation (`src/shell/data/bootstrap.ts`'s fire-and-forget `resolveWorkspace()`
 * in `postPaint` -> `packages/claxedo-server/src/workspace/routes/index.ts:142` ->
 * `ensureWorkspace()` in `packages/claxedo-server-core/src/workspace/store/index.ts:287`).
 * Until that registration completes, `POST /session` 404s — the app's call is
 * not awaited before the composer becomes interactive, and a synthetic
 * compose-and-click does not reliably win the race a human always wins. This
 * calls the exact real endpoint, so it is a setup precondition, not a mock.
 */
async function registerWorkspace(dir: string) {
  const url = `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `GATING: failed to pre-register workspace ${dir} via ${url} (${res.status}) — ` +
        `${await res.text().catch(() => "<no body>")}`,
    )
  }
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __OPENCODE__?: { serverUrl?: string; activeDirectory?: string } }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function openDraftPrompt(page: Page, dir: string): Promise<Locator> {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  await expect(input).toHaveAttribute("contenteditable", "true")
  return input
}

async function composePrompt(page: Page, input: Locator, text: string) {
  await input.click()
  await input.fill(text)
  if (!((await input.textContent()) ?? "").includes(text)) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
  }
  await expect(input).toContainText(text, { timeout: 10_000 })
}

function sessionUrlPattern() {
  return /(?:\/s\/[^/]+|\/w\/[^/]+\/session\/[^/]+)$/
}

/**
 * Selects a harness on a DRAFT composer, and proves the selection actually
 * landed before returning.
 *
 * The current composer has one combined picker. Harness rows are grouped ACP
 * then Native SDK, so the duplicated family label's index identifies access;
 * the scenario's dialect counter remains the decisive per-variant proof.
 *
 * The selected row itself is the setup oracle. A non-empty model label is not:
 * the previous OpenCode model can remain visible while the asynchronous switch
 * is still pending, which used to let this setup return on the wrong harness.
 */
function harnessPickerTarget(harnessKey: string) {
  // The picker's built-in rows are the NATIVE harnesses only — first-party ACP
  // options left it when operator-configured ACP connections became the ACP
  // group (agent-harness-selector BUILTIN_HARNESS_OPTIONS). A first-party ACP
  // harnessKey therefore has NO picker row: those scenarios ride the seeded
  // server default (`makeWorkspace` → `seedDefaultHarness`), which the draft
  // hydrates on mount.
  if (harnessKey === "claude-acp" || harnessKey === "codex-acp" || harnessKey === "cursor-acp") return null
  if (harnessKey.startsWith("claude")) return { label: /^Claude$/, index: 0 }
  if (harnessKey.startsWith("codex")) return { label: /^Codex$/, index: 0 }
  if (harnessKey.startsWith("cursor")) return { label: /^Cursor$/, index: 0 }
  return { label: new RegExp(`^${harnessKey}$`, "i"), index: 0 }
}

async function switchDraftHarness(page: Page, harnessKey: string) {
  const trigger = page.locator('[data-action="prompt-harness-model"]').last()
  const target = harnessPickerTarget(harnessKey)
  if (!target) {
    // No picker row (first-party ACP): the seeded default is the selection
    // mechanism. Pin that the draft actually hydrated onto it before the
    // journey proceeds — same determinism as the aria-current wait below.
    await expect(trigger, `draft did not hydrate seeded harness "${harnessKey}"`).toHaveAttribute(
      "data-harness",
      harnessKey,
      { timeout: 45_000 },
    )
    return
  }
  await expect(trigger).toBeEnabled({ timeout: 30_000 })
  await trigger.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  const harnessSection = picker.locator('[data-slot="harness-picker-section"]').first()
  await expect(harnessSection).toBeVisible({ timeout: 30_000 })
  await harnessSection.click()
  const option = picker.getByRole("button", { name: target.label }).nth(target.index)
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await harnessSection.click()
  await expect(option, `draft did not adopt harness "${harnessKey}"`).toHaveAttribute("aria-current", "true", {
    timeout: 45_000,
  })
  await page.keyboard.press("Escape")
}

/**
 * 45s, not the 30s `live-real-harness-smoke` uses: `claude-sdk` resolves its
 * catalog through `ClaudeDriver.fetchModels`
 * (`packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:224`), a
 * short-lived probe query whose own `MODEL_LIST_TIMEOUT_MS` is exactly 30_000
 * (driver.ts:48) before it falls back to the static catalog. Waiting 30s for a
 * control whose worst case IS 30s makes the assertion a race against the
 * fallback rather than a check of it, which is how this first showed up as a
 * "Loading models" failure. The wait is still deterministic — it polls the
 * control's real text, never sleeps.
 */
async function waitForHarnessReady(page: Page) {
  await expect(page.locator('[data-action="prompt-harness-model"]').last()).not.toContainText(
    /Loading models|Select model/i,
    { timeout: 45_000 },
  )
  await expect(page.locator('[title="Agent runtime unreachable after timeout"]')).toHaveCount(0)
}

/**
 * Behavior 6. The load-bearing half is the LOWER bound: at least one scripted
 * call per turn on the scenario's own dialect. Zero there means the reply on
 * screen came from a provider this spec never pointed at — the exact
 * false-green the tier exists to catch, and one this suite actually hit (see
 * HARNESS NOTES' codex caveat: 3 correct markers, 0 scripted requests).
 *
 * The upper bound is deliberately loose, because "one HTTP call per turn" is
 * not a real contract. Measured directly against the scripted endpoint with the
 * real binaries: the engine adds one title call per session, and the claude CLI
 * issues TWO messages calls for a single one-token turn (the second carries a
 * `system-reminder` context block). Pinning a tight ceiling would assert the
 * harnesses' current internal chattiness, which is theirs to change — so the
 * ceiling only catches a runaway loop, and the cross-dialect check below is
 * what actually pins routing.
 */
const CALLS_PER_TURN_CEILING = 3

function expectScriptedTraffic(dialect: ScriptedDialect, turns: number) {
  const counts = scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 }
  const own = counts[dialect]
  expect(
    own,
    `expected the scripted ${dialect} endpoint to carry at least ${turns} call(s) — one per turn — but saw ${own}. ` +
      `Zero means the model traffic never reached the scripted server and the rendered reply came from a real ` +
      `provider. All counts: ${JSON.stringify(counts)}`,
  ).toBeGreaterThanOrEqual(turns)
  expect(
    own,
    `scripted ${dialect} calls (${own}) exceeded ${turns} turns x ${CALLS_PER_TURN_CEILING} — a runaway model loop`,
  ).toBeLessThanOrEqual(turns * CALLS_PER_TURN_CEILING + 1)
  for (const other of ["chat", "messages", "responses"] as const) {
    if (other === dialect) continue
    // `chat` keeps a 1-call allowance in every scenario: the server's embedded
    // engine generates the session title regardless of which harness owns the
    // conversation.
    const ceiling = other === "chat" ? 1 : 0
    expect(
      counts[other],
      `expected at most ${ceiling} scripted ${other} call(s) during a ${dialect} scenario, saw ${counts[other]} — ` +
        `a harness routed through a provider it does not own. All counts: ${JSON.stringify(counts)}`,
    ).toBeLessThanOrEqual(ceiling)
  }
}

/**
 * Picks `Scripted Model` in the opencode composer's model control.
 *
 * REQUIRED, and `OPENCODE_CONFIG_CONTENT`'s `model` pin is not a substitute:
 * that sets the ENGINE's default, but the app selects its own model and writes
 * it into the session config on first send, and an explicit per-session model
 * wins. Traced on a failing run: the app PATCHed
 * `{"model":{"providerID":"anthropic","modelID":"claude-sonnet-4-6"}}` and the
 * server's transcript recorded all three turns against `anthropic/
 * claude-sonnet-4-6`.
 *
 * That was not a cosmetic mislabel. This lane exports `ANTHROPIC_BASE_URL` for
 * the claude scenarios, so the engine's anthropic traffic reached the scripted
 * MESSAGES endpoint and answered correctly — every marker echoed, every content
 * assertion passed, and only `expectScriptedTraffic`'s per-dialect counters
 * caught that the CHAT endpoint saw zero calls. Without this the "opencode"
 * scenario silently exercised the anthropic dialect.
 *
 * OpenCode uses the same `prompt-harness-model` control as every other
 * harness; the picker owns harness, model, and effort selection together.
 *
 * Driven through the real picker rather than seeded, so the scenario exercises
 * the user's own model-selection path. Harness scenarios need none of this — a
 * harness owns its catalog and `waitForHarnessReady` already gates on it.
 */
async function selectScriptedModel(page: Page) {
  const control = page.locator('[data-action="prompt-harness-model"]').last()
  await expect(control).toBeVisible({ timeout: 30_000 })
  // `disabled` (not `aria-disabled`) while the provider catalog loads; a click
  // then is a no-op that leaves the default model in place.
  await expect(control).toBeEnabled({ timeout: 45_000 })
  await control.click()
  await expect(page.locator('[data-component="harness-model-picker"]')).toBeVisible({ timeout: 20_000 })
  // ~180 providers, virtualized: the entry is not in the DOM until the search
  // narrows to it.
  const search = page.getByRole("textbox", { name: /Search models/i }).last()
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill("Scripted")
  const option = page.getByText(/^Scripted Model$/i).last()
  await expect(
    option,
    "the scripted model is missing from the picker. The picker lists only models `resolveModelVisibility` " +
      "(models.tsx) shows: the user's explicit un-hides, plus each CONNECTED provider's default model. So check, " +
      "in order: is `tier-real` in the catalog's `connected`, and is `scripted-model` its `default` entry? " +
      "(see opencodeScriptedProviderConfig's doc — a second model in that block would decide the default by sort)",
  ).toBeVisible({ timeout: 20_000 })
  await option.click()
  await expect(control).toContainText(/Scripted Model/i, { timeout: 20_000 })
}

type HarnessCase = {
  id: string
  dialect: ScriptedDialect
} & (
  | {
      /** Both absent means "stay on the default" — no harness switch is driven. */
      option?: undefined
      harnessKey?: undefined
    }
  | {
      option: RegExp
      /** The option's `data-key` — the harness id. Paired with `option`: switching
       * needs both the label to assert against and the key to click. */
      harnessKey: string
    }
)

/**
 * The rail oracle: a session the user just started must be FINDABLE and
 * LEGIBLE in the sidebar while it runs, without a reload.
 *
 * All three assertions were reproduced by hand against a real server on
 * 2026-08-06 before being written down here:
 *   - row present: the `session.lifecycle` "created" frame does reach the
 *     client and inserts the row (this one passes today).
 *   - working dot: for the native-SDK harness the server publishes
 *     `agent.lifecycle` Busy with `tabId` = the SESSION id and NO `terminalId`.
 *     `agent-status-listener.ts:164` computes `terminalId || tabId` and writes
 *     it into the TERMINAL status map, which no chat row reads; meanwhile the
 *     chat row's own source, `GET /session/status`, never lists a native-SDK
 *     session at all (measured absent across a 30s poll during a live turn).
 *     So the dot never lights.
 *   - real title: the server replaces the "New Session" placeholder at the
 *     moment the turn completes (measured: title and `lastTurn.status
 *     ="completed"` both appear at +6.6s) with one derived from the first
 *     prompt (`fallbackSessionTitle`, session-title.ts:12) and publishes
 *     `session.updated` for it. That frame used to be dropped by
 *     `bridgeLifecycleEvent` (workspace-runtime `routes/session.ts`) — 0 such
 *     frames on the wire across a full cycle — so the rail kept the
 *     placeholder, in the wrong sort position, until an unrelated refetch
 *     happened to land. Now bridged; this assertion is the end-to-end guard
 *     that it stays bridged against a REAL server, which the mocked lane
 *     cannot prove.
 *
 * Asserted on the shared `[data-sidebar-status]` contract and the row's own
 * title slot, so a fix is free to route the signal any way it likes.
 */
async function expectRailRowTracksTheSession(
  page: Page,
  sessionId: string,
  promptText: string,
  releaseModelReply: () => void,
) {
  const row = await expectRailRowVisible({ page, sessionId, timeout: 15_000 })

  // Mid-turn: the row must show the working dot. Idle rows render a
  // relative-time label and no `[data-sidebar-status]` element at all.
  try {
    await expect(row.locator('[data-sidebar-status="working"]')).toHaveCount(1, { timeout: 20_000 })
  } finally {
    releaseModelReply()
  }

  // Once the turn settles the server has the generated title; the rail must
  // stop showing the placeholder. Matched on "not the placeholder" rather than
  // on the exact generated string, which the model chooses and may reword.
  await expect(row.locator('[data-slot="session-navigation-title"]')).not.toHaveText(
    /^(New Session|Untitled session)$/,
    { timeout: 60_000 },
  )
  void promptText
}

type HarnessUsage = { turns: number; tokens: number }

async function harnessUsage(harness: string): Promise<HarnessUsage> {
  const url = new URL("/api/claxedo/usage", BACKEND_URL)
  const until = Date.now() + 60_000
  url.searchParams.set("since", String(until - 90 * 86_400_000 + 1))
  url.searchParams.set("until", String(until))
  url.searchParams.set("timezone", "UTC")
  url.searchParams.set("group", "harness")
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`usage metering probe failed: ${response.status} ${await response.text()}`)
  const body = (await response.json()) as {
    breakdown?: { rows?: Array<Record<string, unknown>> }
  }
  const row = body.breakdown?.rows?.find((item) => item.value === harness)
  return {
    turns: Number(row?.turnCount ?? 0),
    tokens:
      Number(row?.input ?? 0) +
      Number(row?.output ?? 0) +
      Number(row?.reasoning ?? 0) +
      Number(row?.cacheRead ?? 0) +
      Number(row?.cacheWrite ?? 0),
  }
}

async function expectUsageDashboardWorks(page: Page) {
  const trigger = page.getByTestId("rail-account-trigger")
  await trigger.focus()
  await page.keyboard.press("Enter")
  const usage = page.getByRole("menuitem", { name: "Usage", exact: true })
  await expect(usage, "the real account menu did not expose the canonical Usage action").toBeVisible()
  await usage.click()

  const dialog = page.getByRole("dialog", { name: "Usage" })
  await expect(dialog, "the real Usage dialog did not open").toBeVisible({ timeout: 30_000 })
  await expect(dialog.getByRole("button", { name: "Total local usage" })).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.getByRole("button", { name: "7 days" })).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true")

  const providerTable = dialog.getByRole("table", { name: "Usage grouped by provider" })
  await expect(providerTable, "the real provider attribution table did not render").toBeVisible({ timeout: 30_000 })
  await expect(providerTable).not.toContainText("Claxedo")
  await expect(providerTable.getByRole("row").nth(1), "the real provider attribution table was empty").toBeVisible()
  await expect(
    dialog.getByRole("img", { name: /^Daily tokens by/ }),
    "the exact turn did not reach the daily chart",
  ).toBeVisible()

  await dialog.getByRole("button", { name: "Cost" }).click()
  await expect(dialog.getByRole("img", { name: /^Daily estimated API cost\./ })).toBeVisible()
  await expect(dialog).toContainText("What these tokens would cost at API rates. Not what you were billed.")

  await dialog.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(dialog.getByRole("heading", { name: "By provider" })).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole("button", { name: "Total local usage" }).click()
  // Changing attribution starts a fresh usage query. Total-local legitimately
  // has zero attributed rows on an isolated runner, in which case the
  // canonical breakdown renders its empty state instead of a table.
  const providerBreakdown = dialog.locator("section.usage-breakdown")
  await expect(dialog.getByRole("heading", { name: "By provider" })).toBeVisible({ timeout: 30_000 })
  await expect(providerBreakdown).not.toContainText("Claxedo")
  await dialog.getByRole("button", { name: "Model", exact: true }).click()
  await expect(dialog.getByRole("heading", { name: "By model" })).toBeVisible()

  await dialog.getByRole("button", { name: "Usage limits" }).click()
  await expect(dialog.getByRole("heading", { name: "Quota windows" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Usage through Claxedo" })).toBeVisible()
  await dialog.getByRole("button", { name: "Usage through Claxedo" }).click()
  await expect(dialog.getByRole("heading", { name: "By provider" })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(trigger, "closing Usage did not restore focus to the account menu trigger").toBeFocused()
}

/** Drives the shared "3 scripted turns + reload, full oracle each turn" journey. */
async function runRealHarnessJourney(page: Page, dir: string, harness: HarnessCase) {
  scripted?.resetCounts()
  const meteringKey = harness.harnessKey ?? "opencode"
  const usageBefore = await harnessUsage(meteringKey)
  const runId = `${Date.now()}`.slice(-6)
  const input = await openDraftPrompt(page, dir)

  if (harness.option) {
    await switchDraftHarness(page, harness.harnessKey)
    await waitForHarnessReady(page)
  } else {
    await selectScriptedModel(page)
  }

  const modelControl = page.locator('[data-action="prompt-harness-model"]:visible').last()
  const modelLabel = modelControl.locator('[data-slot="composer-control-label"]')
  await expect(modelLabel, `${harness.id} did not expose a model label`).toHaveText(/\S/, { timeout: 20_000 })
  const selectedModel = (await modelLabel.textContent())!.trim()
  const selectedModelPattern = new RegExp(selectedModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")

  const markers: string[] = []
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const marker = `REAL-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T${turn}`
    markers.push(marker)
    const promptText = `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
    const textbox = turn === 1 ? input : page.getByRole("textbox", { name: /Ask anything/i }).last()
    await composePrompt(page, textbox, promptText)
    if (turn === 1) scripted?.setReplyDelayMs(8_000)
    try {
      await page.locator(SELECTORS.submitControl).last().click()
      if (turn === 1) {
        await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
        const sessionId = /(?:\/s\/|\/session\/)([^/]+)$/.exec(new URL(page.url()).pathname)?.[1]
        expect(sessionId, "session route did not expose the created session id").toBeTruthy()
        // The rail is the surface the user navigates by, and until now this lane
        // — the ONLY one that runs a real harness against a real claxedo-server —
        // asserted nothing about it. Three separate rail defects shipped behind
        // that gap, all of them invisible to the mocked Tier M proofs because
        // those inject events straight onto the bus.
        await expectRailRowTracksTheSession(page, decodeURIComponent(sessionId!), promptText, () =>
          scripted?.setReplyDelayMs(0),
        )
        await expect(modelLabel, `${harness.id} lost its model label during the draft-to-session handoff`).toHaveText(
          selectedModelPattern,
        )
      }
    } finally {
      if (turn === 1) scripted?.setReplyDelayMs(0)
    }
    await expectAssistantReplyVisible(page, new RegExp(marker), {
      spec: "real-harness-local",
      scenario: `${harness.id}-turn-${turn}`,
    })
  }

  await expectLiveUserRowCount(page, markers.length)

  // Existing sessions may continue with another harness. Asserted on the trigger
  // element, not on a label lookup — the ACP and native-SDK variants render the
  // same visible name, and `getByRole("button", {name})` also matches the
  // model control on some harnesses.
  if (harness.option) {
    const trigger = page.locator('[data-action="prompt-harness-model"]').last()
    await expect(trigger).not.toContainText(/Loading models|Select model|^$/)
    await expect(trigger).toBeEnabled()
    await trigger.click()
    await expect(
      page.locator('[data-component="harness-model-picker"] [data-slot="harness-picker-section"]').first(),
      "existing session should allow continuing with another harness",
    ).toBeEnabled()
    await page.keyboard.press("Escape")
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(modelLabel, `${harness.id} lost its model label after reload`).toHaveText(selectedModelPattern, {
    timeout: 20_000,
  })
  await expectAssistantReplyVisible(page, new RegExp(markers[TURNS - 1]!), {
    spec: "real-harness-local",
    scenario: `${harness.id}-reload`,
  })
  await expectLiveTurnsSettledAfterReload(page, markers)

  const usageAfter = await harnessUsage(meteringKey)
  const exactTokensPerTurn = harness.dialect === "chat" ? 15 : 2
  expect(
    usageAfter.turns - usageBefore.turns,
    `${harness.id} did not settle exactly one usage fact per scripted turn`,
  ).toBe(TURNS)
  expect(
    usageAfter.tokens - usageBefore.tokens,
    `${harness.id} did not preserve the scripted provider's exact token totals`,
  ).toBe(TURNS * exactTokensPerTurn)

  await expectUsageDashboardWorks(page)

  // Behavior 6, asserted last so a reload-time re-fetch cannot inflate it.
  expectScriptedTraffic(harness.dialect, TURNS)
}

type SubagentHarnessCase = HarnessCase & {
  tool: { name: string; input: unknown; namespace?: string }
  openable: boolean
  sessionID?: string
  workspaceID?: string
  central?: boolean
  modelName?: RegExp
  modelSearch?: string
  permissionMode?: string
  effort?: string
}

async function runRealSubagentJourney(page: Page, dir: string, harness: SubagentHarnessCase) {
  scripted?.resetCounts()
  const input = harness.sessionID
    ? await openExistingPrompt(page, dir, harness.sessionID, harness.workspaceID, harness.central)
    : await openDraftPrompt(page, dir)

  if (!harness.sessionID && harness.option) {
    await switchDraftHarness(page, harness.harnessKey)
    if (harness.modelName) await selectHarnessModel(page, harness.modelName, harness.modelSearch)
    await waitForHarnessReady(page)
  } else if (!harness.sessionID) {
    await selectScriptedModel(page)
  }

  if (harness.effort) {
    const control = page.locator('[data-action="prompt-harness-model"]').last()
    await control.click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    await picker
      .locator('[data-slot="harness-picker-section"]')
      .filter({ hasText: /^Effort/ })
      .click()
    await picker.getByRole("button", { name: harness.effort, exact: true }).click()
    await expect(control).toContainText(harness.effort)
  }

  if (harness.permissionMode) {
    const permission = page.locator('[data-action="prompt-permission-mode"]').last()
    await expect(permission).toBeEnabled({ timeout: 30_000 })
    await permission.click()
    const row = page.locator(`[data-permission-mode-row][data-mode="${harness.permissionMode}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    await expect(permission).toHaveAttribute("data-mode", harness.permissionMode)
  }

  const marker = `SUBAGENT-${harness.id.replace(/[^a-z0-9]/gi, "")}-${`${Date.now()}`.slice(-6)}`
  scripted?.scriptTool({ ...harness.tool, whenPromptIncludes: marker })
  scripted?.setReplyDelayMs(process.env.CLAXEDO_E2E_RECORD_DEMO === "1" ? 2_000 : 750)
  try {
    await composePrompt(
      page,
      input,
      `Delegate one child task, then reply with exactly this one token and nothing else: ${marker}`,
    )
    if (harness.permissionMode) {
      await expect(page.locator('[data-action="prompt-permission-mode"]').last()).toHaveAttribute(
        "data-mode",
        harness.permissionMode,
      )
    }
    const submit = page.locator(SELECTORS.submitControl).last()
    if (harness.id === "pi") {
      const control = page.locator('[data-action="prompt-harness-model"]').last()
      await expect(control).toHaveAttribute("data-harness", "pi", { timeout: 30_000 })
      await expect(page.getByText("This Pi model is no longer available", { exact: true })).toHaveCount(0)
    }
    await expect(submit, `${harness.id} composer never became submit-ready`).toHaveAttribute("aria-label", "Send", {
      timeout: 30_000,
    })
    await submit.click()
    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expect
      .poll(() => scripted?.requests.some((request) => request.reply.kind === "tool") ?? false, {
        message: `${harness.id} never received its scripted tool payload`,
        timeout: 30_000,
      })
      .toBe(true)
    await expect(page.getByText("Could not save session config", { exact: true })).toHaveCount(0)
    const card = page.locator('[data-component="task-tool-card"]').last()
    await expect(card, `${harness.id} never rendered its native delegation as a subagent card`).toBeVisible({
      timeout: 60_000,
    })
    await expect(card.locator('[data-slot="subagent-status"]')).toHaveText(/Pending|Working/, { timeout: 30_000 })
    await demoBeat(page)
    await expect(card.locator('[data-slot="subagent-status"]')).toHaveText("Completed", {
      timeout: 90_000,
    })
    await expect(page.locator(SELECTORS.userMessageContent).filter({ hasText: marker })).toBeVisible()
    await demoBeat(page)

    const anchor = card.locator("xpath=ancestor::a[1]")
    if (!harness.openable) {
      await expect(card.locator('[data-slot="basic-tool-tool-subtitle"]')).toContainText("Transcript unavailable")
      await expect(anchor).toHaveCount(0)
    } else {
      await expect(anchor, `${harness.id} completed without an openable child transcript`).toHaveCount(1)
      await anchor.click()
      await expect(page.locator("[data-subagent-child-heading]")).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText("Subagent sessions cannot be prompted.", { exact: true })).toBeVisible()
      await expectAssistantReplyVisible(page, "ok", {
        spec: "real-harness-local",
        scenario: `${harness.id}-subagent-child`,
      })
      await demoBeat(page)
    }
  } finally {
    scripted?.setReplyDelayMs(0)
  }

  const toolRequest = scripted?.requests.find((request) => request.reply.kind === "tool")
  expect(toolRequest?.reply).toEqual({ kind: "tool", ...harness.tool })
  const counts = scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 }
  expect(
    counts[harness.dialect],
    `${harness.id} did not execute through its scripted provider endpoint`,
  ).toBeGreaterThanOrEqual(2)
  for (const other of ["chat", "messages", "responses"] as const) {
    if (other === harness.dialect) continue
    expect(counts[other], `${harness.id} leaked model traffic onto ${other}`).toBeLessThanOrEqual(
      other === "chat" ? 1 : 0,
    )
  }
}

async function runWorkspaceSubagentJourney(
  page: Page,
  workspaceName: string,
  bootstrapHarness: string | undefined,
  harness: SubagentHarnessCase,
) {
  const dir = await makeWorkspace(workspaceName, bootstrapHarness)
  await seedOneProject(page, dir)
  await runRealSubagentJourney(page, dir, harness)
}

async function runCursorHarnessBoundary(page: Page) {
  scripted?.resetCounts()
  const dir = await makeWorkspace("cursor", "cursor-acp")
  await seedOneProject(page, dir)
  const input = await openDraftPrompt(page, dir)
  await switchDraftHarness(page, "cursor-acp")

  const notice = page.locator("[data-component='composer-notice'][data-notice='runtime-unavailable']")
  const modelControl = page.locator('[data-action="prompt-harness-model"]')
  await expect
    .poll(
      async () => ((await notice.count()) > 0 ? "unavailable" : (await modelControl.count()) > 0 ? "ready" : "pending"),
      {
        timeout: 30_000,
        message: "composer settled into neither the cursor-ready nor the runtime-unavailable state",
      },
    )
    .not.toBe("pending")

  if ((await notice.count()) > 0) {
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveAttribute("data-tone", "critical")
    await expect(notice.locator("[data-action='composer-notice-action']")).toBeVisible()
    await composePrompt(page, input, "tier-real cursor unavailable attempt")
    await page.locator(SELECTORS.submitControl).last().click()
  } else {
    await expect(modelControl).toHaveCount(1)
    await expect(modelControl.last()).not.toContainText(/Loading models|Select model/i, { timeout: 30_000 })
  }
  await demoBeat(page)

  await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
  await expect(page.locator('[data-action="prompt-harness"]')).toHaveCount(0)
  expect(
    scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 },
    "expected the scripted model server to receive zero requests during the cursor scenario — any count here means " +
      "selecting Cursor routed through a provider it does not own",
  ).toEqual({ chat: 0, messages: 0, responses: 0 })
}

async function demoBeat(page: Page) {
  if (process.env.CLAXEDO_E2E_RECORD_DEMO !== "1") return
  // Recording-only pacing. Every behavioral wait is asserted independently;
  // normal E2E runs never pay for these pauses.
  await page.waitForTimeout(1_200)
}

async function createPickerSession(dir: string) {
  return createHarnessSession(dir, {
    title: "Timeline turn picker",
    harness: "opencode",
    providerID: "tier-real",
    modelID: "scripted-model",
  })
}

async function createHarnessSession(
  dir: string,
  input: {
    title: string
    harness: string
    providerID: string
    modelID: string
  },
) {
  const response = await fetch(`${BACKEND_URL}/session?directory=${encodeURIComponent(dir)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      harness: { type: input.harness, model: `${input.providerID}/${input.modelID}` },
      model: { providerID: input.providerID, modelID: input.modelID },
    }),
  })
  if (response.status !== 201) {
    throw new Error(`GATING: failed to seed picker session (${response.status}): ${await response.text()}`)
  }
  return (await response.json()) as { id: string }
}

async function updateSessionConfig(dir: string, sessionID: string, config: unknown) {
  const response = await fetch(
    `${BACKEND_URL}/session/${encodeURIComponent(sessionID)}/config?directory=${encodeURIComponent(dir)}`,
    { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(config) },
  )
  if (!response.ok)
    throw new Error(`GATING: failed to update session config (${response.status}): ${await response.text()}`)
}

async function createPiSession(dir: string) {
  const workspaceResponse = await fetch(
    `${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(dir)}&create=true`,
  )
  if (!workspaceResponse.ok)
    throw new Error(`GATING: failed to resolve Pi workspace: ${await workspaceResponse.text()}`)
  const workspace = (await workspaceResponse.json()) as { workspaceId: string }
  const response = await fetch(`${BACKEND_URL}/api/control/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode: "hybrid",
      title: "Pi subagent showcase",
      harness: "pi",
      workspaceId: workspace.workspaceId,
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      toolSandbox: { kind: "workspace-runtime", workspaceId: workspace.workspaceId },
    }),
  })
  if (!response.ok)
    throw new Error(`GATING: failed to create Pi session (${response.status}): ${await response.text()}`)
  const created = (await response.json()) as { session: { id: string } }
  const metadataResponse = await fetch(
    `${BACKEND_URL}/api/claxedo/session/${encodeURIComponent(created.session.id)}/meta`,
  )
  const metadata = await metadataResponse.json().catch(() => undefined) as { tags?: unknown } | undefined
  if (!metadataResponse.ok || !Array.isArray(metadata?.tags) || !metadata.tags.includes("harness:pi")) {
    throw new Error(
      `GATING: Pi session metadata lost its canonical harness identity (${metadataResponse.status}): ${JSON.stringify(metadata)}`,
    )
  }
  return { ...created, workspaceId: workspace.workspaceId }
}

async function openExistingPrompt(page: Page, dir: string, sessionID: string, workspaceID?: string, central = false) {
  await page.goto(
    central || !workspaceID
      ? `/s/${encodeURIComponent(sessionID)}`
      : `/w/${encodeURIComponent(workspaceID)}/session/${encodeURIComponent(sessionID)}`,
    { waitUntil: "domcontentloaded" },
  )
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  return input
}

async function selectHarnessModel(page: Page, name: RegExp, searchText?: string) {
  const control = page.locator('[data-action="prompt-harness-model"]').last()
  await control.click()
  const picker = page.locator('[data-component="harness-model-picker"]')
  const modelSection = picker.locator('[data-slot="harness-picker-section"]').filter({ hasText: /^Model/ })
  await modelSection.click()
  if (searchText) {
    const search = picker.getByRole("textbox", { name: /Search models/i })
    await search.fill(searchText)
  }
  const option = picker.getByRole("button", { name }).last()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(control).toContainText(name, { timeout: 30_000 })
}

function seedPickerTurn(dir: string, sessionID: string, turn: number) {
  const marker = `PICKER-${String(turn).padStart(2, "0")}-${Date.now().toString().slice(-5)}`
  const prompt = `Reply with exactly this one token and nothing else: ${marker}`
  const n = String(turn).padStart(2, "0")
  const messageID = `msg_seed_user_${n}`
  const assistantID = `msg_seed_assistant_${n}`
  const created = Date.now() - (TURN_PICKER_TURNS - turn + 1) * 60_000
  const { DatabaseSync: SQLiteDatabase } = createRequire(import.meta.url)("node:sqlite") as
    typeof import("node:sqlite")
  const database = new SQLiteDatabase(path.join(dataDir, "opencode-engine", "opencode.db"))
  database.exec("PRAGMA busy_timeout = 5000")
  const run = (sql: string, values: (string | number)[]) => database.prepare(sql).run(...values)
  database.exec("BEGIN IMMEDIATE")
  try {
    run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)", [
      messageID,
      sessionID,
      created,
      created,
      JSON.stringify({
        role: "user",
        time: { created },
        agent: "build",
        model: { providerID: "tier-real", modelID: "scripted-model" },
        summary: { diffs: [] },
      }),
    ])
    run(
      "INSERT INTO part (id, message_id, session_id, ordinal, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [`prt_seed_user_${n}`, messageID, sessionID, 0, created, created, JSON.stringify({ type: "text", text: prompt })],
    )
    run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)", [
      assistantID,
      sessionID,
      created + 500,
      created + 1_500,
      JSON.stringify({
        role: "assistant",
        time: { created: created + 500, completed: created + 1_500 },
        parentID: messageID,
        agent: "build",
        providerID: "tier-real",
        modelID: "scripted-model",
        mode: "build",
        path: { cwd: dir, root: dir },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      }),
    ])
    run(
      "INSERT INTO part (id, message_id, session_id, ordinal, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        `prt_seed_assistant_${n}`,
        assistantID,
        sessionID,
        0,
        created + 500,
        created + 1_500,
        JSON.stringify({
          type: "text",
          text: marker,
          time: { start: created + 500, end: created + 1_500 },
        }),
      ],
    )
    database.exec("COMMIT")
  } finally {
    database.close()
  }
  return { marker, prompt, messageID }
}

test.describe("real harness journeys @core @tier-real", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run real-harness-local against a real claxedo-server + real harness " +
      "binaries pointed at the scripted model endpoint. This lane bakes its own backend origin " +
      "(VITE_CLAXEDO_SERVER_URL) into the app build, so it cannot ride a sharded core run — it has its own CI job. " +
      "Unset -> loud, visible skip per e2e/INVARIANTS.md rule 6, never a silent no-op.",
  )

  test.beforeAll(async ({}, testInfo) => {
    if (!TIER_REAL) return
    // waitForHealth owns a 90-second clean-runner boot budget. Keep the hook's
    // outer deadline longer so a real health failure reports its server-log
    // diagnostic instead of being replaced by Playwright's 60-second default.
    testInfo.setTimeout(120_000)
    await startServer()
  })

  test.afterAll(async () => {
    if (!TIER_REAL) return
    await stopServer()
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    await Promise.all(scratchDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)))
  })

  test.beforeEach(async ({}, testInfo) => {
    // The scripted endpoint answers instantly, but subprocess spawn plus the
    // ACP handshake still costs real seconds on each scenario's first turn.
    testInfo.setTimeout(240_000)
  })

  test.afterEach(async ({}, testInfo) => {
    // The server's stdout/stderr is buffered into `serverLog` and otherwise
    // surfaced only on GATING boot failures. On a FAILED test it is the only
    // record of what the engine actually did (or refused to do) on a CI
    // runner nobody can shell into — the first tier-real CI red burned a full
    // round because the picker said "No model results" and nothing said why.
    if (testInfo.status !== testInfo.expectedStatus && serverLog) {
      await testInfo.attach("claxedo-server.log", { body: serverLog, contentType: "text/plain" })
    }
  })

  test("opencode harness completes exact turns, reload, and visible usage — behaviors 1,6,9,11", async ({ page }) => {
    const dir = await makeWorkspace("opencode")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, { id: "opencode", dialect: "chat" })
  })

  test("local new-worktree session receives its first reply — behaviors 1,6,9,12", async ({ page }) => {
    scripted?.resetCounts()
    const dir = await makeWorkspace("new-local-worktree")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await selectScriptedModel(page)

    const environment = page.locator('[data-slot="context-chip-environment"]')
    await environment.click()
    const environmentPicker = page.locator('[data-context-chip-picker="context-chip-environment"]')
    await expect(environmentPicker).toBeVisible()
    await environmentPicker.getByRole("button", { name: /^Local/ }).click()
    await expect(environment.locator('[data-slot="context-chip-label"]')).toHaveText("Local")

    const workspace = page.locator('[data-slot="context-chip-worktree"]')
    await workspace.click()
    const workspacePicker = page.locator('[data-context-chip-picker="context-chip-worktree"]')
    await expect(workspacePicker).toBeVisible()
    await workspacePicker.locator('[data-slot="context-chip-action"]').click()
    await expect(workspace.locator('[data-slot="context-chip-label"]')).toHaveText("New local worktree")

    const marker = `NEW-WORKTREE-${Date.now().toString().slice(-6)}`
    await composePrompt(page, input, `Reply with exactly this one token and nothing else: ${marker}`)
    const worktreeCreated = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === "POST" && url.pathname === "/experimental/worktree"
    })
    await page.locator(SELECTORS.submitControl).last().click()
    const worktreeResponse = await worktreeCreated
    expect(worktreeResponse.status(), await worktreeResponse.text()).toBe(200)
    const created = await worktreeResponse.json() as { directory: string; name: string; branch: string }
    expect(created.directory).not.toBe(dir)
    const canonicalDirectory = await fs.realpath(created.directory)
    expect(created.directory).toBe(canonicalDirectory)

    await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    await expectAssistantReplyVisible(page, marker)
    expectScriptedTraffic("chat", 1)

    const environmentCard = page.getByRole("complementary", { name: "Session environment" })
    await expect(environmentCard).toBeVisible()
    const expandEnvironment = environmentCard.getByRole("button", { name: "Expand Environment" })
    if (await expandEnvironment.isVisible()) await expandEnvironment.click()
    const worktreeCopy = environmentCard.getByRole("button", { name: `Copy worktree name ${created.name}` })
    const branchCopy = environmentCard.getByRole("button", { name: `Copy branch name ${created.branch}` })
    await expect(worktreeCopy).toBeVisible()
    await expect(branchCopy).toBeVisible()
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin })
    await worktreeCopy.click()
    await expect(environmentCard.getByRole("button", { name: `Copied worktree name ${created.name}` })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(created.name)
    await branchCopy.click()
    await expect(environmentCard.getByRole("button", { name: `Copied branch name ${created.branch}` })).toBeVisible()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(created.branch)
    const environmentEvidence = path.join(
      APP_DIR,
      "test-results/evidence/real-harness-local/local-new-worktree-environment-card.png",
    )
    await fs.mkdir(path.dirname(environmentEvidence), { recursive: true })
    await page.screenshot({ path: environmentEvidence })

    const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: dir })
    expect(listed.stdout).toContain(`worktree ${canonicalDirectory}`)
  })

  test("timeline turn picker previews one seeded turn and appears only after 10 — behavior 10", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(600_000)
    const dir = await makeWorkspace("turn-picker")
    await seedOneProject(page, dir)
    const session = await createPickerSession(dir)
    const turns: ReturnType<typeof seedPickerTurn>[] = []
    for (let turn = 1; turn < TURN_PICKER_TURNS; turn += 1) {
      turns.push(await seedPickerTurn(dir, session.id, turn))
    }

    await page.goto(`/s/${session.id}#message-${turns[0]!.messageID}`, { waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    const sessionRoot = page
      .locator(`[data-testid="session-page-root"][data-session-id="${session.id}"][data-session-messages-ready="true"]`)
      .filter({ visible: true })
    await expect(sessionRoot).toHaveAttribute("data-session-visible-user-count", String(TURN_PICKER_TURNS - 1), {
      timeout: 30_000,
    })
    await expect(
      page.locator('[data-component="message-nav-hovercard"]'),
      "turn picker rendered at 10 turns",
    ).toHaveCount(0)

    turns.push(await seedPickerTurn(dir, session.id, TURN_PICKER_TURNS))
    await page.reload({ waitUntil: "domcontentloaded" })

    await expect(sessionRoot).toHaveAttribute("data-session-visible-user-count", String(TURN_PICKER_TURNS))
    const picker = sessionRoot.locator('[data-component="message-nav-hovercard"]')
    const ticks = picker.locator('[data-slot="message-nav-tick-button"]')
    await expect(picker).toBeVisible()
    await expect(ticks).toHaveCount(TURN_PICKER_TURNS)
    expect(
      await ticks.evaluateAll((items) =>
        items.map((item) => ({ tagName: item.tagName, role: item.getAttribute("role") })),
      ),
    ).toEqual(Array.from({ length: TURN_PICKER_TURNS }, () => ({ tagName: "BUTTON", role: null })))
    await expect(picker.locator('[data-slot="message-nav-tick-button"][aria-current="step"]')).toHaveCount(1)
    await expect(picker.locator('[data-slot="message-nav-tick-button"][data-distance="0"]')).toHaveCount(1)
    await demoBeat(page)

    const assertPreview = async (index: number) => {
      await ticks.nth(index).hover()
      const preview = page.locator('[data-slot="message-nav-turn-preview"]:visible')
      await expect(preview, `turn ${index + 1} preview did not open`).toHaveCount(1)
      await expect(preview.locator('[data-slot="message-nav-preview-user"]')).toContainText(turns[index]!.prompt)
      await expect(preview.locator('[data-slot="message-nav-preview-assistant"]')).toContainText(turns[index]!.marker)
      return preview
    }

    await ticks.nth(1).focus()
    const focusedPreview = page.locator('[data-slot="message-nav-turn-preview"]:visible')
    await expect(focusedPreview.locator('[data-slot="message-nav-preview-user"]')).toContainText(turns[1]!.prompt)
    await page.keyboard.press("Escape")
    await expect(focusedPreview).toHaveCount(0)
    await expect(ticks.nth(1)).toBeFocused()
    await ticks.nth(1).evaluate((element) => element.blur())

    const firstPreview = await assertPreview(1)
    await firstPreview.hover()
    await expect(firstPreview).toBeVisible()
    await demoBeat(page)
    await assertPreview(4)
    await expect
      .poll(() =>
        ticks.evaluateAll((items) =>
          items.map((item) => {
            const line = item.querySelector<HTMLElement>('[data-slot="message-nav-tick-line"]')!
            return Math.round(line.getBoundingClientRect().width)
          }),
        ),
      )
      .toEqual([8, 11, 15, 21, 28, 21, 15, 11, 8, 8, 8])
    expect(
      await ticks.evaluateAll((items) => {
        const styles = items.map((item) =>
          getComputedStyle(item.querySelector<HTMLElement>('[data-slot="message-nav-tick-line"]')!),
        )
        return styles.flatMap((style, index) =>
          style.backgroundColor === styles[4]!.backgroundColor && style.height === styles[4]!.height ? [index] : [],
        )
      }),
    ).toEqual([4])
    await demoBeat(page)
    await ticks.nth(4).click()
    await expect(
      page.locator(SELECTORS.userMessageContent).filter({ hasText: turns[4]!.prompt }).last(),
      "clicked turn did not scroll into the timeline viewport",
    ).toBeInViewport()
    await demoBeat(page)
  })

  test("claude ACP harness completes exact turns, reload, and visible usage — behaviors 2,6,8,9,11", async ({
    page,
  }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the Claude CLI to include the claude-acp harness in this lane.")
    const dir = await makeWorkspace("claude-acp", "claude-acp")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, {
      id: "claude-acp",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude-acp",
    })
  })

  test("claude native SDK harness completes exact turns, reload, and visible usage — behaviors 3,6,8,9,11", async ({
    page,
  }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(
      binary,
      "claude",
      "the native claude-sdk harness resolves its model catalog through the same CLI installation.",
    )
    const dir = await makeWorkspace("claude-sdk", "claude-sdk")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, {
      id: "claude-sdk",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude-sdk",
    })
  })

  test("claude native SDK runs a provider-issued Agent call as an openable subagent", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the Claude CLI to exercise its native Agent tool.")
    const dir = await makeWorkspace("claude-sdk-subagent", "claude-sdk")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "claude-sdk",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude-sdk",
      tool: {
        name: "Agent",
        input: {
          description: "Verify child delegation",
          prompt: "Reply with exactly CHILD-CLAUDE-NATIVE",
          subagent_type: "general-purpose",
          run_in_background: false,
        },
      },
      openable: true,
      permissionMode: "bypassPermissions",
    })
  })

  test("claude ACP runs a provider-issued Agent call as an openable subagent", async ({ page }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the Claude CLI to exercise ACP subagents.")
    const dir = await makeWorkspace("claude-acp-subagent", "claude-acp")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "claude-acp",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude-acp",
      tool: {
        name: "Agent",
        input: {
          description: "Verify ACP child delegation",
          prompt: "Reply with exactly CHILD-CLAUDE-ACP",
          subagent_type: "general-purpose",
          run_in_background: false,
        },
      },
      openable: true,
      permissionMode: "bypassPermissions",
    })
  })

  test("OpenCode runs a provider-issued task call as an openable subagent", async ({ page }) => {
    const dir = await makeWorkspace("opencode-subagent")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "opencode",
      dialect: "chat",
      tool: {
        name: "task",
        input: {
          description: "Verify OpenCode child delegation",
          prompt: "Reply with exactly CHILD-OPENCODE",
          subagent_type: "general",
          background: false,
        },
      },
      openable: true,
    })
  })

  test("Pi runs a provider-issued subagent call as an openable child session", async ({ page }) => {
    const dir = await makeWorkspace("pi-subagent", "pi")
    await seedOneProject(page, dir)
    const session = await createPiSession(dir)
    await runRealSubagentJourney(page, dir, {
      id: "pi",
      dialect: "messages",
      sessionID: session.session.id,
      workspaceID: session.workspaceId,
      central: true,
      tool: {
        name: "subagent",
        input: {
          task: "Reply with exactly CHILD-PI",
          title: "Verify Pi child delegation",
          background: false,
        },
      },
      openable: true,
    })
  })

  test("codex ACP harness completes exact turns, reload, and visible usage — behaviors 4,6,8,9,11", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to include the codex-acp harness in this lane.")
    const dir = await makeWorkspace("codex-acp", "codex-acp")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, {
      id: "codex-acp",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex-acp",
    })
  })

  test("codex native SDK harness completes exact turns, reload, and visible usage — behaviors 5,6,8,9,11", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "the native codex-app-server harness drives the same CLI's `app-server` subcommand.")
    const dir = await makeWorkspace("codex-sdk", "codex-app-server")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, {
      id: "codex-sdk",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex-app-server",
    })
  })

  test("codex native SDK runs a provider-issued spawn_agent call as an openable subagent", async ({ page }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to exercise its native collaboration tool.")
    const dir = await makeWorkspace("codex-sdk-subagent", "codex-app-server")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "codex-sdk",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex-app-server",
      tool: {
        name: "spawn_agent",
        input: {
          task_name: "demo_child",
          message: "Reply with exactly CHILD-CODEX-NATIVE",
        },
      },
      openable: true,
      permissionMode: "full-access",
      effort: "Ultra",
    })
  })

  test("codex ACP runs a provider-issued spawn_agent call as a status-only subagent", async ({ page }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to exercise ACP subagent metadata.")
    const dir = await makeWorkspace("codex-acp-subagent", "codex-acp")
    await seedOneProject(page, dir)
    await runRealSubagentJourney(page, dir, {
      id: "codex-acp",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex-acp",
      tool: {
        name: "spawn_agent",
        namespace: "agents",
        input: {
          task_name: "demo_child",
          message: "Reply with exactly CHILD-CODEX-ACP",
        },
      },
      openable: false,
      permissionMode: "agent-full-access",
      effort: "Ultra",
    })
  })

  test("cursor harness materializes without silently routing through another provider — behavior 7", async ({
    page,
  }) => {
    // Cursor cannot be redirected at the scripted endpoint (proprietary API, no
    // base-URL knob — see HARNESS NOTES), so this scenario runs no turn. What it
    // proves is the invariant-4 half that a scripted turn could never prove
    // anyway: selecting Cursor either locks in as itself or reports itself
    // unavailable, and in NEITHER case does anything leak onto a provider this
    // spec pointed elsewhere.
    await runCursorHarnessBoundary(page)
  })

  test("cross-harness subagents demo records every supported agent in one journey", async ({ page }, testInfo) => {
    test.skip(process.env.CLAXEDO_E2E_RECORD_DEMO !== "1", "Recording-only cohesive every-harness demo journey")
    testInfo.setTimeout(900_000)

    requireBinary(
      await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN"),
      "claude",
      "install the Claude CLI to record native and ACP subagents.",
    )
    requireBinary(
      await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN"),
      "codex",
      "install the Codex CLI to record native and ACP subagents.",
    )

    await runWorkspaceSubagentJourney(page, "demo-claude-sdk", "claude-sdk", {
      id: "claude-sdk",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude-sdk",
      tool: {
        name: "Agent",
        input: {
          description: "Verify child delegation",
          prompt: "Reply with exactly CHILD-CLAUDE-NATIVE",
          subagent_type: "general-purpose",
          run_in_background: false,
        },
      },
      openable: true,
      permissionMode: "bypassPermissions",
    })
    await runWorkspaceSubagentJourney(page, "demo-claude-acp", "claude-acp", {
      id: "claude-acp",
      dialect: "messages",
      option: /^Claude$/,
      harnessKey: "claude-acp",
      tool: {
        name: "Agent",
        input: {
          description: "Verify ACP child delegation",
          prompt: "Reply with exactly CHILD-CLAUDE-ACP",
          subagent_type: "general-purpose",
          run_in_background: false,
        },
      },
      openable: true,
      permissionMode: "bypassPermissions",
    })
    await runWorkspaceSubagentJourney(page, "demo-opencode", undefined, {
      id: "opencode",
      dialect: "chat",
      tool: {
        name: "task",
        input: {
          description: "Verify OpenCode child delegation",
          prompt: "Reply with exactly CHILD-OPENCODE",
          subagent_type: "general",
          background: false,
        },
      },
      openable: true,
    })

    const piDir = await makeWorkspace("demo-pi", "pi")
    await seedOneProject(page, piDir)
    const pi = await createPiSession(piDir)
    await runRealSubagentJourney(page, piDir, {
      id: "pi",
      dialect: "messages",
      sessionID: pi.session.id,
      workspaceID: pi.workspaceId,
      central: true,
      tool: {
        name: "subagent",
        input: {
          task: "Reply with exactly CHILD-PI",
          title: "Verify Pi child delegation",
          background: false,
        },
      },
      openable: true,
    })

    await runWorkspaceSubagentJourney(page, "demo-codex-sdk", "codex-app-server", {
      id: "codex-sdk",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex-app-server",
      tool: {
        name: "spawn_agent",
        input: {
          task_name: "demo_child",
          message: "Reply with exactly CHILD-CODEX-NATIVE",
        },
      },
      openable: true,
      permissionMode: "full-access",
      effort: "Ultra",
    })
    await runWorkspaceSubagentJourney(page, "demo-codex-acp", "codex-acp", {
      id: "codex-acp",
      dialect: "responses",
      option: /^Codex$/,
      harnessKey: "codex-acp",
      tool: {
        name: "spawn_agent",
        namespace: "agents",
        input: {
          task_name: "demo_child",
          message: "Reply with exactly CHILD-CODEX-ACP",
        },
      },
      openable: false,
      permissionMode: "agent-full-access",
      effort: "Ultra",
    })
    await runCursorHarnessBoundary(page)
  })
})
