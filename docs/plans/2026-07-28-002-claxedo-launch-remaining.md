# Claxedo Cloud launch: what is actually left

- **Date:** 2026-07-28
- **Status:** ACTIVE — this is the live launch checklist
- **Supersedes:** `2026-07-27-002` (launch streams), `2026-07-27-004` (tracking review + metric spec), `2026-07-27-005` (doc retention triage). All three were executed; they described far more finished work than remaining work, so they were deleted rather than left to rot. Their conclusions that still matter are carried here.
- **Still separate:** `2026-07-27-003-claxedo-cloud-security-review.md` (an agent is working from it) and `2026-07-28-001-feat-posthog-observability-plan.md` (PLANNED, not yet executed).

Operating principles (unchanged): exact DoD per item; a task without a runnable verification command is not done; **green tests are claims** — every guard must be tripwired, and anything user-visible needs vision-reviewed evidence; never deploy to discover a failure.

---

## 1. What is already done (so nobody re-does it)

The launch plan and the metric spec were largely executed across ~40 commits. Verified by reading code and running commands, not by trusting commit messages:

- **Metering works.** `llmUsageTotals` returns `billable_tokens_per_user`; `sandboxUsageDaily` returns `active_seconds_per_user` — both from org/user-tagged persisted rows, 30/30 tests passing including a fake-clock proof that `active_ms` is a real measurement. **Both owner cost questions are answerable from persisted data today.**
- **Org attribution is closed** on client and server. This was the blocking gap for any per-user average.
- **`CLAXEDO_TELEMETRY_MODE`** is checked before key presence in all five sinks, self-host defaults off, with a test proving off beats key-presence. Now set explicitly in both `[vars]` and `[env.staging.vars]`.
- **PII redaction** — the raw file path in `context_selection_added` is fixed and unit-tested.
- **Retention crons** exist on both fact tables (unlike `audit_events`, which shipped with none).
- **CI**: one generic turbo `test` task now enumerates 24 real `#test` taskIds; the previously-orphaned `@claxedo` packages are in. The claxedo-server "suite hangs" belief was a myth.
- **npm**: one publish path covers all 12 public packages; `publish-preflight` is 12 PASS / 0 FAIL.
- **Deploy prompt** carries the concrete bindings, prerequisites, and commands, with a drift test binding it to the real `wrangler.toml`.
- **Docs**: AGENTS.md conflict markers, the `public-docs/README.md` false claim, and the broken `docs/README.md` link are all fixed; a link check runs in CI.
- **Staging Cloudflare deployment exists** and deploys continuously from `dev`. `claxedo.com` is live.

---

## 2. Owner-only — nothing ships without these

### 2.1 Telemetry is still dark (highest impact)

Every line of telemetry code is correct and tested. **No key is provisioned anywhere**, so zero data lands. Verified live via `gh api`:

- `VITE_POSTHOG_KEY` is absent from all 19 staging variables. No `POSTHOG_CLI_TOKEN` secret exists.
- **There is no `production` GitHub environment at all** — only `staging` and `staging - packages/claxedo-docs` — yet `deploy-control-plane.yml:339` already references `environment: production`.
- Worker-side needs `wrangler secret put CLAXEDO_POSTHOG_KEY --env staging` (and production), plus flipping `CLAXEDO_TELEMETRY_MODE` to `"on"` for Cloud deploys. This is deliberately a manual step, not workflow-plumbed.

**DoD:** a test error and a real session appear in PostHog for both staging and production, confirmed in the dashboard — not "the capture call was invoked."

### 2.2 Production environment (blocks 2.1, F2's prod config, and launch)

Create the environment with required reviewers, provision **39** secrets/vars (not ~30 — CI provisions only the GitHub layer; the runtime layer is hand-provisioned), and run one supervised promote.

> **Trap, documented in `public-docs/production-environment-runbook.md`:** repo-level `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` are inherited silently and the preflight only tests non-emptiness. Adding just the four named secrets makes **production deploy into the staging Cloudflare account.**

### 2.3 CI is red on two fronts

- `local diagnostics release gate` — perf-harness `run:all`, all 5 flows hitting "error boundary rendered" / <60hz.
- **e2e shards 2, 4, and 11** — Playwright core-suite locator/visibility timeouts, one "browser has been closed" (that signature has historically meant a 0-byte Chrome, never a real test failure).

Owner is fixing these. Agents must not touch `live-*` specs, tier wiring, or the perf harness.

