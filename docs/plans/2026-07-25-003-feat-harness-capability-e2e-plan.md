# Harness Capability E2E: scripted-provider seam for skills / commands / MCP across harnesses

- **Date:** 2026-07-25
- **Status:** PLANNED
- **Owner intent:** prove that marketplace-installed Agent Extensions (skills, commands, MCP servers, and eventually plugin bundles) are actually *consumed* by each harness — not merely written to disk — deterministically, hermetically, and in the **default CI lane**.

Inherited operating principles (inlined; `docs/plans/goal.md` does not exist on `dev`):
- Exact Definition of Done per task; a task without a runnable verification command is not done.
- No false-positive verification: green tests are claims; every suite added here must contain at least one negative assertion that fails when the feature is broken.
- Local-first: every task must be replayable locally before any CI wiring.
- Push parallel agents/workflows for independent tasks; the parallelization map below is normative.

---

## 1. Problem

Today's coverage stops at the disk boundary:

| Layer | Coverage today | Gap |
|---|---|---|
| Materializers (symlink/jsonc/TOML) | unit (`packages/agent-extensions/src/materialize.test.ts`) | — |
| Marketplace UI → disk | Tier L (`live-agent-extensions-materialization.spec.ts`), gated `CLAXEDO_E2E_LIVE=1`, not in CI | behaviors 6/8 fixme, 9 unimplemented |
| Control plane → sandbox push | integration (`sandbox-provisioning.integration.test.ts`, `runtime.test.ts:1708`) | never inside a real container |
| **Harness consumes the installed capability** | **NOTHING** | the whole point of installing |
| MCP auth | nothing | bearer/negative paths untested |

Peer-repo research 2026-07-25 (memory: `reference_peer_repos_mcp_plugin_testing.md`) established that the **fake-model-endpoint seam** — scripted provider behind the *real* harness — is the only seam that proves capability loading (OpenAI Codex repo is the exemplar: `codex-rs/core/tests/common/responses.rs`, skills proven by asserting the captured outbound request contains the `<skill>` injection; MCP auth via a bearer-enforcing fixture server + seeded credential stores). We already run this seam for one harness: `packages/claxedo-app/e2e/helpers/real-workgraph-harness.ts` (fake OpenAI-compatible provider + real opencode engine + real `claxedo-mcp` subprocess).

## 2. The seam model (four tiers, each with a distinct job)

