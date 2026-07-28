# PostHog is the single telemetry and error-tracking stack

- **Date:** 2026-07-28
- **Status:** PLANNED — implementation-ready
- **Scope:** one vendor, PostHog, carries **product analytics AND error tracking** for every Claxedo runtime: the web app, the Electron desktop app, the Node server, the Cloudflare Worker, and the Bun relay. This plan executes the metric spec in `2026-07-27-004-claxedo-tracking-review-and-metric-spec.md` §4 and implements its error-visibility half with PostHog Error Tracking behind the existing runtime-neutral reporting seam.
- **Resolves:** launch-plan §7 owner decision #2 ("who owns analytics, and which provider?") — the provider is PostHog; naming the human owner remains the one open sub-item. Unblocks launch stream B6.
- **Owner questions inherited from the metric spec:** average sandbox compute per user; average AI tokens per user; which features users care about; what self-hosters can turn off.

Inherited operating principles (inlined; `docs/plans/goal.md` does not exist on `dev`):
- Exact Definition of Done per stream; a task without a runnable verification command is not done.
- **No false-positive verification:** green tests are claims. Every guard added here must be **tripwired** — break it on purpose, watch it fail, restore. Anything user-visible needs vision-reviewed screenshots or video, not a passing assertion.
- Local-first: replay locally before wiring CI, and never deploy to discover a failure.
- Strangler/additive: nothing removed until its replacement is green.
- Push parallel agents/workflows for independent streams; the parallelization map in §6 is normative.

---

## 1. The decision

**PostHog is the sole telemetry vendor.** Product events, user/org identity, error tracking, and alerting all live in one PostHog project, keyed by one `distinct_id` space. One vendor because:

1. **The client already made this choice.** `packages/claxedo-app/src/platform/telemetry/analytics.ts:45` ships `capture_exceptions: true` — unhandled exceptions and promise rejections land in PostHog → Error Tracking. This plan extends that posture to the server-side runtimes rather than running a second error vendor beside it.
2. **Identity is the metric spec's hard blocker, and it pays twice here.** `identify()`/`group()` (spec §4 pre-launch #3) is mandatory for "average per user" — and the same identity makes every captured exception answer "which org hit this?" for free. Two vendors would mean wiring identity twice.
3. **One kill-switch surface.** `CLAXEDO_TELEMETRY_MODE` (spec §4.6) gates one vendor's sinks. The self-host promise in `privacy.md` ("no keys configured ⇒ nothing is sent") stays provable with one spy target per runtime.
4. **Errors join replays and funnels.** An exception, the session replay around it, and the funnel step it broke are one linked record in PostHog; triage, grouping, assignment, and issue alerts (new / reopened / spiking → Slack) are first-class.
5. **One fewer production secret.** The deploy surface needs only PostHog keys (plus one CLI token for source maps); no DSN class of secrets exists.

**The reporting seam stays.** `packages/claxedo-server/src/observability/report.ts` (`setErrorReporterSink` / `reportError` / `reportPaymentError`, with `page_class=payment` as the paging class) is runtime-neutral, tested, and correct. Call sites do not change. Each runtime registers a PostHog-backed sink instead; the SDK-specific modules and dependencies retire only after their replacements are green (strangler).

**Two telemetry planes, different contracts** (this resolves the apparent conflict between the metric spec and `public-docs/deploy-runbook.md:258`):

| Plane | What | Identity | Contract |
|---|---|---|---|
| **Product plane** | feature events, funnel, `$exception`, metering events | `distinct_id = user_id`, `$groups.org = org_id` | required properties `org_id`, `user_id`, `surface`, `deployment_mode` enforced at the wrapper type (spec §4.1) |
| **Ops plane** | WorkGraph operational monitors (`workgraph-host/operational-telemetry.ts`, `distinct_id: "system"`) | none, by design | content-free boundary of `deploy-runbook.md:258` — bounded counts, durations, status classes; **no org/user identifiers, no content** |