### 2.4 Desktop release

Now simpler: **there are no installed users**, so the Tauri `latest.json` vs electron-updater `latest*.yml` feed mismatch needs no compat shim, and release-history continuity does not matter.

- Delete draft releases v0.0.60/61/62 rather than reconciling them.
- Cut and undraft a real tag, then bump `packages/claxedo-web/src/config.ts` `version` (download *filenames* are already correct and resolve 200).
- Remove the now-dead `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` / `TAURI_SIGNING_PUBLIC_KEY` repo secrets — unused signing keys are liability, not insurance.
- Switch `release-claxedo.yml:143` `build-desktop` from `environment: staging` to `production` **once 2.2 exists**, or a prod release bakes staging config.

### 2.5 www.claxedo.com 404s

Apex returns 200; `www` 404s from a stale Cloudflare→Vercel zone record. DNS-only fix. The in-repo claims are already accurate.

### 2.6 Two remaining decisions

- **Name the human analytics owner.** The provider question is settled (PostHog, per `2026-07-28-001`); the owner is not.
- **Onboarding flag.** `VITE_CLAXEDO_ONBOARDING_V1` is correctly gated off. The production decision needs F3 evidence first — see §3.

---

## 3. Engineering work still open

| Item | Where | Note |
|---|---|---|
| **Security: 4 must-fix items** | `2026-07-27-003` §4 | An agent is working these. `createCloud` guard, `agentExtensionPolicies` org check, `/create` rate limiter + lease cap, `auditEvents` authorization. **The `createCloud` fix must land in the Convex mutation, not the Worker route** — the mutation is reachable directly via the public Convex SDK. |
| **Execute the PostHog plan** | `2026-07-28-001` | PLANNED, implementation-ready. Carries the error-tracking half. |
| **Onboarding evidence (F3)** | `onboarding-desktop` skill | Fresh-profile run, vision-reviewed against D1–D11. Not doable headless; needs a real desktop session. |
| **Admin read surface for metering** | `convex/usageMetering.ts` | `llmUsageTotals` / `sandboxUsageDaily` are callable but have **no UI or dashboard consumer**. Do not repeat the `audit_events` write-only mistake — someone must actually look at these numbers. |
| **Stale Sentry references** | `public-docs/production-environment-runbook.md:148,413-415,515,705` | Sentry is gone repo-wide; the runbook still describes `CLAXEDO_SENTRY_DSN` as a live optional secret. |
| **npm publish** | — | Gated on merge to `dev` with green CI. Prep is complete. |

**Explicitly not gaps:** `credential_source` (platform vs BYOK) is an *explicit non-goal* — hosted ≡ non-BYOK by design. End-user Cloud docs (B4/B5) are dropped by owner decision. F5 backup/DR, F6 launch checklist, and F7 workspace-persistence status are deferred.

---

## 4. Facts worth not rediscovering

Carried from the deleted docs because each was expensive to establish:

- **Do not bump either `wrangler.toml` `compatibility_date`.** ≥2026-03-17 flips `websocket_standard_binary_type`, and `socketFrame()`/`socketPayload()` in `workspace-relay/src/cloudflare.ts` return undefined for Blob — **every binary tunnel frame is dropped silently, no throw, no log**, and the tests use hand-rolled doubles that don't catch it. Both are held at 2025-05-01 with the reasoning inline.
- **The Convex function is the security boundary, not the HTTP proxy in front of it.** `VITE_CONVEX_URL` ships in the app bundle and the `convex` client is public on npm, so every exported Convex function is reachable by any signed-up user. Three separate bugs of this exact shape were found independently.
- **`workspace_id` is `ws_${Date.now().toString(36)}`** — a bare millisecond timestamp, no random component, in both server variants. Enumerable, which compounds any missing collision guard.
- **The BYO conflation.** "BYO compute" = user-hosted VM via relay, which *is* shipped. "User supplies sandbox-provider keys to Cloud" is a non-goal. Three public strings (`pricing.astro:10`, `index.astro:37`, `competitors.ts:78`) claim the latter about Cloud — **open copy defect, owner call.**
- **Managed sandbox provisioning needs usage-based billing first.** The kill switch today is absence-of-config (`sandboxDriver(env)` returns undefined → `/create` 503s), which is easy to re-arm by accident. If it's a launch control, make it an explicit flag.
- **Shared working tree.** Multiple agents run here concurrently. Never `git add -A` or bare `git commit` — stage explicit paths, commit with `--only`.
