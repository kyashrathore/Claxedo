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
 *   `[data-action="prompt-harness"]` — harness `<Select>` trigger. Targeted by
 *     this attribute, never by its current label: the label is whatever the
 *     server/workspace-scoped draft default last resolved to, so it only reads
 *     "OpenCode" for the first scenario in a run (see `switchDraftHarness`).
 *   `[role="option"][data-key="<harness-id>"]` — a listbox entry. Options are
 *     picked by `data-key`, never by label+index: see `switchDraftHarness`.
 *   `[data-action="prompt-harness-model"]` — harness model control; asserted
 *     only to stop reading "Loading models"/"Select model", never for a
 *     specific model name.
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
 *   - `CLAXEDO_WORKGRAPH_REPOSITORY` must be set or the spawned server fatals
 *     before `/api/claxedo/health` ever answers.
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

const execFileAsync = promisify(execFile)

const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const BACKEND_PORT = Number(process.env.CLAXEDO_TIER_REAL_BACKEND_PORT ?? 4317)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const TURNS = 3

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
  const pids = found?.stdout.split("\n").map((line) => line.trim()).filter(Boolean) ?? []
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
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      // Without a workgraph repository the spawned server fatals before
      // /api/claxedo/health ever answers.
      CLAXEDO_WORKGRAPH_REPOSITORY: REPO_ROOT,
      // The whole tier, in four env vars — see HARNESS NOTES' injection table.
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(scripted.v1Url)),
      TIER_REAL_API_KEY: "test-key",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      ...claudeScriptedEnv(scripted.url, claudeConfigDir),
      // Both codex knobs: CODEX_HOME redirects the CLI itself (the load-bearing
      // one, for both codex-app-server and codex-acp), CODEX_CONFIG additionally
      // reaches the codex-acp wrapper's own startup path.
      CODEX_HOME: codexHome,
      CODEX_CONFIG: codexScriptedConfigJson(scripted.v1Url),
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
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: dir })
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
 * (`packages/claxedo-server/src/routes/agent-config-harness-routes.ts:60`), and
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
 * in `postPaint` -> `packages/claxedo-server/src/routes/workspace.ts:142` ->
 * `ensureWorkspace()` in `packages/claxedo-server/src/workspace-store.ts:287`).
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
 * Two things here are deliberate and were each paid for:
 *
 * 1. The trigger is found by `[data-action="prompt-harness"]`, never by its
 *    label. The label is whatever the server/workspace-scoped draft default
 *    last resolved to (INVARIANTS #2: "a new draft reads one
 *    server/workspace-scoped `{harness, model}` pair; an explicit harness
 *    action atomically replaces that pair for future drafts"), so it only reads
 *    "OpenCode" for the FIRST scenario in a run. A per-scenario `git init`
 *    worktree does NOT isolate this — the pair is not keyed by directory.
 *
 * 2. The option is found by `data-key` (the harness id), never by label +
 *    `nth(index)`. "Claude"/"Codex"/"Cursor" each appear TWICE in the listbox,
 *    once under "ACP" and once under "Native SDK"
 *    (`agent-harness-selector.tsx`'s `harnessOptionGroup`), so an index is only
 *    correct while every group renders every harness; when the list is still
 *    resolving, an index silently selects the NEIGHBOURING harness. DOM
 *    confirmed against the running app: `<li role="option" data-key="codex-acp"
 *    data-slot="select-select-item">`.
 *
 * The retry exists because a click can be accepted by the listbox and still not
 * commit: the composer is observed back on its previous harness with the menu
 * closed, most often when a hydration for the freshly-created workspace lands
 * between the open and the click. Re-opening and re-clicking settles it. This
 * is a real app race, NOT something this spec should paper over silently — it
 * is called out in HARNESS NOTES, and the bounded retry keeps the tier able to
 * test the thing it exists to test (model routing) instead of failing in the
 * setup step every other run.
 */
/** Trigger label for a harness id — `agent-harness-selector.tsx`'s `HARNESS_OPTION_LABELS`. */
function expectedTriggerLabel(harnessKey: string) {
  if (harnessKey.startsWith("claude")) return /^Claude$/
  if (harnessKey.startsWith("codex")) return /^Codex$/
  if (harnessKey.startsWith("cursor")) return /^Cursor$/
  return new RegExp(`^${harnessKey}$`, "i")
}

async function switchDraftHarness(page: Page, harnessKey: string) {
  const trigger = page.locator('[data-action="prompt-harness"]').last()
  const option = page.locator(`[role="option"][data-key="${harnessKey}"]`)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await expect(trigger).toBeEnabled({ timeout: 30_000 })
    await trigger.click()
    await expect(option).toBeVisible({ timeout: 30_000 })
    await option.click()
    // Checked against the TRIGGER's label, not the option's `aria-selected`:
    // the listbox unmounts on close, and while it is open every option renders
    // `aria-selected="false"` — including the currently-selected one (verified
    // by dumping the live listbox HTML). The label cannot distinguish the ACP
    // and native-SDK variants of one harness, so this only proves the harness
    // FAMILY changed; the per-variant proof is behavior 6's dialect counters,
    // which is the assertion that actually matters.
    const landed = await expect(trigger)
      .toHaveText(expectedTriggerLabel(harnessKey), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (landed) return
    await page.keyboard.press("Escape").catch(() => undefined)
  }
  throw new Error(
    `GATING: the draft harness never settled on "${harnessKey}" after 3 attempts — the option was visible and ` +
      `clicked each time, but the composer did not adopt it. See this spec's HARNESS NOTES ("draft harness switch " +
      "can silently not commit").`,
  )
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
 * Note the control is `prompt-model`, not `prompt-harness-model`: the latter
 * renders only in harness mode (`agent-harness-selector.tsx:586`), which is
 * false for opencode by definition.
 *
 * Driven through the real picker rather than seeded, so the scenario exercises
 * the user's own model-selection path. Harness scenarios need none of this — a
 * harness owns its catalog and `waitForHarnessReady` already gates on it.
 */
async function selectScriptedModel(page: Page) {
  const control = page.locator('[data-action="prompt-model"]').last()
  await expect(control).toBeVisible({ timeout: 30_000 })
  // `disabled` (not `aria-disabled`) while the provider catalog loads; a click
  // then is a no-op that leaves the default model in place.
  await expect(control).toBeEnabled({ timeout: 45_000 })
  await control.click()
  // ~180 providers, virtualized: the entry is not in the DOM until the search
  // narrows to it.
  const search = page.getByRole("textbox", { name: /Search models/i }).last()
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill("Scripted")
  const option = page.getByText(/^Scripted Model$/i).last()
  await expect(
    option,
    "the scripted model is missing from the picker — most likely its fixture regained a stale `release_date` " +
      "(see opencodeScriptedProviderConfig's doc: dated non-latest models are hidden by models.tsx's visible())",
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

/** Drives the shared "3 scripted turns + reload, full oracle each turn" journey. */
async function runRealHarnessJourney(page: Page, dir: string, harness: HarnessCase) {
  scripted?.resetCounts()
  const runId = `${Date.now()}`.slice(-6)
  const input = await openDraftPrompt(page, dir)

  if (harness.option) {
    await switchDraftHarness(page, harness.harnessKey)
    await waitForHarnessReady(page)
  } else {
    await selectScriptedModel(page)
  }

  const markers: string[] = []
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const marker = `REAL-${harness.id.replace(/[^a-z0-9]/gi, "")}-${runId}-T${turn}`
    markers.push(marker)
    const promptText = `Reply with exactly this one token and nothing else, no punctuation, no formatting: ${marker}`
    const textbox = turn === 1 ? input : page.getByRole("textbox", { name: /Ask anything/i }).last()
    await composePrompt(page, textbox, promptText)
    await page.locator(SELECTORS.submitControl).last().click()
    if (turn === 1) {
      await expect(page).toHaveURL(sessionUrlPattern(), { timeout: 30_000 })
    }
    await expectAssistantReplyVisible(page, new RegExp(marker), {
      spec: "real-harness-local",
      scenario: `${harness.id}-turn-${turn}`,
    })
  }

  await expectLiveUserRowCount(page, markers.length)

  // Behavior 8: locked once the session exists. Asserted on the trigger
  // element, not on a label lookup — the ACP and native-SDK variants render the
  // same visible name, and `getByRole("button", {name})` also matches the
  // model control on some harnesses.
  if (harness.option) {
    const trigger = page.locator('[data-action="prompt-harness"]').last()
    await expect(trigger).toHaveText(harness.option)
    await expect(trigger).toBeDisabled()
  }

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectAssistantReplyVisible(page, new RegExp(markers[TURNS - 1]!), {
    spec: "real-harness-local",
    scenario: `${harness.id}-reload`,
  })
  await expectLiveTurnsSettledAfterReload(page, markers)

  // Behavior 6, asserted last so a reload-time re-fetch cannot inflate it.
  expectScriptedTraffic(harness.dialect, TURNS)
}

test.describe("real harness journeys @core @tier-real", () => {
  test.skip(
    !TIER_REAL,
    "Tier R: set CLAXEDO_TIER_REAL_E2E=1 to run real-harness-local against a real claxedo-server + real harness " +
      "binaries pointed at the scripted model endpoint. This lane bakes its own backend origin " +
      "(VITE_CLAXEDO_SERVER_URL) into the app build, so it cannot ride a sharded core run — it has its own CI job. " +
      "Unset -> loud, visible skip per e2e/INVARIANTS.md rule 6, never a silent no-op.",
  )

  test.beforeAll(async () => {
    if (!TIER_REAL) return
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

  test("opencode harness (embedded engine) completes 3 scripted turns and survives reload — behaviors 1,6,9", async ({
    page,
  }) => {
    const dir = await makeWorkspace("opencode")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, { id: "opencode", dialect: "chat" })
  })

  test("claude ACP harness (real claude-agent-acp subprocess) completes 3 scripted turns and survives reload — behaviors 2,6,8,9", async ({
    page,
  }) => {
    const binary = await resolveBinary("claude", "CLAXEDO_E2E_CLAUDE_BIN")
    requireBinary(binary, "claude", "install the Claude CLI to include the claude-acp harness in this lane.")
    const dir = await makeWorkspace("claude-acp", "claude-acp")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, { id: "claude-acp", dialect: "messages", option: /^Claude$/, harnessKey: "claude-acp" })
  })

  test("claude native SDK harness completes 3 scripted turns and survives reload — behaviors 3,6,8,9", async ({
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
    await runRealHarnessJourney(page, dir, { id: "claude-sdk", dialect: "messages", option: /^Claude$/, harnessKey: "claude-sdk" })
  })

  test("codex ACP harness (real codex-acp subprocess) completes 3 scripted turns and survives reload — behaviors 4,6,8,9", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(binary, "codex", "install the Codex CLI to include the codex-acp harness in this lane.")
    const dir = await makeWorkspace("codex-acp", "codex-acp")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, { id: "codex-acp", dialect: "responses", option: /^Codex$/, harnessKey: "codex-acp" })
  })

  test("codex native SDK harness completes 3 scripted turns and survives reload — behaviors 5,6,8,9", async ({
    page,
  }) => {
    const binary = await resolveBinary("codex", "CLAXEDO_E2E_CODEX_BIN")
    requireBinary(
      binary,
      "codex",
      "the native codex-app-server harness drives the same CLI's `app-server` subcommand.",
    )
    const dir = await makeWorkspace("codex-sdk", "codex-app-server")
    await seedOneProject(page, dir)
    await runRealHarnessJourney(page, dir, { id: "codex-sdk", dialect: "responses", option: /^Codex$/, harnessKey: "codex-app-server" })
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
    scripted?.resetCounts()
    const dir = await makeWorkspace("cursor", "cursor-acp")
    await seedOneProject(page, dir)
    const input = await openDraftPrompt(page, dir)
    await switchDraftHarness(page, "cursor-acp")

    const notice = page.locator("[data-component='composer-notice'][data-notice='runtime-unavailable']")
    const modelControl = page.locator('[data-action="prompt-harness-model"]')
    // Whether the cursor binary exists on this machine decides which of the two
    // legal states the composer settles into; both are asserted, neither is
    // waited for with a bare sleep.
    await expect
      .poll(async () => ((await notice.count()) > 0 ? "unavailable" : (await modelControl.count()) > 0 ? "ready" : "pending"), {
        timeout: 30_000,
        message: "composer settled into neither the cursor-ready nor the runtime-unavailable state",
      })
      .not.toBe("pending")

    if ((await notice.count()) > 0) {
      // Unavailable-state UI, exactly as core-harness-ownership-local behavior 5
      // pins it against a mock: one notice row, critical tone, actionable.
      await expect(notice).toHaveCount(1)
      await expect(notice).toHaveAttribute("data-tone", "critical")
      await expect(notice.locator("[data-action='composer-notice-action']")).toBeVisible()
      await composePrompt(page, input, "tier-real cursor unavailable attempt")
      await page.locator(SELECTORS.submitControl).last().click()
    } else {
      // Available: exactly one harness model control, and it is Cursor's.
      await expect(modelControl).toHaveCount(1)
      await expect(modelControl.last()).not.toContainText(/Loading models|Select model/i, { timeout: 30_000 })
    }

    // No silent fallback to plain OpenCode in either branch (INVARIANTS #4).
    // Asserted on the trigger's own text rather than a global "no OpenCode
    // button anywhere" count — see `switchDraftHarness`'s doc for why the
    // label is scenario-order-dependent.
    await expect(page.locator('[data-action="prompt-model"]')).toHaveCount(0)
    await expect(page.locator('[data-action="prompt-harness"]').last()).not.toHaveText(/^OpenCode$/)

    // The wire-level half: nothing this spec redirected was touched. A cursor
    // selection that fell back to the engine or to claude would show up here as
    // a non-zero count, including the engine's title call.
    const counts = scripted?.counts() ?? { chat: 0, messages: 0, responses: 0 }
    expect(
      counts,
      "expected the scripted model server to receive zero requests during the cursor scenario — any count here means " +
        "selecting Cursor routed through a provider it does not own",
    ).toEqual({ chat: 0, messages: 0, responses: 0 })
  })
})
