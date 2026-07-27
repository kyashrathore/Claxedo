# Claxedo tracking: what we measure, what actually works, and the metric spec

- **Date:** 2026-07-27
- **Status:** REVIEW + SPEC — planning only, nothing instrumented by this pass
- **Owner questions this must answer:** how much sandbox compute does my average user consume? how many AI tokens? which features do they care about most? what happens to tracking when someone self-hosts, and can they turn it off?
- **Method:** four parallel auditors (client analytics, server/edge telemetry, self-host privacy posture, usage/cost metering), then a skeptical end-to-end reality-checker instructed to distinguish *code exists* from *code runs* from *event actually arrives*, then a spec pass. The usage-metering auditor returned a placeholder stub; its ground was re-covered by the reality-check and spec stages. All headline claims below were re-verified by hand.

---

## 1. Verdict

**Essentially none of it works. You would launch blind.**

The repo contains roughly 55 distinct analytics events across ~18 files, a well-designed server-side telemetry seam, and a tested no-op contract for Sentry. It is not sloppy work. It is simply **not connected to anything**, and it has never been.

Three findings, each verified by hand:

1. **No API key is provisioned anywhere.** `grep -rn "POSTHOG" .github/workflows/` → **zero hits**. Same for `SENTRY_DSN`. Neither the client build (`deploy-claxedo-app.yml`, `deploy-claxedo-app-staging.yml`) nor the Worker deploy (`deploy-control-plane.yml`) supplies a key. Every sink is gated on key presence, so every event is inert in every deployed build.

2. **No user or org is ever identified.** `grep -rn "\.identify(\|\.group("` across `packages/claxedo-app/src` → **zero hits**. PostHog is configured `person_profiles: "identified_only"`, and no person is ever identified. **This is the harder blocker of the two:** without attribution, "average per user" is uncomputable in principle, no matter how many events you add.

3. **Frontend crash visibility is dead too.** The app has no Sentry by deliberate design — `platform/telemetry/analytics.ts:43` states it "replaces Sentry: automatically captures unhandled exceptions." That capture path runs through the same unprovisioned pipe. Backend Sentry is a correct no-op without a DSN, and no DSN is set either.

**The good news:** #1 is a workflow edit with zero new code, and ~55 events start working immediately.

---

## 2. Self-host and privacy posture

**Verified clean: there is no hardcoded PostHog key anywhere.** `grep -rnE "phc_[A-Za-z0-9]{20,}"` across all of `packages/` returns nothing. Self-hosters do **not** silently report to the owner's instance. This is the single most important question in this area and the answer is the right one.

Everything else here is a gap:

- **There is no opt-out switch.** The only mechanism is "don't set the key" — opt-out by omission, not a documented control. For an OSS project whose audience is developers, that is a materially weaker promise than a named env var.
- **Self-host docs never mention telemetry.** `grep -i "telemetry|posthog|sentry|analytics"` over `public-docs/self-host-fly.md` → zero hits.
- **The one real gate is unreachable.** `features/onboarding/funnel.ts:7-21` correctly gates self-host emission behind an `ossOptIn` flag defaulting to off, and it is tested. But neither call site ever passes `ossOptIn: true`, so there is no UI path to opt in. The gate is honest; the opt-in is unbuilt.
- **Desktop is classified as `hosted`.** `app/workbench/rail/onboarding-empty-state.tsx:53` treats `platform === "desktop"` as `deployment: "hosted"`, so a downloaded desktop user would inherit Cloud's default — while `privacy.md` frames local mode as "your work stays on your machine." This conflation must be resolved deliberately, not encoded into the new `deployment_mode` field.

### PII to fix before the key is provisioned

- `features/session/ui/use-session-commands.tsx:220-235` sends `context_selection_added` with the **literal file path**. Harmless while the pipe is dead; a real leak the moment it goes live. Redact to extension or a one-way hash.
- Channel session events carry **external channel user ids**.
- `privacy.md` describes generic "product analytics" and discloses neither of the above.

---

## 3. Can we answer the owner's cost questions today? No.

### Sandbox compute — **cannot compute**