1. **Unit (exists):** materializer file-shape truth. Unchanged.
2. **Capability tier (NEW, this plan's core):** real harness process + **scripted provider endpoint** + real materialized files in a scratch `HOME`/project + real MCP subprocesses. Hermetic (localhost only, no tokens, no git fetch — package roots injected). Runs in **default CI**.
3. **Tier L UI lifecycle (exists, extended):** real marketplace UI → real server → disk, plus a new bridge behavior that hands the resulting scratch `HOME` to tier 2's consumption check. Weekly scheduled CI, not per-PR.
4. **Real-model canary (explicitly rejected for now):** peer repos show these lanes rot into convention-only. We do not add one until tiers 2–3 are landed and green.

Determinism doctrine (from peer research, normative): the model is the *only* scripted component; everything below the provider HTTP boundary must be real. No record/replay, no protocol mocks, no `AgentClient`-level fakes for these suites.

Provider hook per harness:

| Harness | Hook | Dialect |
|---|---|---|
| opencode | custom provider `baseURL` (already working) | OpenAI chat-completions SSE |
| claude | `ANTHROPIC_BASE_URL` (+ dummy `ANTHROPIC_API_KEY`; paseo proves the CLI honors this — they point it at OpenRouter) | Anthropic Messages SSE |
| codex | `model_providers.<id>.base_url` in `config.toml`, `wire_api = "chat"` | OpenAI chat-completions SSE |
| cursor | none (closed app) | config-materialization assertions only; runtime consumption OUT OF SCOPE |

## 3. Workstreams

### W0 — Probes (de-risk before building; all three parallel)

- **T0.1 claude redirect probe.** Script under `e2e/probes/` that starts a minimal Messages-SSE responder and runs the pinned `claude` CLI (`-p "ping"`) against it in a scratch `HOME` (onboarding pre-seeded in `.claude.json`). **DoD:** exits 0 printing the scripted text; every required env var/settings key documented in a `FINDINGS` block appended to this plan; failure modes (version gating, telemetry calls) recorded honestly.
- **T0.2 codex redirect probe.** Same for `codex exec` with a scratch `CODEX_HOME` and `model_providers` config, `wire_api = "chat"`. **DoD:** as T0.1. If the chat dialect fights us, record the decision to implement the Responses dialect instead — do not duct-tape.
- **T0.3 spawn-seam pin.** Locate and document (file:line) where our stack spawns the claude/codex harness processes and composes their env (session-env composer, `/api/wr/session-env` path), and decide the per-session injection mechanism for `ANTHROPIC_BASE_URL`/`CODEX_HOME`-style overrides (test-only env passthrough, never a prod flag). **DoD:** mechanism documented in this plan and reviewed against the credential-scrubbing behavior (overrides must not survive into non-test sessions).

### W1 — Scripted-provider infrastructure

- **T1.1 Extract the provider.** Pull the fake provider out of `real-workgraph-harness.ts` into `packages/claxedo-app/e2e/helpers/scripted-provider.ts` with: (a) a scenario API — ordered turns, each `text | tool_call(name, args)`, keyed on a per-test sentinel in the prompt, no more ad-hoc `serialized.includes` chains; (b) a request-capture log with typed accessors (`messagesOfRole`, `toolResults`, `lastRequest`); (c) exact turn-count expectation + `verify()`; (d) random port always. **DoD:** `core-workgraph` specs green using the extracted helper; helper has its own vitest file.
- **T1.2 Anthropic Messages dialect.** Add `/v1/messages` SSE (message_start → content_block tool_use/text deltas → message_delta stop_reason) to the same server. **DoD:** T0.1 probe passes through it; SSE frame shapes pinned by fixture-comparison unit test.
- **T1.3 Request-invariant validator.** Port codex's `validate_request_body_invariants` idea: every captured request is structurally validated (every tool result correlates to a prior tool_use id in the same conversation; no orphans; call-id symmetry) and the test fails on violation. Wired into the capture path so **every** capability spec gets it for free. **DoD:** deliberate orphan-tool-result fixture fails; all green suites unaffected.
- **T1.4 MCP auth fixture server.** Small MCP server fixture (echo + cwd tools, stdio and streamable-http) with a `CLAXEDO_TEST_MCP_EXPECT_BEARER` env switch that rejects requests without the exact bearer. **DoD:** direct SDK-client test green including the 401 negative; fixture lives in `packages/agent-extensions/test-fixtures/` (or the location W0 review picks) and is spawnable by path.

#### Responder design (normative for T1.1/T1.2): two axes, nothing else

Response shapes differ only along two enumerable axes; permissions/todos/tasks/subagents are NOT provider-level concepts and need no special handling in the responder:

1. **Dialect codecs (2, fixed):** Anthropic Messages SSE (`tool_use` content blocks + `input_json_delta` streaming, `stop_reason: "tool_use"`, inbound `tool_result` blocks by `tool_use_id`) vs OpenAI chat-completions SSE (`delta.tool_calls` with `arguments` fragments, `finish_reason: "tool_calls"`, inbound `role:"tool"` by `tool_call_id`). Wrong stop reasons / ID correlation ⇒ harness errors or retries — hence T1.2's pinned-fixture tests.
2. **Per-harness tool catalog (data, not logic):** scenarios declare *intent* (`todo`, `subagent`, `gated-shell`, `mcp-tool`); a catalog maps intent → harness tool name + args schema (claude `TodoWrite`/`Task`/`Bash`/`mcp__srv__tool`; codex `update_plan`/`shell`/namespaced; opencode `todowrite`/`task`/`bash`/native). Permission flows are triggered by emitting a gated tool call — the harness's own policy engine raises the permission request to our client, which the *test client* answers; the provider fake never models permissions.

Two required behaviors beyond the codecs: (a) **conversation routing** — subagent tool calls fork new model loops against the same endpoint concurrently; route scenarios by system-prompt/sentinel identity (the dispatch pattern `real-workgraph-harness.ts` already uses for master-agent turns); (b) **advertised-tools validation** — the responder must refuse to emit a tool call absent from the request's own tool definitions. This is load-bearing: "capability didn't load" becomes an immediate hard failure instead of a hang, and scenarios cannot drift.

### W2 — Capability-consumption suite (the new tier; hermetic; default CI)

Location: `packages/workspace-runtime/e2e-capability/` (vitest, node; no Playwright — no browser involved). Materialization for these tests uses the real materializer with **injected package roots** (`applyRuntimeAgentExtensions`'s `packageRoots` option, `packages/agent-extensions/src/replay.ts:32` — the same hermetic seeding `sandbox-provisioning.integration.test.ts` already uses), so no git/network. Parameterized over `["opencode", "claude", "codex"]` wherever the hook exists; each harness's assertion helper is hand-written (injection shapes differ — codex-style, not a generic regex).

- **S1 skill load.** Materialize a probe skill into scratch `HOME`/project → spawn harness → prompt with sentinel → assert the **captured provider request** contains the skill (name + body marker + path). Negative: after uninstall (real uninstall path), the next session's request must NOT contain it. **DoD:** green for all three harnesses; the negative fails if the uninstall is skipped.
- **S2 command surface.** Installed command appears in the harness's advertised command set (opencode command list; claude `slash_commands` in the init message — our adapter already parses this, `agent-event-runtime/src/harnesses/claude/adapter.ts:222`; codex prompts list). **DoD:** per-harness positive + absent-after-uninstall negative.
- **S3 MCP invocation round trip.** Materialized MCP config pointing at the **real `claxedo-mcp`** → provider scripts a tool call for the harness's MCP tool naming (`mcp__claxedo__…` for claude, namespaced function call for codex, native for opencode) → assert (a) the real side effect landed on the scratch claxedo-server and (b) the tool result appears in the next captured provider request. **DoD:** green ×3; turn-count verified.
- **S4 MCP auth.** T1.4 fixture in the materialized config with an env-ref token: positive (tools listed / call succeeds with correct bearer), negative (wrong token → harness surfaces a typed failure; tools absent; no unbounded retry). Plus the standing credential tripwire: **no `CLAXEDO_*_TOKEN` value ever appears in any captured provider request body** across the entire suite. **DoD:** both polarities green ×3; tripwire is a suite-level afterEach.
- **S5 plugin bundle.** Body written against the compositional contract (manifest + skill + MCP entry all surface), `test.fixme` until the curated catalog ships a `kind: "plugin"` entry — per the existing "do not invent catalog entries" rule. **DoD:** fixme with exact unblock condition stated.

### W3 — Tier L bridge + debt (serial; needs an idle machine per that spec's HARNESS NOTES)

- **T3.1 Behavior 10 (UI → consumption bridge).** After the existing behavior-2 UI skill install, run the S1 consumption check against the same scratch `HOME` — proving marketplace UI → server → disk → harness in one chain. **DoD:** executed live once, evidence in HARNESS NOTES.
- **T3.2 Un-fixme behaviors 6 (disable/enable) and 8-adopt.** **DoD:** live run evidence; fixmes removed.
- **T3.3 Behavior 9 (docker sandbox) real body.** Workspace-scope install via UI → poll `accepted-snapshot.json`/`apply-status.json` → `docker exec` file assertions; stretch: scripted provider reachable from the container to run S1 in-sandbox. Stays gated on `CLAXEDO_ENABLE_DOCKER_SANDBOX=1`, but the body is real, not a `throw`. **DoD:** one gated live run recorded.

### W4 — CI wiring (the anti-rot gate; last)

- **T4.1 Default lane.** CI job: install exact-pinned harness binaries (`@anthropic-ai/claude-code`, `@openai/codex` — pin exact, they are our canary for vendor drift), run the W2 suite. No secrets, localhost only. **DoD:** green run on a PR; failure blocks merge.
- **T4.2 Scheduled Tier L lane.** Weekly workflow for the live marketplace spec (real git fetch, real server) with loud failure notification. This cures the disease every peer repo has (best tests stranded in opt-in lanes) without flaking PRs. **DoD:** workflow merged + one green scheduled run.

## 4. Parallelization map (normative)

- Wave 1 (parallel agents): T0.1 ∥ T0.2 ∥ T0.3 ∥ T1.4.
- Wave 2: T1.1 → T1.2, T1.3 (T1.2/T1.3 parallel after T1.1).
- Wave 3 (fan out per harness — workflow-friendly): S1–S4 as a harness×spec matrix; each cell independent once W1 lands.
- Wave 4: W3 serial on an idle machine; W4 after W2 is green locally.

## 5. Risks / honesty notes

- **Claude CLI gating** (auth/onboarding/telemetry against a custom base URL) is the biggest unknown — that is exactly why W0 exists and ships first. Fallback: drive claude through the agent SDK/ACP adapter path, which composes env identically.
- **Harness version drift** is a feature here: with exact pins, a failing capability suite on a version bump is the vendor-drift canary no peer repo has.
- **Port/env contention:** every lesson from the Tier L spec's HARNESS NOTES applies — random ports only, preflight ownership guards, scratch `HOME` + scratch data dirs always.
- **What we deliberately do not test:** model quality/prose; cursor runtime consumption; interactive OAuth browser dances (seed credential stores instead, codex-style); a real-model canary lane (rejected above).

## 6. Definition of Done (plan-level)

The harness×capability matrix below is fully green in the default CI lane, with negatives:

| | skill load | command surface | MCP invoke | MCP auth ± |
|---|---|---|---|---|
| opencode | S1 | S2 | S3 | S4 |
| claude | S1 | S2 | S3 | S4 |
| codex | S1 | S2 | S3 | S4 |
| cursor | disk-only (Tier L) | disk-only | disk-only | n/a |

plus T3.1's one-time UI→consumption chain evidence and T4.2's scheduled lane live.
