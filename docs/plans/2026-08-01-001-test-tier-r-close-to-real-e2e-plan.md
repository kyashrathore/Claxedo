# Tier R — close-to-real e2e (everything real except the AI endpoint)

Date: 2026-08-01. Status: active implementation plan. Supersedes the uncommitted
July research direction cited by memory `peer-repos-mcp-plugin-testing` (W0–W4);
that plan doc was never landed, so this one reconstructs and replaces it.

## Context

The 12-hour CI-greening session fixed real bugs, yet the app's core opencode flow
shipped broken (managed-server → SDK migration) because all 33 Tier M specs mock
at exactly the seam that moved, and the 5 Tier L live specs run in no CI lane at
all. Running Tier L today reproduces the break: the opencode embedded-engine turn
fails with "Couldn't reach Anthropic — Not Found"; claude harnesses never resolve
a model catalog; codex never creates a session. One failure family, five
expressions — the engine seam is broken end-to-end and nothing in CI can see it.

**Goal**: a tier where the app, `claxedo-server`, the embedded engine, the real
harness binaries (claude / codex CLIs), the workspace-runtime, and (in the cloud
lane) the real relay and tunnel are ALL real — and the only fake is a
deterministic scripted model HTTP endpoint. Hermetic, zero credentials, runs on
every PR.

## Owner decisions (2026-08-01, recorded verbatim intent)

1. **Scripted provider, not real models.** A hand-written scripted server
   speaking three dialects — not CLIProxyAPI against real models. Determinism and
   zero cost beat fidelity-to-a-real-model here; fidelity is Tier L's job.
2. **Cloud gets BOTH lanes.** A user-hosted-relay-shaped lane that runs in
   default CI with no credentials (phase 4), AND a credentialed hosted-Cloudflare
   lane that runs pre-deploy against staging (phase 5). Neither substitutes for
   the other: the first proves the relay path, the second proves the deployed
   product.
3. **Cursor is coverage-only.** Its endpoint is proprietary with no base-URL
   knob, so Tier R asserts config materialization for cursor and never drives a
   turn through it. This is the July decision, unchanged.
4. **`live-documents-core.spec.ts` is deleted** (deletion already in the working
   tree this session). Its rich-text round-trip coverage lives in the mocked
   `documents-core.spec.ts` canary; the live variant ran in no lane and gated
   nothing.

## Verified architecture facts (first-hand, file:line)

**Injection seams per harness** — the whole tier hangs on these:

| Harness | Mechanism | Verified at |
|---|---|---|
| opencode (embedded engine in claxedo-server) | `OPENCODE_CONFIG_CONTENT` env on the server process (read at module import, merged as "local") with `provider.<id>.options.baseURL` | `opencode/src/config/config.ts:467`; `provider.ts:1670-1690` |
| claude-acp + claude-sdk | `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` on the server process → spread via `{...process.env}` into spawn; `harnessSpawnEnv`'s denylist holds only 9 Claxedo-internal names | `claude/driver.ts:174,234`; `shared/spawn-env.ts` |
| codex-acp + codex-app-server | `CODEX_CONFIG` JSON env (codex ignores `OPENAI_BASE_URL` in ChatGPT auth mode); `codexAcpLaunch` merges `-c model_providers.*` args into `CODEX_CONFIG`; `codexSpawnEnv` spreads `process.env` | `acp/codex-config.ts`; `codex/driver.ts:406`; `enforcement-probe.ts:225-234` |
| cursor | IMPOSSIBLE — proprietary endpoint, no base-URL knob. Config-materialization coverage only (decision 3) | `cursor/driver.ts:239` |
| pi | `PiModelBackend.streamFn` documented test seam — out of scope for this tier (central sessions) | `pi/model-backend.ts:33` |

**Dialects the scripted server must speak** — all three wire shapes already exist
in-repo, so none of them get invented:

1. OpenAI chat/completions SSE — for the opencode engine
   (`@ai-sdk/openai-compatible`). Reference emitters:
   `real-workgraph-harness.ts:1657-1686` (`sendProviderText` / `sendProviderTool`
   / `sendProviderEvents`).
2. Anthropic Messages SSE + JSON — for claude. Reference:
   `enforcement-probe.ts:148-181` (`message_start` / `content_block_*` /
   `message_delta` / `message_stop`; the tool loop terminates once `"tool_result"`
   appears in messages).
3. OpenAI Responses SSE — for codex (`wire_api="responses"`). Reference:
   `enforcement-probe.ts:97-124` (terminates on `"function_call_output"` in
   input). Bonus reference: `packages/opencode/test/lib/llm-server.ts`
   (`TestLLMServer`, chat+responses auto-translation, queue/matcher API).

**Hermeticity requirements** (each one already paid for in debugging hours):
`OPENCODE_DISABLE_MODELS_FETCH=true` is mandatory; health probes must be bounded
per-probe with `AbortSignal.timeout`; `CLAXEDO_WORKGRAPH_REPOSITORY` must be set
or the server fatals at boot; `OPENCODE_AUTH_CONTENT` shadows the auth bridge, so
never set it on the server; the provider cache needs `POST /global/dispose` after
a live auth change; engine env flags are read at import time, so setting them in
the spawn env is correct and mutating them later is not.

**Suite mechanics**: the backend origin is BUILD-TIME
(`VITE_CLAXEDO_SERVER_URL` is baked; `getClaxedoServerUrl()` at `api.ts:197-210`),
so a new backend port means a new build, which means a new CI job (a clone of
`e2e-workgraph`, `test.yml:417-492`) rather than another shard. A new tag must be
registered in `src/architecture/e2e-suite-tags.guard.test.ts` AND added to
`test:e2e:core:base`'s `--grep-invert`. The oracle (`turn-oracle.ts`) is
mandatory. `INVARIANTS.md` rule 6 defined only Tier M and Tier L, and the file is
authoritative — so it is amended first, before any spec exists. Auth
auto-bypasses on `navigator.webdriver` under `VITE_CLAXEDO_E2E=1`.

**Cloud lane**: `signed-browser-relay-fixture.mjs` already carries an untested
cloud mode (`CLAXEDO_E2E_RELAY_FIXTURE_ACCESS=cloud`, lines 29 and 262): real
relay process, real EdDSA JWTs, real host tunnel, real
`createWorkspaceRuntimeApp`, a `kind:"cloud"` workspace, and zero
Cloudflare/Convex/Clerk (SQLite store plus a stubbed authority and verifier).
Setting `ANTHROPIC_BASE_URL` on the fixture process reaches the harness spawns.
Two known blockers: the draft-composer workspace-target ambiguity (which is why
`live-user-hosted-relay` behaviors 3–6 are `test.fixme`), and a stale
`configureEmbeddedWorkspaceRuntime({opencodeUrl})` call at fixture line 245 (dead
code, wrong shape).

## Phase 0 — Repo plan doc and doctrine amendment

Doctrine changes before code, because `INVARIANTS.md` is authoritative on tier
definitions and a spec authored against an unamended doctrine has no rule to
point at.

- [ ] This plan exists at `docs/plans/2026-08-01-001-test-tier-r-close-to-real-e2e-plan.md`
      with per-phase DoD checkboxes, and is linked from `docs/plans/README.md`
      under "Retained Plans". Progress:
- [ ] `packages/claxedo-app/e2e/INVARIANTS.md` rule 6 defines **three** tiers, not
      two: Tier R (`real-*.spec.ts`, `@core @tier-real`) is spelled out as real
      app / server / engine / harness binaries / runtime, zero `page.route()`,
      the scripted model endpoint (plus its provider-config and env injection) as
      the single fake, loud `GATING:` failure on a missing binary or credential,
      oracle mandatory — and names `core-workgraph.spec.ts` (`@workgraph-real`)
      as the pre-existing member of the family. Progress:
- [ ] `@tier-real` is registered in `SUB_SELECTOR_TAGS`
      (`src/architecture/e2e-suite-tags.guard.test.ts`), and the canary tags
      orphaned by the `live-documents-core.spec.ts` deletion are removed — only
      genuinely orphaned ones, verified by grepping the remaining specs.
      Progress:
- [ ] `test:e2e:core:base` inverts `"@workgraph-real|@tier-real"`, so a Tier R
      spec is never selected by a core shard. Progress:
- [ ] `bun run test:architecture` green. Progress:
- [ ] The pending `live-documents-core.spec.ts` deletion and its package.json
      script collapse are committed by pathspec (never a bare `git commit` —
      other sessions have staged work). Progress:

## Phase 1 — Scripted provider fixture (the one fake thing)

New `packages/claxedo-app/e2e/helpers/scripted-model-server.ts`: plain
`node:http`, ephemeral or fixed port, zero dependencies.

- [ ] Three routes exist and speak the exact in-repo wire shapes (ported, not
      invented): `POST /v1/chat/completions` (chat SSE),
      `POST /v1/messages` (Anthropic SSE + JSON),
      `POST /v1/responses` (Responses SSE). Progress:
- [ ] One behavior contract holds across all three dialects: an echo-marker reply
      (a prompt containing `Reply with exactly ... : <MARKER>` returns
      `<MARKER>`), a scripted tool-loop mode (emit `tool_use` until a
      `tool_result` / `function_call_output` appears in the request, then finish —
      the enforcement-probe shape), and a title-generation auto-answer
      ("Generate a title for this conversation" → a fixed string). Progress:
- [ ] A request log with counters (`hits`, `calls`, per-dialect) is exposed to
      the spec, so supplement assertions can prove which endpoint was hit and how
      often. Progress:
- [ ] Provider-config builders ship alongside: `opencodeProviderConfig(baseUrl)`
      (the v1 shape from `real-workgraph-harness.ts:providerConfig`, minus mcp
      and plugin) and `codexConfigJson(baseUrl)` (the `model_providers` block from
      `enforcement-probe.ts:225-234`, emitted as the `CODEX_CONFIG` JSON object).
      Progress:
- [ ] W0 probe: `scripted-model-server.probe.ts` (runnable via bun, deliberately
      NOT in CI) demonstrates one completed turn per harness path against the
      fixture on a real machine — proving the claude CLI honors
      `ANTHROPIC_BASE_URL`, codex honors `CODEX_CONFIG`, and the engine honors
      `OPENCODE_CONFIG_CONTENT`. Progress:

## Phase 2 — Local lane spec `real-harness-local.spec.ts`

The critical path. This spec is EXPECTED RED on current `dev` — it reproduces the
SDK-migration break for opencode, claude, and codex — and fixing that product bug
is in scope here. The red-repro → product-fix → green ordering *is* the
acceptance demonstration for the whole tier; do not author the spec against
already-fixed code.

Structure clones `live-real-harness-smoke.spec.ts`, whose `startServer`,
`waitForHealth`, `makeWorkspace`, `registerWorkspace`, `seedOneProject`,
`switchDraftHarness`, and `runLiveHarnessSmoke` are directly reusable.

- [ ] The multi-part-safe `expectLiveUserRowCount` and
      `expectLiveTurnsSettledAfterReload` are promoted into a shared helper that
      both the live spec and this one import — no forked copy. Progress:
- [ ] A real `claxedo-server` boots (`bun run start`, scratch `CLAXEDO_DATA_DIR`,
      port 4317, `CLAXEDO_WORKGRAPH_REPOSITORY` = repo root) with the full
      injection env: `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_MODELS_FETCH=true`,
      `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY=test-key`, and `CODEX_CONFIG`.
      The scripted server starts first. Progress:
- [ ] Five turn scenarios pass, each = 3 turns + reload + settled-after-reload via
      the oracle: opencode (embedded engine), claude-acp, claude-sdk, codex-acp,
      codex-app-server. Progress:
- [ ] Cursor has a config-materialization assertion and no turn (decision 3).
      Progress:
- [ ] A SPEC block with numbered behaviors heads the file, and every `test()`
      cites its behavior numbers, per doctrine. Progress:
- [ ] Binaries resolve via the `resolveBinary` pattern; CI installs pinned
      `@anthropic-ai/claude-code` and `@openai/codex` (no auth needed — the
      fixture is the endpoint); a missing binary throws `GATING:` locally rather
      than skipping. Progress:
- [ ] Supplement assertions from the fixture request log prove each turn hit the
      scripted endpoint exactly once per step and that zero requests reached any
      real provider host — the fixture is the only network. Progress:
- [ ] The negative proof is recorded once, before the fix: this spec fails on
      pre-fix `dev` for all three harness families. Progress:
- [ ] The product fix lands and all five scenarios are green locally. Progress:

## Phase 3 — CI job `e2e-tier-real`

- [ ] A new job clones `e2e-workgraph` in `.github/workflows/test.yml`: same
      prologue (node 24.15, bun, playwright cache, the 12 turbo filters) plus
      `npm i -g` of the pinned claude and codex CLIs. Progress:
- [ ] A new `test:e2e:real` script runs the spec with `CLAXEDO_E2E_SUITE=core`,
      `CLAXEDO_E2E_PREBUILT=1`, and a webServer prefix baking
      `VITE_CLAXEDO_SERVER_URL=http://127.0.0.1:4317` — mirroring the
      `workGraphReal` branch in `playwright.config.ts` behind a
      `CLAXEDO_TIER_REAL_E2E=1` flag. Progress:
- [ ] The lying comment at `test.yml:379` is fixed: nightly Tier L does not
      exist. Replace it with a pointer to this job and a plain statement that
      Tier L remains local/manual. Progress:
- [ ] The job is green on a PR, and a deliberate provider-config break (revert
      canary) turns it red. Progress:

## Phase 4 — Cloud lane A: relay-shaped, default CI (`real-cloud-relay.spec.ts`)

Shares the fixture with phase 2 but owns disjoint files. Its product fix touches
server composition, same as phase 2's — so the two product fixes are sequenced,
never run in parallel.

- [ ] Blocker 1 cleared: the stale
      `configureEmbeddedWorkspaceRuntime({opencodeUrl})` call at
      `signed-browser-relay-fixture.mjs:245` is deleted (dead code, wrong shape).
      Progress:
- [ ] Blocker 2 cleared: the draft-composer workspace-target ambiguity is
      resolved far enough for a first-prompt-through-the-relay path. Side effect
      to verify, not assume: this un-`fixme`s `live-user-hosted-relay` behaviors
      3–6. Progress:
- [ ] The spec boots `signed-browser-relay-fixture.mjs` with
      `CLAXEDO_E2E_RELAY_FIXTURE_ACCESS=cloud` plus `ANTHROPIC_BASE_URL` /
      `OPENCODE_CONFIG` pointed at the scripted server, with a dedicated vite
      frontend reusing the `live-user-hosted-relay-frontend-server.mjs` pattern.
      Progress:
- [ ] A session runs into the `kind:"cloud"` workspace through the REAL relay
      (real EdDSA JWT, real WS tunnel, real workspace-runtime): 2 turns + reload,
      via the oracle. Progress:
- [ ] Assertions prove the relay actually carried the traffic (fixture request
      log / relay-side counters) and that zero Cloudflare, Convex, or Clerk
      dependency was touched. Progress:
- [ ] The spec is added to the `e2e-tier-real` CI job (same build, second spec)
      and is green there. Progress:
- [ ] Load-bearing proof: pausing the tunnel via the fixture's
      `POST /__fixture/tunnel/pause` makes the turn fail. A lane that stays green
      with the tunnel paused is not testing the relay. Progress:

## Phase 5 — Cloud lane B: hosted CF, credentialed, pre-deploy

Staging has real credentials and no scripted-endpoint option: CF sandbox env
injection does not exist today (`runtimeEnvForHost` has no passthrough, and
`ensure()`'s env is `{}` at `workspace-supervisor-sandbox.ts:139`). So this lane
runs real models against staging, pre-deploy.

- [ ] `deploy-control-plane.yml`'s staging smoke gains an interactive-session
      scenario: after the existing WorkGraph smoke, create a session against the
      staging hosted runtime and complete one real turn. Progress:
- [ ] The deploy workflow FAILS when an interactive hosted session cannot
      complete a turn on staging. Progress:
- [ ] Recorded as deferred follow-up, explicitly NOT in this plan's DoD: a
      `CLAXEDO_SANDBOX_EXTRA_ENV` passthrough so even the CF lane could run
      scripted. Progress:

## Files touched (primary)

- `packages/claxedo-app/e2e/INVARIANTS.md` — tier amendment (phase 0)
- `packages/claxedo-app/src/architecture/e2e-suite-tags.guard.test.ts`,
  `packages/claxedo-app/package.json`, `packages/claxedo-app/playwright.config.ts`
- `packages/claxedo-app/e2e/helpers/scripted-model-server.ts` + probe — NEW
- `packages/claxedo-app/e2e/helpers/turn-oracle-live.ts` (promoted shared
  helpers) — NEW
- `packages/claxedo-app/e2e/playwright/real-harness-local.spec.ts` — NEW
- `packages/claxedo-app/e2e/playwright/real-cloud-relay.spec.ts` — NEW
- `.github/workflows/test.yml` (new job + comment fix),
  `.github/workflows/deploy-control-plane.yml`
- `packages/claxedo-server/src/signed-browser-relay-fixture.mjs` (stale call,
  cloud-mode polish)
- Product fixes as surfaced: the SDK-migration engine seam (phase 2),
  draft-composer cloud targeting (phase 4)

## Verification

Phase-gated on each phase's DoD above. Globally: `bun run test:architecture` and
`bun run typecheck` green, the new CI job green, and the negative proof that is
the tier's whole reason to exist — reverting phase 2's product fix must turn
`e2e-tier-real` red.

Per `INVARIANTS.md` rule #1, green is a claim and not proof: every new oracle
assertion's screenshots are visually reviewed before its spec is accepted. No
green-only acceptance (house `no-false-positive-verification` rule).

## Execution: parallelize with agents and workflows

Phase 0 (doctrine, tags, plan doc) and phase 1 (fixture + probe) are fully
disjoint — different files, no shared symbols — so they run as two agents from
the start. Lanes 2 and 4 both consume the fixture but own disjoint spec files, so
their spec authoring parallelizes; their PRODUCT fixes do not, because both touch
server composition. Phase 3's CI wiring follows phase 2, since there is nothing
to run until the local lane is green.

Suggested assignment:

- **Agent A** — phase 0: plan doc, `INVARIANTS.md` rule 6, tag guard,
  `--grep-invert`. Small, blocking for review of everything else.
- **Agent B** — phase 1: `scripted-model-server.ts` + the W0 probe. The longest
  independent stretch; start it at the same moment as A.
- **Agent C** — phase 2 once B lands: the local spec, then the product fix. This
  is the critical path and the thing the tier exists to prove; give it the
  red-first discipline explicitly.
- **Agent D** — phase 4 spec scaffolding against B's fixture, but its product fix
  is sequenced AFTER C's, not concurrent.
- Phases 3 and 5 are workflow edits, cheap, and go last.

Known trap: never run two Playwright suites against port 3001 ambience. This lane
uses 4317 plus the `assertPortFree` GATING pattern from
`live-claxedo-mcp-tools.spec.ts:286`.