`convex/sandboxLeases.ts` rows carry `workspace_id` and `sandbox_id` but **no duration and no `org_id`/`user_id`**. There is no `started_at`/`ended_at` pair to subtract and no key to group by. Missing fields, not a missing query.

### AI tokens — **data exists, is captured nowhere**

Token counts *are* available: `packages/agent-sdk-runtime/src/compat-events.ts:195,302` populates `message.tokens` with `{input, output, reasoning, cache:{read,write}}`. Nothing persists it.

And a distinction you will need does not exist in any form: `grep -rln "platformCredential|platform_credential|userCredential|BYOK|credentialSource"` across `packages/claxedo-server/src` and `convex` → **zero hits**. There is no way to separate turns billed to *your* credentials from turns billed to the *user's* own. That's new plumbing at the `loadApiKey` resolution point, not exposing an existing flag.

**Do not reuse `tokentracker-cli` for this.** `server-usage-limits.ts` probes *remaining quota windows* for the status-bar button — a different question from token consumption — and it explicitly pins `TOKENTRACKER_NO_TELEMETRY=1`.

### Feature usage — **the differentiated surfaces have zero instrumentation**

WorkGraph, permission grant/deny, harness selection, and explicit model selection emit **no events at all** (verified by grep across those feature directories). Meanwhile settings toggles have eleven. The instrumentation that exists is inversely correlated with what you need to know.

---

## 4. The spec

### Ordering

**Pre-launch (small, deliberately):**
1. **Provision the keys.** `CLAXEDO_POSTHOG_KEY` + `CLAXEDO_SENTRY_DSN` in `deploy-control-plane.yml`; `VITE_POSTHOG_KEY` in both app deploy workflows. Zero new code, ~55 events live.
2. **Redact the file path** in `context_selection_added` — must land *before* #1 reaches production, or you ship a PII leak.
3. **`identify()` + `group()`** with user id and org id. Without this, #1 produces uncountable data.
4. **`CLAXEDO_TELEMETRY_MODE` opt-out**, defaulting off for self-host builds, plus a docs section.

**Immediately after launch:** sandbox and token metering (§4.2, §4.3) — these need schema, and shipping them badly is worse than shipping them a week late.

**Then:** the feature-usage taxonomy (§4.4).

### 4.1 Required-properties contract

Enforce at the wrapper, not by per-call-site discipline: every event carries `org_id`, `user_id`, `surface`, `deployment_mode` (`cloud` | `self-host` | `desktop-local` — resolving the desktop conflation above).

- **Where:** `platform/telemetry/analytics.ts` (client) and `control-plane/services.ts` (server) capture signatures.
- **DoD:** TypeScript compilation *fails* for a call site missing any of the four. Verify by adding a non-compliant call site in a scratch branch and confirming `tsgo -b` rejects it.

### 4.2 Sandbox compute

| Item | Where | Captures |
|---|---|---|
| `sandbox.lease_opened` | `convex/sandboxLeases.ts` + `routes/hosted-workspace.ts` create path | `org_id`, `user_id`, `workspace_id`, `sandbox_id`, `driver`, `started_at` |
| `sandbox.lease_closed` | `routes/hosted-sandbox-admin.ts:41,60`; `control-plane/sandbox-relay-target.ts:34-48` on stop/destroy | same key + `ended_at`, `active_ms`, `reason` (`idle_timeout`\|`explicit_release`\|`gc`) |
| `sandbox_usage_daily` | new Convex table + cron in `convex/crons.ts` | `org_id`, `user_id`, `date`, `driver`, `total_active_seconds`, `lease_count` |

**Note the schema change:** lease rows must gain `org_id` and `user_id`; they carry neither today.

**DoD:** hold a synthetic lease open for a known interval N and assert `active_ms` is within ±5s of N under a fake clock. Then in staging: provision, wait a measured interval, release, and **query the table** for that `sandbox_id`. Confirm `active_ms` matches wall-clock — do not accept "the emit function was called."

Answers Q1 as `AVG(total_active_seconds) GROUP BY date`.

### 4.3 AI tokens

**`llm_turn_completed`** — emitted at message-completion in `central-session-runtime.ts` (near line 338-353, where `providerID`/`modelID` are already resolved), reacting to where `compat-events.ts` populates `message.tokens`.