Per-runtime transport (the Worker constraint is documented law — `posthog-node` is on the Worker's forbidden-import list, `public-docs/hosted-control-plane-worker.md:214`):

| Runtime | Analytics transport | Error transport |
|---|---|---|
| Web app (SolidJS) | `posthog-js` (`analytics.ts`) | `capture_exceptions: true` + `posthog.captureException` at boundaries |
| Desktop (Electron) | renderer = web app path | renderer = web app path; main process = `posthog-node` `captureException` on fatal handlers |
| Node server | `posthog-node` (`posthog.ts`) | `posthog-node` `captureException` behind the report seam |
| CF Worker | fetch `/capture/` (`worker-telemetry.ts`) | fetch-based `$exception` behind the report seam + Hono `onError` |
| Bun relay | (none today; unchanged) | `posthog-node` `captureException` on fatal handlers |

## 2. Ground truth (verified 2026-07-28)

- **App:** `analytics.ts` init from `app/entry/main.tsx:27`; `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` (default `https://app.posthog.com` — legacy host, canonical ingest is `https://us.i.posthog.com`); `person_profiles: "identified_only"`; dev builds never send. **Zero `identify()`/`group()` calls exist anywhere.**
- **Server:** `src/posthog.ts` reads **unprefixed** `POSTHOG_KEY`/`POSTHOG_HOST`; `server.ts:873` inits it and `server.ts:877` inits the error seam sink (`observability/node.ts`, `@sentry/node`, DSN-gated no-op). `main.ts:8` owns `uncaughtException` with an engine-worker-OOM isolation carve-out and `process.exit(1)` semantics that must be preserved.
- **Worker:** `worker.ts:354` wraps the export in `@sentry/cloudflare` `withSentry(...)`; `worker.ts:85-94` routes the seam into it; cron failures rely on the wrapper (`worker.ts:274,302`). Analytics is the separate fetch sink `control-plane/worker-telemetry.ts` (`CLAXEDO_POSTHOG_KEY`/`_HOST`), injected as `ControlPlaneTelemetry` (`control-plane/services.ts:227,241`).
- **Relay:** `workspace-relay/src/main.ts` inits `@sentry/bun` and `reportFatalToSentry` flushes on fatal paths (`main.ts:122`).
- **Desktop:** `packages/claxedo-desktop/src/main` has **no** error capture and no telemetry of any kind.
- **Seam + tests:** `observability/report.ts` (page classes: exactly `payment` + external-uptime), `observability/sentry-config.ts` (env→options, `CLAXEDO_SENTRY_DSN`, release = `CLAXEDO_RELEASE`/`GIT_SHA`, `deployment_mode` tag), `observability.test.ts` (key-absent ⇒ no init, no network, no throw — the contract every replacement must keep).
- **Provisioning:** `grep -rn "POSTHOG\|SENTRY" .github/workflows/` → **zero hits**; every sink above is inert in every deployed build. `wrangler.toml:45-47` documents the DSN var; `deploy-relay.yml` passes no telemetry env.
- **Deps to retire:** `@sentry/cloudflare` + `@sentry/node` (claxedo-server), `@sentry/bun` (workspace-relay), `@sentry/solid` + `@sentry/vite-plugin` (root overrides block — no package depends on either), egress-allowlist entry `network/types.ts:82`.
- **PII pre-key blockers:** `features/session/ui/use-session-commands.tsx:220-235` sends literal file paths in `context_selection_added`; channel session events carry external channel user ids.

## 3. Scope decisions (out of scope, tracked separately)

- **Native crash minidumps** (Electron main-process native crashes, renderer OOM). JS-level fatals in the main process are in scope (W2e); minidump collection is not. **Revisit trigger:** any sustained report of desktop crashes/blank screens with no corresponding `$exception` issue.
- **Convex function exception forwarding.** No first-party PostHog integration exists. Launch posture: Convex dashboard function logs + failure metrics, plus the Convex policy-guard test suite already in `control-plane/convex-*-policy.test.ts`. Post-launch option (owner decision D4): Convex log-stream webhook → Worker → `$exception`.
- **Tracing/APM.** The `tracesSampleRate: 0` posture carries over: no transaction/span product at launch. LLM analytics is a separate later evaluation.
- **Backfilling the ~45 existing dead events.** They begin working when keys land (W4); new engineering goes only to genuine gaps (spec §4.4's five events, W6).
- **The external uptime check stays vendor-neutral and external** — error tracking cannot detect its own absence. It ships in W4 as a checklist item, not a PostHog feature.

## 4. Workstreams

#### W0 — Record the decision and align the launch plan — **S**
**Why:** launch stream F6 (`2026-07-27-002-…:375-381`) currently verifies "a deliberately-triggered test error reaches the Sentry dashboard (server)", F1's production-secret list names Sentry, and §7 decision #2 is open — all three now answered by this plan.

Tasks: edit `2026-07-27-002-feat-claxedo-cloud-launch-streams-plan.md` — F6 DoD becomes "a deliberately-triggered test error from each runtime (app, server, Worker, relay) appears as an issue in PostHog Error Tracking"; F1's secret list swaps Sentry for `CLAXEDO_POSTHOG_KEY` + `POSTHOG_CLI_TOKEN`; §7.2 records "provider: PostHog (2026-07-28-001); owner: <named human>". Add this plan to `docs/plans/README.md`'s retained list.

**DoD:**
- `grep -in "sentry" docs/plans/2026-07-27-002-*.md` → zero hits.
- `grep -n "2026-07-28-001" docs/plans/README.md` → one hit.

**Depends on:** nothing.

#### W1 — Identity and the product-plane contract — **M**
**Why:** `person_profiles: "identified_only"` with zero `identify()` calls makes every per-user metric uncomputable in principle (spec finding #2), and the PII items must land **before** any key reaches production (spec pre-launch #2).

Tasks:
- Redact `context_selection_added`: literal path → extension + one-way hash (`use-session-commands.tsx:220-235`). Hash external channel user ids in channel session events.
- `posthog.identify(user_id)` + `posthog.group("org", org_id)` on auth resolution in the app; `posthog.reset()` on sign-out. Server/Worker captures set `distinct_id = user_id` and `$groups.org` (extend `posthog.ts` `capture()` and the `worker-telemetry.ts` payload).
- Required-properties contract (spec §4.1): the product-plane capture signatures in `analytics.ts` and `control-plane/services.ts` require `org_id`, `user_id`, `surface`, `deployment_mode` at the type level. The ops plane (`operational-telemetry.ts`, `distinct_id: "system"`) is exempt by construction and keeps the `deploy-runbook.md:258` content-free boundary.

**DoD:**
- A scratch-branch call site missing any of the four properties fails `tsgo -b` (tripwire: add it, watch the build fail, remove it).
- Unit test: capture with identity set emits `distinct_id = user_id` and `$groups.org = org_id` in the exact payload (spy on `fetch`/client).
- `grep -rn "context_selection_added" packages/claxedo-app/src` shows no un-hashed path property; test asserts the property is extension+hash shaped.

**Depends on:** nothing. **Blocks:** W4.

#### W2 — PostHog-backed error sinks in every runtime — **L**
**Why:** the seam (`report.ts`) and its call sites are correct; only the per-runtime sinks bind to a second vendor's SDKs. Replacing the sinks makes `reportError`/`reportPaymentError` land in PostHog Error Tracking with the same key-absent no-op contract `observability.test.ts` already enforces.

Tasks (one sub-stream per runtime; disjoint files):
- **W2a Node server:** new `observability/node.ts` implementation: build the sink over the existing `posthog-node` client (`posthog.ts`) — `client.captureException(error, distinctId ?? "system", { ...tags, ...extra })`. Extend `main.ts:8`'s `uncaughtException` handler: capture + bounded `flush()` before `process.exit(1)`, preserving the `ERR_WORKER_OUT_OF_MEMORY` isolation carve-out and exit semantics (do **not** use `enableExceptionAutocapture`; the server owns its exits).
- **W2b Worker:** add `captureException` to `worker-telemetry.ts`: fetch-based `$exception` event carrying `$exception_list: [{ type, value, stacktrace: { type: "raw", frames } }]` from a minimal `err.stack` parser, plus tags as properties (`page_class` included). Replace the `withSentry` wrapper (`worker.ts:354`) with explicit coverage: Hono `app.onError`, try/catch in `scheduled()` (`worker.ts:274,302` currently lean on the wrapper), `ctx.waitUntil` on the capture promise. Register it via `setErrorReporterSink` exactly where `worker.ts:85-94` does today.
- **W2c Relay:** replace `@sentry/bun` in `workspace-relay/src/main.ts` with `posthog-node`: init gated on key, `reportFatal` captures + `flush()` with a 2s bound, never throws on the exit path.
- **W2d App boundaries:** `posthog.captureException(err, props)` in the branded error routes (`app/routes/error.tsx`, `error-page-harness.tsx`) so handled boundary errors are captured, not only unhandled ones.
- **W2e Desktop main:** `uncaughtException`/`unhandledRejection` handlers in `claxedo-desktop/src/main` → `posthog-node` `captureException` + bounded flush, gated on key presence and W3's mode switch; `deployment_mode` from owner decision D2.
- **Config module:** `observability/sentry-config.ts` becomes `observability/config.ts` — same env→options shape (release from `CLAXEDO_RELEASE`/`GIT_SHA`, `deployment_mode` tag, `unit` tag) keyed on `CLAXEDO_POSTHOG_KEY`. Rewrite `observability.test.ts` and the worker tests against the new sinks, keeping every existing contract: key absent ⇒ no init, no network, no throw; `page_class=payment` stamped; throwing sink never propagates.
- **Retire after green:** remove `@sentry/cloudflare`, `@sentry/node`, `@sentry/bun`, the root `@sentry/solid` + `@sentry/vite-plugin` override pins, the `network/types.ts:82` sentry egress entry, and the `wrangler.toml:45-47` DSN comment (now documents `CLAXEDO_POSTHOG_KEY`).

**DoD:**
- `bun run test` for `observability.test.ts`, `worker.test.ts`, `worker.scheduled.test.ts` green, with the key-absent no-op assertions intact and **tripwired** (point a sink at a fake key, assert exactly one fetch/capture; remove the guard, watch it fail, restore).
- Worker import-graph guard green (the new error path stays fetch-only; `posthog-node` still absent from the Worker graph).
- `grep -rn "@sentry" packages/ package.json bun.lock` → zero hits.
- Local proof: boot the Node server with a real key and `throw` behind a debug route — the exception appears in PostHog → Error Tracking with `unit: "server"` tags (screenshot).

**Depends on:** nothing (parallel with W1). **Blocks:** W3, W4.

#### W3 — `CLAXEDO_TELEMETRY_MODE` kill-switch — **M**
**Why:** today "don't set the key" is the only off-switch; `privacy.md`'s "no keys ⇒ nothing sent" needs a stronger, named control, and the project's own posture (`embedded-auth.ts:110`: self-host boxes must not phone home) needs an expressible test.

Tasks: `CLAXEDO_TELEMETRY_MODE=on|off` checked **first**, before key presence, in every sink: `analytics.ts` (via a Vite-injected equivalent), `posthog.ts`, `worker-telemetry.ts`, the new observability config, relay init, desktop main. Default **off** when `deployment_mode` resolves to self-host; Cloud deploys set `on` explicitly beside the real secrets. The onboarding funnel's `ossOptIn` gate (`features/onboarding/funnel.ts`) remains the app-level self-host opt-in above this floor.

**DoD (spec §4.6, verbatim contract):** a test boots each sink with `CLAXEDO_TELEMETRY_MODE=off` **and a real-looking key present**, and asserts zero network calls (spy on `fetch`/client init). **Tripwire it:** remove the off-check, confirm the test fails, restore.

**Depends on:** W2 (sink set is final). **Blocks:** W4.

#### W4 — Provision, verify end-to-end, and stand up the watch — **M**
**Why:** zero keys exist in any workflow; every event and exception is inert until this lands (spec finding #1). Everything before this stream is local-first; this is the staged/deployed half.

Tasks:
- Secrets/vars: `VITE_POSTHOG_KEY`+`VITE_POSTHOG_HOST` in `deploy-claxedo-app.yml` + `deploy-claxedo-app-staging.yml` build env (public by design — `VITE_` vars ship in the bundle; only the project key, never a personal API key); `CLAXEDO_POSTHOG_KEY`+`_HOST`+`CLAXEDO_TELEMETRY_MODE=on` in `deploy-control-plane.yml` (wrangler secrets) and the relay's Fly secrets via `deploy-relay.yml`; desktop release workflow per owner decision D2. `CLAXEDO_RELEASE=$GITHUB_SHA` already flows at deploy time — reuse it so issues carry the release SHA.
- Source maps: enable Vite build source maps for the app deploys; `posthog-cli sourcemap inject` + `upload` step (`POSTHOG_CLI_TOKEN` secret); strip `.map` files from the published artifact.
- Dashboard: enable **exception autocapture** in project settings; alerts — new issue → Slack, issue spiking → Slack, and `page_class=payment` → the on-call channel (the paging class the seam already stamps). PostHog MCP + the `posthog` plugin skills (`authoring-error-tracking-alerts`, `grouping-noisy-errors`) drive this; MCP requires an authenticated session.
- External uptime check (vendor-neutral) against the Worker health route and the app URL, alerting the same on-call channel.

**DoD:**
- `grep -rn "POSTHOG" .github/workflows/` → hits in exactly the three deploy workflows (+ desktop if D2 says on).
- Staging, per runtime: deliberately throw → the issue appears in Error Tracking tagged `unit` ∈ {app, server, worker, relay}; the app issue's stack is **symbolicated to source** (screenshot each; vision-reviewed).
- A test-fired alert reaches Slack; killing the staging Worker trips the uptime alert.
- One real staging session shows `identify` + `$groups` on the person profile.

**Depends on:** W1, W2, W3; production leg additionally on launch chain A1 → C3 → F1.

#### W5 — Metering: sandbox compute, AI tokens, activation — **L**
**Why:** the owner's two cost questions are unanswerable today — lease rows carry no duration and no org/user key; token counts exist in `agent-sdk-runtime/src/compat-events.ts:195,302` and are persisted nowhere (spec §3).

Tasks (spec §4.2, §4.3, §4.5 are normative; summarized):
- `sandbox.lease_opened` / `sandbox.lease_closed` (+ `active_ms`, `reason`) from the lease create/close paths; lease rows gain `org_id`+`user_id`; `sandbox_usage_daily` rollup table + cron.
- `llm_turn_completed` at message completion in `central-session-runtime.ts` (~:338-353) with the full token property set; **dual-write** to PostHog and a new Convex `llm_usage_events` table (PostHog capture is best-effort by design; the table is the billing-grade record — owner decision D1). `credential_source` (`platform`|`user_byok`) is a follow-up at the `loadApiKey` seam (`central-session-runtime.ts:204-210`), not v1.
- `session_started` (server-emitted), `user_activated` (idempotent first-`llm_turn_completed`-ok check-and-set).
- Every new Convex function is `internalMutation`/authed builder — the security review's guard (`2026-07-27-003` §5) flags any new `publicMutation`. Each new table ships with ≥1 reader query and a retention cron (owner decision D3).

**DoD (spec-inherited, verbatim):** synthetic lease under a fake clock asserts `active_ms` within ±5s; staging lease then **query the table** for that `sandbox_id` and match wall-clock. Fake-provider integration test asserts emitted token fields equal the provider's usage object; staging turn then query `llm_usage_events` by `session_id` for plausible non-zero counts. `user_activated`: error turn then ok turn fires exactly once; third turn does not re-fire.

**Depends on:** W1 (identity), W4 (keys, for the PostHog half). Post-launch by design.

#### W6 — Feature-usage taxonomy — **S**
**Why:** WorkGraph, permission decisions, harness and model selection have zero instrumentation; settings toggles have eleven events (spec §3).

Tasks (spec §4.4 verbatim): `workgraph_task_created`/`workgraph_task_completed` (ids only, no titles/content), `permission_decided` (`decision`, `mode`, generic `tool_kind` — never the literal command or path), `model_selected`, `harness_selected`.

**DoD:** each event has a unit test asserting its property allowlist (tripwire: add a forbidden property, watch the test fail); events visible in staging PostHog after one scripted session.

**Depends on:** W1. Parallel with W5.

#### W7 — Public docs and privacy truth — **S**
**Why:** `privacy.md:29-31` names two vendors and predates this decision; self-host docs never mention telemetry; the deployer env table must document the new switch.

Tasks: rewrite `packages/claxedo-web/src/pages/privacy.md` telemetry section — PostHog only, product analytics + error tracking, the exact property posture (redactions of W1), the `CLAXEDO_TELEMETRY_MODE` control, keep the load-bearing promise "no keys configured ⇒ nothing is sent, no network calls", bump the effective date. Add a Telemetry section to `public-docs/self-host-fly.md`; add `CLAXEDO_TELEMETRY_MODE` to `public-docs/hosted-control-plane-worker.md` and `packages/claxedo-docs/deploy/hosted-control-plane.mdx` env tables; refresh `public-docs/deploy-runbook.md:258` to name the two-plane model (ops plane stays content-free and unidentified; product plane is identified).

**DoD:**
- `grep -in "sentry" packages/claxedo-web/src/pages/privacy.md public-docs/ packages/claxedo-docs/` → zero hits.
- The privacy page's stated property list matches a captured staging payload field-for-field (manual diff recorded in the PR).

**Depends on:** W1 (redactions), W3 (the switch it documents).

## 5. Owner decisions

- **D1 — source of truth for money-grade numbers.** Proposed: Convex tables authoritative (`llm_usage_events`, `sandbox_usage_daily`); PostHog is the analytics view. (Spec §5.1; dual-write is deliberate because PostHog capture is best-effort.)
- **D2 — desktop telemetry posture.** Proposed: `deployment_mode: "desktop-local"`, telemetry **on** in Claxedo-distributed builds with a visible settings opt-out plus `privacy.md` disclosure; self-built desktops inherit self-host default-off. Resolves the desktop/hosted conflation before the field ships (spec §5.2).
- **D3 — retention.** Proposed: raw fact rows 400 days via cron, daily rollups kept; PostHog project retention per plan default. (Spec §5.3 — unbounded growth otherwise.)
- **D4 — Convex exception forwarding.** Proposed: accept the dashboard-logs gap at launch; revisit log-stream → Worker → `$exception` post-launch.
- **D5 — the named analytics owner** (launch-plan §7.2's remaining half): a human who watches Error Tracking and the alerts channel. F6's "configured *and watched*" is not satisfiable by configuration alone.

## 6. Parallelization map (normative)

- **Wave 1 (parallel):** W0 · W1 · W2a · W2b · W2c · W2d+W2e — disjoint file sets (docs / app-features / server-observability / worker / relay / desktop). W2's shared `observability/config.ts` + test rewrite lands with W2a and the other sub-streams rebase on it.
- **Wave 2:** W3 (touches every sink — single agent, after W2 merges).
- **Wave 3:** W4 (staging keys + verification), then W5 ∥ W6 ∥ W7.
- Suggested agent fan-out: one agent per Wave-1 stream in separate worktrees (W2a/W2b/W2c all edit `packages/claxedo-server` — worktrees or serialize those three); a Workflow with per-stream `agent()` calls and an adversarial verify stage on each DoD before merge. Use the repo's fake-provider/captured-request pattern for W5's integration tests.
- Verification gate for the whole plan: every DoD line above has a runnable command or a recorded artifact (screenshot/query result) attached in the PR; anything user-visible is vision-reviewed per the inherited principles.