Properties: `org_id`, `user_id`, `session_id`, `harness`, `provider_id`, `model_id`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_write_tokens`, `turn_status`, `latency_ms`.

**Destination: both PostHog and a new Convex `llm_usage_events` table.** Every PostHog `capture()` in this codebase is wrapped in best-effort try/catch (`operational-telemetry.ts:88-94`) — correct for product analytics, wrong for a number you may later gate a paid plan on.

**`credential_source` (`platform` | `user_byok`)** — a follow-up, not v1. Requires new plumbing at `central-session-runtime.ts:204-210` where `loadApiKey` resolves which credential served the request. This is the field that separates cost from usage.

**DoD:** integration test using the repo's existing fake-provider/captured-request pattern asserts emitted token fields exactly match the fake provider's usage object. In staging: run one real prompt, then **query `llm_usage_events` for that `session_id`** and confirm non-zero plausible counts. For `credential_source`, run two turns — one platform-credential, one user-BYOK — and confirm the field differs.

### 4.4 Feature usage — keep it small

Five events, chosen because these surfaces are currently invisible:

- `workgraph_task_created` / `workgraph_task_completed` — `features/workgraph`. Ids only, **no task titles or content** (avoid repeating the `context_selection_added` mistake).
- `permission_decided` — `decision` (allow|deny), `mode` (auto|manual), `tool_kind` as a generic category, **never the literal command or path**.
- `model_selected` / `harness_selected` — `features/session/ui/select-model.tsx`, `controls/agent-harness-selector.tsx`.

**Resist backfilling the ~40 already-written-but-dead events.** They start working for free once the key lands. Spend new engineering only on genuine gaps.

### 4.5 Activation and retention

- **`session_started`** — server-emitted, attributable. Today only client-side `flowLog` events exist and that pipe is dead.
- **`user_activated`** — idempotent check-and-set of `first_activated_at` on the user record, triggered by the first `llm_turn_completed` with `turn_status: "ok"`. Server-side, mirroring the semantics of the existing but client-only, self-host-suppressed `first_turn_ok` in `features/onboarding/funnel.ts:7-21`. **DoD:** drive one error turn then one ok turn, assert it fires exactly once; drive a third, assert it does not fire again.

### 4.6 Self-host opt-out

**`CLAXEDO_TELEMETRY_MODE=on|off`**, checked **first**, before any key-presence check, in all five sinks: `posthog.ts`, `control-plane/worker-telemetry.ts`, `observability/sentry-config.ts`, `observability/node.ts`, `platform/telemetry/analytics.ts`.

- **Default:** off for self-host/OSS builds — matching the project's own stated posture at `embedded-auth.ts:110` ("Self-host boxes must not phone home"). On for the Cloud deploy, set explicitly alongside the real secrets.
- **DoD:** a test boots each sink with `CLAXEDO_TELEMETRY_MODE=off` **and a real-looking key present**, and asserts zero network calls (spy on `fetch`/`Sentry.init`). This proves the off-switch beats key presence — something today's code cannot express, since key absence is the only gate. **Tripwire it:** remove the off-check, confirm the test fails, restore.
- **Docs:** a Telemetry section in `public-docs/self-host-fly.md` and an accurate property list in `privacy.md`.

---

## 5. Open decisions for the owner

1. **Is PostHog acceptable as the source of truth for tokens and compute, or must the Convex tables be authoritative?** This spec proposes dual-write specifically because PostHog capture is best-effort here. That's a real architectural cost (consistency, storage) and should be an explicit decision, not a discovery.
2. **Is a downloaded desktop user "hosted" or "local" for telemetry purposes?** Today's code says hosted; the privacy policy implies local. Resolve before `deployment_mode` ships, or the new field just encodes the ambiguity.
3. **Retention/TTL for the new fact tables.** `audit_events` has no retention cron and neither would these. One row per lease and per turn is unbounded growth at Cloud scale.
4. **Who reads the numbers?** `convex/auditEvents.ts` is write-only with zero readers anywhere in the repo. **Do not repeat that** — every new table here must ship with at least one query function and a way to actually look at it.
