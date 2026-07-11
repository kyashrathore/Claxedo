# WP-OPS — The operational floor for charging money (design decision record)

Date: 2026-07-11
Status: **proposed — decision record; execution waves to be cut from §7 after review**
Scope: `.github/workflows/`, `packages/claxedo-server` (Worker + Fly), `packages/workspace-relay`, `packages/sandbox-manager`, `convex/`. Explicitly OUT: relay multi-instance routing (deferred, see §2.4/§6), billing/auth themselves (docs 012–015), desktop app release pipeline (`release-claxedo.yml` is a separate concern and already automated).
Siblings: `2026-07-11-012-feat-cloud-subscription-launch-plan.md` (§1.4 there names the ops gaps this doc decides on; WS-D of 012 should be scoped from this document).

This is an ADR, not a runbook. Each decision lists real options with how-it-works / why good / why bad / failure modes, then a recommendation with the reasoning chain. Repo citations are for grounding only; the point is the reasoning.

---

## §1 — Current ops architecture, and why it is fine for free and disqualifying for paid

### 1.1 What exists today (verified against the tree)

- **Deploys.** The only automated backend deploy is `.github/workflows/deploy-cloudflare-sandbox-worker.yml` — manual-dispatch, and it exists for one reason: the ~4.5GB sandbox image can't reasonably be pushed from a laptop. Everything else deploys by hand from a laptop: the control-plane Worker (`packages/claxedo-server/wrangler.toml`, which already defines an `[env.staging]` nobody is forced through), the relay, and Convex (`npx convex deploy`). The self-host Fly shape (`packages/claxedo-server/fly.toml`) is likewise `fly deploy` from a checkout.
- **Telemetry.** PostHog product analytics only (`packages/claxedo-server/src/posthog.ts`, `src/control-plane/worker-telemetry.ts`). No error tracking, no alerting, no uptime check. Both wrangler configs have `[observability] enabled = true`, so Cloudflare's Workers Logs are being collected — but nobody is querying them and nothing alerts off them. The relay has a token-gated `/metrics`; the Fly configs have `/api/claxedo/health` checks. There is an OTLP seam at `packages/core/src/observability/otlp.ts`, but it is engine-scoped (runs inside user runtimes, env-gated, off by default) — it is not control-plane observability.
- **Relay.** `public-docs/relay-and-deployment.md` is explicit: production v1 is single-instance, host presence and tunnel sockets live in process memory, and "restart, deploy, or crash events drop active host tunnels and long-lived HTTP/WebSocket/SSE/PTY sessions until the workspace-runtime host reconnects." A drain controller exists (`packages/workspace-relay/src/server.ts` — health flips unhealthy, new work 503s `relay_draining`, tunnels close, pending work drains up to a timeout) but nothing orchestrates it during a deploy.
- **Sandbox lifecycle.** Cleanup is `POST /internal/sandbox-manager/gc` behind an admin bearer token (`packages/claxedo-server/src/routes/hosted-sandbox-admin.ts`), calling `sandboxManager.garbageCollect()` (`packages/sandbox-manager/src/index.ts`). It runs when a human remembers to curl it. There is no `convex/crons.ts`; nothing reconciles `runtime_leases`/`sandbox_leases` against what the driver is actually billing for. The Daytona driver already plumbs `autoStopInterval`/`autoDeleteInterval` (`packages/sandbox-manager/src/drivers/daytona.ts:283-284`) but policy for them is not an operated, asserted invariant.
- **Convex schema evolution.** Hand-rolled: `convex/sandboxLeases.ts` has a `normalizeLegacyFields` mutation; `convex/schema.ts` carries optional legacy camelCase fields with a comment that code should "migrate/read around old rows without deleting dev data." No migration framework, no record of which backfills ran against which deployment.

### 1.2 Why this was the right call for a free beta

Honest appraisal cuts both ways. For a free beta this setup is not negligence, it is correct economics:

- The blast radius of an outage is goodwill among users who paid nothing. The operator is also the heaviest user, so "monitoring" is dogfooding — most incidents are noticed within minutes because they break the operator's own workflow.
- Laptop deploys have the fastest possible iteration loop, and a solo builder pre-PMF should be spending engineering hours on the product, not on CI plumbing for four backend units.
- Orphaned sandboxes at beta traffic levels cost single-digit dollars. A cron to save $4/month is bad ROI when the alternative use of that day is a feature.

### 1.3 Why it is disqualifying the day the first $9 clears

Charging money changes three things, none of which are about scale:

1. **The incident you can't see.** Today an exception in the Worker is a log line in a 7-day Cloudflare buffer nobody reads. Post-launch, the highest-value failure is precisely the one dogfooding won't catch: the Polar webhook route (doc 012 WS-B) throws on a signature edge case, webhooks are silently dropped, `seats_licensed` never syncs, and paying customers are either blocked from adding a teammate or riding free. Nothing pages. The operator finds out days later from an angry email — from a *customer* now, not a beta user. Analytics-only telemetry structurally cannot surface this: PostHog tells you what users did, never what the system failed to do.
2. **The deploy you can't roll back — or even name.** "What is running in prod?" currently has no answer that isn't shell history on one laptop. Worse: laptop deploys can (and eventually will) ship uncommitted working-tree code, at which point the previous version *does not exist anywhere* — there is no artifact to roll back to. Convex sharpens this: it is push-only (see §2.3), so "rollback" already means "re-push old code from git," which requires the old code to be a known git SHA. Laptop deploys break the one precondition Convex recovery depends on.
3. **The orphaned sandbox you pay for.** With paying users, sandbox-driver spend becomes a real COGS line against a $6.55/seat/month contribution margin (doc 012 §0). Every failure mode that strands a driver resource — process dies between the driver create and the lease write, a `release` whose driver delete errored after the lease row was already cleared, a control-plane redeploy mid-acquire — leaks money continuously until a human remembers a curl command whose token also lives on the laptop. A leak that requires human memory to stop is not a leak with a bound; it is a leak with a mood.

There is also a fourth, quieter change: **fail-safe posture**. A solo operator sleeps ~8 hours a day and takes flights. Anything whose worst case grows without bound during operator absence (money leaks, dropped webhooks with no retry visibility) must be redesigned so absence caps the damage. That principle — *design for the operator being asleep, not for faster paging* — recurs through every decision below.

What the floor is **not**: five-nines, multi-region, canary analysis, on-call rotations, SOC2. §6 defers each with an explicit trigger. The floor is: every deploy is a git SHA with a rollback story, every paid-path error reaches a phone, and no resource can bill for more than a bounded grace period after its reason for existing is gone.

---

## §2 — Decision 1: deploy pipeline architecture

Four backend units with different deploy planes: control-plane Worker (wrangler), Convex (push), relay (Fly machine today; a DO Worker shape exists in-repo but is not the production relay), sandbox image (already in Actions). The decision is one architecture applied per-unit, plus a relay-specific sub-decision, plus an honest per-unit rollback table.

### 2.1 Options

**Option A — GitHub Actions with staging→prod promotion and smoke gates.**
*How it works:* merge to `dev` auto-deploys every touched unit to staging (`wrangler deploy --env staging` — the envs already exist in both wrangler configs; a staging Convex deployment; a staging Fly relay app). A smoke job then runs: health endpoints plus one authenticated golden path (sign in → open workspace → tunnel echo). Prod is a manual promotion — a GitHub *environment* with required review, so promoting is one click on the same commit whose staging smoke passed, not a rebuild.
*Why good:* prod becomes a function of a git SHA — the single property everything else (rollback, "what's running", incident forensics) depends on. Secrets move from a laptop keychain to GitHub environments. Rollback for Worker/relay/Convex becomes "promote the previous green SHA." The staging envs already written into the wrangler configs stop being decoration.
*Why bad / tradeoffs:* four units introduce ordering and cross-version compatibility questions (a Worker that calls a Convex function that doesn't exist yet). CI wall-clock and YAML maintenance land on one person. A staging Convex deployment is another thing to keep schema-current. Fly deploys from CI concentrate a `FLY_API_TOKEN` in GitHub — repo compromise becomes prod compromise (mitigated by environment-scoped secrets + required review on the prod environment, but it is a real trade).
*Failure modes:* staging drift makes smoke green while prod breaks (staging must share the same Convex *schema* lineage and the same secrets *shape*); smoke tests decay into false confidence — per this repo's own verification doctrine, a green smoke is a claim, so the smoke must assert user-visible behavior (a real tunnel round-trip), not just 200s on `/health`.

**Option B — tag-triggered deploys.**
*How it works:* pushing `v2026.07.11` (or `relay-v3`) triggers build+deploy of tagged units.
*Why good:* explicit, human-paced, batches changes into named releases; familiar from library publishing (this repo already tags for `release-claxedo.yml`).
*Why bad:* for a continuously-deployed *service* owned by one person, a tag is a manual dispatch with extra ceremony and none of the added safety — it does not create a staging rehearsal, and it invites drift where `dev` runs ahead of the last tag for weeks so each release becomes a big-bang diff. Tags answer "what did we ship to users' machines," which is the desktop app's question, not the backend's.
*Failure modes:* the big-bang release; tagging the wrong SHA under pressure; hotfix tags that bypass whatever gates existed.

**Option C — keep manual, add a runbook.**
*How it works:* a checked-in `OPS.md` with exact commands, orderings, and verification steps; deploys stay laptop.
*Why good:* zero build cost; a runbook is worth writing regardless (and survives as the break-glass path under Option A).
*Why bad:* it fixes none of §1.3. The unrollbackable deploy, the unanswerable "what's in prod," the uncommitted-code deploy — all remain. Runbooks executed by hand rot precisely because nothing fails when they're skipped.
*Failure modes:* the runbook and reality diverge silently; the bus factor is unchanged; under incident pressure the runbook's careful ordering is the first casualty.

### 2.2 Recommendation: Option A, minimal shape

**Adopt A**, deliberately small: one reusable deploy workflow per unit + one orchestrating "promote" workflow, GitHub environment approval instead of any canary machinery. The reasoning chain:

1. The paid-readiness property is *prod = known SHA with a rehearsal*. Only A produces it; B produces "prod = known SHA" without the rehearsal; C produces neither.
2. Convex's push-only model (§2.3) makes git-SHA discipline *load-bearing for recovery*, not just hygiene — which eliminates C.
3. Solo-operator cost is bounded because the staging envs, health endpoints, and the sandbox-image workflow pattern already exist; this is wiring, not invention.
4. B is strictly dominated: everything a tag gives (a named, auditable release) falls out of A's promotion log for free.

**Ordering rule** (encoded in the promote workflow, from most-backward-compatible to least): Convex first (its changes are additive-only per Decision 4, so old Workers keep working against new Convex), then control-plane Worker, then relay (with drain, §2.4). Sandbox image stays on its own dispatch cadence — it is versioned by build-id/snapshot-name and pinned from the control plane (`deploy-cloudflare-sandbox-worker.yml` already surfaces `CLAXEDO_SANDBOX_BUILD_ID` for exactly this), so it is a *pinned artifact*, not a lockstep deploy.

**Smoke gate content** (the minimum that isn't theater): health on all three units; one signed-auth golden path against staging (device/CLI exchange → open a cloud workspace → round-trip through the relay tunnel); one Convex query via the Worker. Anything beyond that is Wave-2 material, not floor.

### 2.3 What rollback actually means, per unit (the honest table)

| Unit | Mechanism | Speed | Hard limits |
|---|---|---|---|
| Control-plane Worker | `wrangler rollback` / Workers versions & deployments | seconds | Cannot roll back across a Durable Object migration; bound-resource state (KV/D1/DO storage) is untouched by rollback ([Cloudflare docs](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)) |
| Relay on Fly | `fly releases --image` → `fly deploy --image <previous>` | ~1–2 min (no rebuild) | Redeploys the *image*; current `fly.toml`/secrets apply, not the ones from that release; a rollback is itself a deploy, so it drops tunnels again ([Fly rollback guide](https://fly.io/docs/blueprints/rollback-guide/)) |
| Convex | none server-side; re-push old code: `npx convex deploy` from the previous SHA | minutes, requires the old SHA | Push-only. Schema must still validate against *current* data, so a rollback that re-narrows a schema the bad deploy widened will be rejected; data written by the bad version is never reverted; deploy history lives in your git log, not in Convex ([deploy CLI](https://docs.convex.dev/cli/reference/deploy), [production guide](https://docs.convex.dev/production)) |
| Sandbox image | re-pin `CLAXEDO_SANDBOX_BUILD_ID`/snapshot name on the control plane | config change | Old snapshot must still exist in the registry; running sandboxes keep their epoch's image |

Three consequences worth stating plainly:

- **Convex is the unit that cannot roll back.** "Rollback" there is really *roll-forward eligibility*: it works only if every schema change was additive (old functions still validate) and if the bad deploy's data writes are tolerable or repairable. A deploy that shipped a schema change *plus* a backfill has no rollback at all — only a fix-forward. This is why Decision 4 (additive-only discipline + a real migration tool) is not optional polish; it is the substitute for a rollback button. It also dictates the ordering rule above: the unrollbackable unit must be the most backward-compatible one, deployed first, alone.
- **Worker DO migrations must ship solo.** The relay's DO-shaped sibling (`packages/workspace-relay/wrangler.toml`, `WorkspaceRelayRoom`) and any future DO in the control plane mean a code change bundled with a DO migration poisons the rollback well for everything in that deploy. Cloudflare's own guidance is to deploy DO migrations independently — adopt that as a rule now, while there is one migration tag (`v1`) in the file, not after the first bundled disaster.
- **Fly rollback ≠ config rollback.** Secrets and `fly.toml` changes ride outside the release image. The mitigation is cheap: `fly.toml` is already in-repo; keep it the *only* source of config truth and treat `fly secrets set` as a logged, deliberate act (the promote workflow's job summary is a fine log).

### 2.4 The relay's special problem: every deploy drops live tunnels

The relay doc is honest that this is structural in v1: tunnels are process-local, so process replacement severs them, and hosts must reconnect. Three responses:

**R1 — Drain-then-deploy orchestration.**
*How:* the deploy workflow triggers drain (the controller exists: health goes unhealthy so Fly stops routing, new tunnel registrations and workspace requests get `503 relay_draining`, active tunnels are closed so hosts reconnect promptly, pending work drains up to the timeout), waits for pending≈0 or timeout, deploys, then *verifies reconvergence* — asserts via `/metrics` that tunnel count returns to within tolerance of pre-drain within N minutes.
*Why good:* converts an uncontrolled mid-request sever into a clean, bounded, observed cutover; nearly all the machinery is already written and merely un-orchestrated; the reconvergence assertion doubles as the best possible smoke test for the relay.
*Why bad:* on a single instance, drain minimizes *corruption*, not *downtime* — there is nowhere for hosts to reconnect to until the new process is up, so a deploy is still a seconds-to-a-minute full tunnel outage, plus whatever long-lived PTY/SSE sessions were mid-flight. A Fly blue-green overlap does not fix this: two live relay instances behind one hostname is exactly the split-brain the relay doc forbids without sticky host routing.
*Failure modes:* drain timeout too generous (deploys hang on one stuck PTY) or too stingy (in-flight work severed anyway); reconvergence check passing on tunnel *count* while a specific host is wedged — tolerate this at floor level, it is what error tracking is for.

**R2 — Maintenance windows.**
*How:* relay deploys happen at a published low-traffic time; optionally a status-page notice.
*Why good:* zero engineering; honest with users; pairs naturally with batching relay changes (the relay changes far less often than the control plane).
*Why bad:* the user base is global — there is no universally low-traffic hour — and "we schedule downtime to deploy" is a weak posture for a paid developer tool whose core value is a persistent tunnel to your VM. As the *only* mechanism it also does nothing for the unplanned restart (crash, Fly host migration), which drops tunnels identically.
*Failure modes:* the window becomes a reason to defer relay fixes; emergencies don't wait for windows.

**R3 — Accelerate multi-instance / the Durable Object relay.**
*How:* either build sticky host routing + failover ownership for multi-instance Fly, or promote the in-repo DO relay Worker to production — DOs give per-room stickiness by construction, and Workers' versioning moves each DO atomically between versions ([gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/)).
*Why good:* the only option that actually removes the SPOF rather than scheduling around it; the DO code exists and has clearly seen perf iteration (the `dist-worker-*` experiment dirs).
*Why bad:* it is a migration project wearing an ops costume — production-hardening a relay that has never carried paid traffic, under WebSocket/DO limits, right before launch. Doc 012 explicitly defers multi-instance routing (OQ-3), and the standing decision is relay-on-Fly. Rewriting the data plane to make deploys smoother is the classic pre-launch trap: maximal risk to fix a bounded, known, communicable inconvenience.
*Failure modes:* schedule blowout absorbing exactly the weeks that billing/auth need; discovering DO socket-lifetime semantics differ from the Bun relay's under real PTY load.

**Recommendation: R1 now, R2 as policy, R3 deferred with a named trigger.** Finish the drain orchestration into the deploy workflow (small, mostly-written, and it also improves *crash* behavior since drain-on-SIGTERM covers Fly-initiated restarts); batch relay deploys weekly-ish and, when they contain tunnel-affecting changes, do them at a published time (R2 costs nothing); keep R3 as the standing deferred milestone with the trigger defined in §6 — sustained tunnel counts / the first paying team for whom a 60-second weekly blip is a contract problem. The reasoning: at $9/seat with BYO-VM users, a *bounded, clean, announced* reconnect blip is sellable; a corrupted half-drained deploy or a multi-week relay rewrite before revenue are not.

---

## §3 — Decision 2: observability

Frame the requirement for what this company actually is: one person, no rotation, phone in pocket. The system must (1) push paid-path failures to that phone within minutes without anyone watching a dashboard, (2) carry enough context to debug from the notification, (3) cost near-zero maintenance and near-zero false positives, and (4) cover three heterogeneous runtimes: a Cloudflare Worker, a Node/Bun process on Fly, and Convex functions.

### 3.1 Options

**Option A — Sentry.**
*How:* `@sentry/cloudflare` wraps the Worker handler with `withSentry` (ESM handlers, errors + optional tracing + logs — [Sentry Cloudflare guide](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)); the Node SDK covers the relay; Convex has a first-party exception-reporting integration that forwards function exceptions to a Sentry DSN, configured in the dashboard (Pro plan — [Convex exception reporting](https://docs.convex.dev/production/integrations/exception-reporting)). Alert rules route new/regressed issues to email/Slack/mobile push.
*Why good:* it is an *error tracker*, not a log pile — grouping, dedup, regression detection, and release tagging are exactly the missing organ. One pane across all three runtimes is rare; the Convex-side integration is the clincher, since nothing else covers Convex without building a log-stream pipeline. Release tagging composes with Decision 1: "this issue first appeared in SHA X" is the rollback trigger. Sentry Crons can watch the Decision-3 reaper (a dead reconciler is a silent money leak — the watcher must be external to the thing watched). Free tier (~5K errors/mo) likely covers launch scale; maintenance is near zero after setup.
*Why bad:* another vendor and DSN sprawl; SDK weight and a wrapper in the Worker hot path; tracing is where Sentry gets expensive, so it stays off; error *volume* spikes (a crash loop) can burn quota exactly when you need visibility — set spike protection/sample rates.
*Failure modes:* alert fatigue if every noisy client-triggered 4xx becomes an "issue" (curate: server exceptions and explicit `captureException` on paid paths only); the Worker being *down* produces no Sentry events at all — error tracking cannot detect its own absence, which is why the floor needs an external uptime check regardless of this choice.

**Option B — Cloudflare-native: Workers Logs (+ Logpush).**
*How:* already half-adopted — `[observability] enabled = true` sits in both wrangler configs. Workers Logs gives structured invocation logs, a query builder, 7-day retention on paid, 20M events/mo included then $0.60/M ([Workers Logs docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)); Logpush can ship them to a sink.
*Why good:* zero SDK, zero new vendor, genuinely good forensics for the Worker; effectively free at this scale.
*Why bad:* it covers exactly one of three runtimes — nothing for the Fly relay, nothing for Convex. It is logs, not error tracking: no grouping, no "new issue" concept, no regression detection; alerting on log queries via Cloudflare notifications is coarse and platform-centric. Logpush presupposes a destination, i.e., you end up choosing Option A or D anyway.
*Failure modes:* the 7-day window silently expires the evidence for any incident discovered late — which, with no alerting, is the *default* discovery mode; head-sampling after volume caps drops the needle during the haystack fire.

**Option C — OpenTelemetry stack.**
*How:* standardize on OTLP export everywhere; the repo already has a seam at `packages/core/src/observability/otlp.ts` (Effect OtlpLogger + NodeSdk tracing, env-gated). Point it (and new instrumentation in Worker/relay) at a backend — Grafana Cloud, Honeycomb, or a self-hosted collector.
*Why good:* vendor-neutral; traces are the right tool for the actually-hard debugging here (a request that crosses Worker → Convex → relay → sandbox); one instrumentation investment survives vendor changes.
*Why bad:* it answers a question the floor isn't asking. The floor needs "tell my phone when paid things break"; OTel needs a *backend someone operates or pays for*, instrumentation work in three runtimes (Workers OTel support is community/adapter-level or arrives via Sentry's own SDK anyway), and alert-rule curation on top. And the existing `otlp.ts` is a false friend: it instruments the *engine inside user runtimes*, not the control plane — repurposing it is a project, not a toggle. Solo-operator burden is the highest of all options.
*Failure modes:* the collector/backend becomes the least-maintained, most-critical service; sampling misconfiguration makes traces beautiful and incidents invisible.

**Option D — Axiom / (Baselime-style) log analytics.**
*How:* ship Worker logs (Logpush or SDK), relay logs, and Convex log streams (Pro supports Axiom as a first-party destination — [log streams](https://docs.convex.dev/production/integrations/log-streams/)) into Axiom; write monitors/alerts on queries. (Baselime itself was acquired by Cloudflare and folded into Workers observability — it is no longer the independent option it was.)
*Why good:* very cheap at small scale, generous retention (fixes B's 7-day problem), one queryable place for *all three* runtimes' logs; Convex log streams make it the best *log* aggregation answer.
*Why bad:* log search still isn't error tracking — grouping/dedup/regression detection must be hand-built as saved queries and monitors, which is precisely the curation work a solo operator won't keep up with. Alerts fire on query thresholds, not "a new kind of exception appeared," and the second kind is the one that matters at launch.
*Failure modes:* the unwritten monitor — the incident class you didn't pre-imagine never alerts; monitor thresholds tuned once at launch traffic and never again.

### 3.2 Recommendation: Sentry as the floor; keep Workers Logs as free forensics; one external uptime check; defer OTel and log aggregation

Chain: (1) the binding constraint is *unattended detection with grouping*, which only an error tracker provides — that eliminates B and D as the primary and reframes them as complements; (2) among error trackers, Sentry is the only one with first-party coverage of all three runtimes including Convex's dashboard-level integration, which removes the largest build item; (3) C is deliberately deferred, not rejected — when cross-service latency debugging becomes the recurring pain (it will, around relay scale-out), OTel is the right investment, and nothing chosen here obstructs it.

Concretely: `withSentry` on the control-plane Worker with release = git SHA from the Decision-1 pipeline; Node SDK in the relay; Convex→Sentry exception integration (requires Convex Pro — an acceptable launch cost that also unlocks log streams later); Sentry Crons monitor on the Decision-3 reaper; Workers Logs stays on (already enabled, effectively free) as the forensic layer behind the alert. Plus one **external uptime monitor** (UptimeRobot/BetterStack-class free tier) on the Worker health route, relay `/health`, and the marketing/app origin — because when the Worker itself is down, only something *outside* the blast radius can say so.

**What paging means for a one-person company.** Design it honestly rather than cosplaying an SRE org:

- Exactly **two page classes** (audible, bypasses focus modes): payment-path exceptions (webhook route, checkout, seat sync) and uptime-check failures on Worker or relay. Everything else — sandbox retries, client errors, Convex warnings — lands in a daily digest.
- **Alert budget ≈ zero false positives.** Any alert that fires wrongly twice gets fixed or demoted immediately; a solo operator who learns to ignore the phone has no monitoring at all. Fewer, truer alerts beat coverage.
- **MTTR includes sleep.** No rotation means detection→response can be 8 hours. The correct engineering response is not more paging, it is Decision 3's fail-safe posture: systems whose unattended worst case is bounded (auto-delete caps a leak; webhook failures are visible *and* replayable from Polar's delivery log). Paging tells you damage is accruing; fail-safe design caps how much.

---

## §4 — Decision 3: resource reconciliation (the money leak)

Two sources of truth that can disagree: the lease store (Convex `sandbox_leases`, mediated by `packages/sandbox-manager`) and the driver (Daytona et al.), where the bill actually accrues. Orphans are born in the gaps: crash between driver-create and lease-write; lease released but the driver delete call failed; lease `ready` while the driver already reaped the resource; control-plane redeploy mid-acquire. Note the asymmetry: a driver resource without a lease costs *money forever*; a lease without a driver resource costs *one user a failed session* until the resume path (`decideSandboxStart` in `packages/sandbox-manager/src/lease-policy.ts`) heals it. Design accordingly — the money direction is the one that needs machinery.

### 4.1 Options

**Option A — scheduled reconciliation loop (a reaper).**
*How:* on a timer, list driver-side resources (drivers already label them with workspace/epoch — see the labels in `packages/sandbox-manager/src/index.ts`), list leases, and converge both directions: driver resource with no live lease and age past grace → stop/delete; lease `ready` with no driver resource → mark failed so the next acquire cold-starts. Two implementation homes: a Convex cron (`crons.ts` + an action that calls the driver APIs — actions can `fetch`, but this duplicates driver code and driver secrets into Convex), or — better — a **Cloudflare Cron Trigger on the control-plane Worker invoking the existing `sandboxManager.garbageCollect()`**, i.e., exactly what the manual admin endpoint already calls, minus the human. The manual endpoint remains as break-glass.
*Why good:* level-triggered — it converges from *current state*, so it catches every orphan class including the ones caused by its own host's redeploys; it needs no new logic, only a schedule on logic that already exists and is already exercised by the admin route; extending GC to the driver-side sweep is incremental.
*Why bad / failure modes:* the reaper itself can die silently (hence the Sentry Crons monitor — the watcher must live outside the watched); it can *kill live work* if grace periods don't respect the acquire state machine (a sandbox mid-cold-start looks orphaned — the reaper must honor lease epochs, `acquiring`/`starting` states, and active holds, all of which the lease policy already models); two overlapping runs must be idempotent (driver deletes are; make lease transitions epoch-guarded, which they are by design); driver list pagination bugs make the sweep silently partial.

**Option B — rely on driver-native auto-stop/auto-delete.**
*How:* Daytona sandboxes carry `autoStopInterval` (default 15 min idle → stop), `autoArchiveInterval`, and `autoDeleteInterval` (default disabled; N minutes stopped → delete) ([Daytona sandbox docs](https://www.daytona.io/docs/en/typescript-sdk/sandbox/), [sandbox lifecycle](https://www.daytona.io/docs/en/sandboxes/)). The driver already passes these through (`daytona.ts:283-284`); make the values deliberate policy.
*Why good:* the **only mechanism that survives total control-plane death** — if the Worker, Convex, and the operator are all offline for a week, the bill still stops. Zero infrastructure, zero code, enforcement lives where the money lives. That fail-safe property is unobtainable by any loop we run ourselves.
*Why bad:* Daytona-only semantics — the placement table in `lease-policy.ts` shows drivers differ materially (the Cloudflare driver can't even `canStopExplicitly`), so this is per-driver policy, not an architecture. It also can't fix the lease table's beliefs: a lease that says `ready` after Daytona auto-stopped is stale state that only a loop (or the next user request eating one failure) corrects. And auto-*delete* trades money for user data — deleting a stopped sandbox destroys workspace filesystem state, so the delete horizon must sit behind the archive horizon, sized as a product decision ("how long does an idle cloud workspace survive?"), not an ops constant.
*Failure modes:* an interval misconfigured to 0 means "delete on stop" in Daytona's semantics (their own issue tracker documents the interval-value inconsistencies) — a one-character config error becomes data loss; provider-side enforcement changing under you silently.

**Option C — event-driven cleanup.**
*How:* release on session end, workspace delete, org offboarding — the shape that partially exists (`release` admin route; session lifecycle hooks).
*Why good:* immediate, cheap, and the best *latency*: the common case releases in seconds, so the reaper's grace period isn't the common case's cost.
*Why bad — and structurally insufficient for money resources:* events are edge-triggered, and the failure modes that *create* orphans are precisely edge-loss: the crash that dies before emitting, the deploy that restarts the listener mid-event, the handler bug that throws. An edge, once missed, is gone; no future event re-announces an orphan that already exists. For a resource that bills continuously, correctness demands level-triggering — *observe state, converge state* — because the leak's cost is proportional to detection time, and event systems have unbounded detection time for lost events. This is the Kubernetes-controller argument, and it applies with extra force when there is no second engineer to notice the discrepancy by hand.
*Failure modes:* exactly the gaps of §4.0; plus double-release races with in-flight acquires (epoch guards handle this — keep them).

### 4.2 Recommendation: all three, layered, because they fail differently

This is not a compromise; the layers cover disjoint failure classes:

1. **Driver-native as the financial backstop (B).** Aggressive `autoStopInterval` (the manager's own idle policy already targets 10 min — align them), `autoArchiveInterval` at the product-decided idle horizon, `autoDeleteInterval` well behind archive. Bounds the worst case *including operator absence and total control-plane failure*. This is the §1.3 fail-safe principle made concrete.
2. **A scheduled reconciliation loop as the truth-keeper (A).** CF Cron Trigger → existing `garbageCollect()`, extended to the two-way driver-list sweep, every 10–15 minutes, epoch- and hold-respecting, with a Sentry Crons check-in so its death pages. This keeps the lease table honest (B can't) and stops leaks in drivers that lack lifecycle knobs (B doesn't exist there).
3. **Event-driven release as the fast path (C).** Kept for latency and cost, trusted for nothing.

Why not fewer layers: A alone has a single point of silent failure (the scheduler) guarding an unbounded liability; B alone leaves lease-state lies and non-Daytona drivers; C alone is disqualified above. The combined system's residual risk is "reaper dead *and* Daytona lifecycle misconfigured *and* event missed, simultaneously" — acceptable.

---

## §5 — Decision 4: Convex data/schema evolution discipline

Context that raises the stakes (from §2.3): Convex is the unit with no rollback. Discipline here isn't code hygiene; it is the *replacement* for a rollback button. Convex also enforces schema-validates-against-data on every push ([production guide](https://docs.convex.dev/production)) — you physically cannot push a narrowing schema over nonconforming rows, which means some form of expand-migrate-contract is already mandatory, not optional. The question is only how the *migrate* middle is executed and recorded.

### 5.1 Options

**Option A — adopt the Convex migrations component (`@convex-dev/migrations`).**
*How:* migrations defined as named functions over a table (or subset); the component runs them in batches, checkpoints progress, resumes after timeouts, tracks state so a migration never double-runs, invokable from CLI or a server function; supports paired down-migrations ([component page](https://www.convex.dev/components/migrations)).
*Why good:* it solves the four things every hand-rolled backfill re-solves badly — batching (a naive mutation over a big table hits execution limits), resumability, idempotency, and *a durable record of what ran on which deployment*. That last one is the quiet killer at small scale: with staging + prod (Decision 1), "did the backfill run on prod or just staging?" must be answerable by the machine, because memory is currently the migration ledger and memory is what fails during incidents.
*Why bad / tradeoffs:* a dependency and its update cadence; a state table in your data; learning its idioms; down-migrations are still *your* logic — the component makes reversal runnable, not correct.
*Failure modes:* half-completed migration + code that assumed completion (mitigate: code must tolerate both shapes until the migration's completion is verified — which is just expand-contract restated); a buggy migration checkpointing its own damage forward.

**Option B — versioned hand-rolled migration mutations (status quo, tidied).**
*How:* what `normalizeLegacyFields` is, plus conventions: numbered files, a manual ledger, self-batching via cursors.
*Why good:* no dependency; total transparency; fine for the rare, tiny backfill.
*Why bad:* each migration re-implements batching/resume/idempotency, i.e., re-implements the component, worse, under deadline; the ledger is a doc humans forget; nothing stops the same mutation running twice or on the wrong deployment. This was the right cost/benefit pre-paid; billing tables (doc 012 WS-B adds `plan`, `seats_licensed`, `subscription_status` to `orgs`) end that era — a double-run backfill over subscription state is a customer-facing money bug.
*Failure modes:* the un-run migration (deployed code, forgotten backfill — prod limps on legacy-shaped rows indefinitely, which is precisely the current schema's comment archaeology); the double-run; the timeout at 60% with no cursor.

**Option C — conventions only: expand-migrate-contract, no tooling.**
*How:* written law: pushes are additive (new tables, optional fields, unions-before-type-changes — Convex's own list of safe changes); code reads around both shapes; contract (drop/require fields) only after verified backfill; no framework for the migrate step.
*Why good:* the convention is 80% of the value — it is what keeps old Workers compatible with new Convex (Decision 1's ordering) and what keeps re-pushing old code viable (Decision 2.3's only Convex recovery). Zero dependencies.
*Why bad:* conventions without tooling govern the *easy* part (schema shape) and abandon the *hard* part (executing the backfill reliably) — exactly where B's failure modes live. "Discipline" that relies on a solo operator's consistency during launch weeks is a plan to fail politely.
*Failure modes:* the contract step lands before the backfill truly finished (nothing machine-checked the completion); optional-field archaeology accretes forever because contracting is scary without a verified-completion signal — the current `projects` table is this failure mode already in progress.

### 5.2 Recommendation: C as law + A as the tool; retire B

They are complements, not alternatives: expand-migrate-contract is the *policy* (and the thing that keeps Convex roll-forward-safe), the migrations component is the *mechanism* for the middle step. Adopt both; `normalizeLegacyFields` becomes the first component-managed migration and the pattern is retired.

What is worth its overhead pre-PMF, honestly:

- **Worth it:** additive-only pushes (it is what Convex recovery stands on); the component for any backfill touching >trivial row counts or any billing/auth table; verified-completion before contract; schema changes deployed *alone*, before dependent code (the Convex analog of the DO-migrations-ship-solo rule).
- **Not worth it:** down-migrations for every change (write them only where the table is money — `orgs` billing fields, seats; elsewhere fix forward); CI schema-diff gates (Convex's push validation already rejects the dangerous class); migration dry-run environments beyond the Decision-1 staging deployment; any data-versioning ceremony beyond the component's own ledger. Pre-PMF, the schema *should* still churn fast — the discipline's job is to make churn safe, not slow.

---

## §6 — Risks, deliberate non-goals, and the "when does this stop being enough" ladder

### 6.1 Risks created by this plan itself

- **Secret concentration in GitHub.** Actions now holds Cloudflare, Fly, Convex, and Sentry tokens; a repo/Actions compromise is a prod compromise. Mitigate: environment-scoped secrets, required review on the prod environment, least-privilege API tokens (the sandbox workflow's token-scoping comment is the pattern). Accepted residual risk — it still beats a laptop keychain with no audit trail.
- **Staging drift → confident broken promotes.** Staging that diverges in schema lineage or secret shape makes smoke gates theater. Mitigate: staging Convex participates in the same migration ledger; secrets differ in value only, never in shape.
- **Green-smoke false positives.** House doctrine already says green tests are claims. The smoke must assert behavior (a real tunnel round-trip), and the relay deploy must assert tunnel *reconvergence*, not process liveness.
- **Alert decay.** The two-page-class budget only holds if enforced; the first tolerated false page starts the slide to an ignored phone.
- **Bus factor unchanged.** Everything here makes operations *repeatable*, not *transferable*. The runbook from Option C is still written — as the break-glass doc — and secrets escrow somewhere that isn't one laptop.

### 6.2 Deliberate non-goals, each with the trigger that revisits it

| Deferred | Why deferring is correct now | Trigger to revisit |
|---|---|---|
| Multi-instance / DO relay (§2.4 R3) | Migration-project risk before revenue; blip is bounded and communicable | Sustained tunnel concurrency where a deploy blip visibly hits many users; first team customer for whom the blip is a contract issue; or relay CPU/memory ceiling on one Fly machine |
| Multi-region anything | One region's latency is acceptable for a control plane; data plane is the user's own VM | Paying cohort in a region with unacceptable relay RTT; provider region outage actually experienced |
| On-call rotation / paging infra (PagerDuty et al.) | There is no rotation to manage; Sentry mobile push + uptime pinger is the whole stack | A second engineer exists |
| Canary / gradual rollouts | Traffic too small for canary signal; staging rehearsal covers the class | Enough traffic that staging can't represent prod; or first incident a canary would have caught |
| SOC2 / formal compliance | $30–60K + process weight, nobody is asking | First enterprise deal blocked on it; interim: a truthful security page (auth model, key handling, BYO-VM boundary) costs a day and answers 80% of questionnaires |
| SLAs / status-page automation | No contractual uptime at $9/seat | First customer contract that asks; a *manual* status page (BetterStack-class free tier) is cheap enough to include at launch — it converts invisible incidents into visible honesty, which is the whole trust game for a fork (per the GTM research) |
| OTel tracing (§3 Option C) | Alerting floor doesn't need it; backend burden is real | Recurring cross-service latency debugging; likely arrives with relay scale-out |
| Log aggregation with long retention (§3 Option D) | 7-day Workers Logs + Sentry context suffices at launch volume | First incident where the evidence expired before diagnosis; or Convex Pro's log streams making Axiom a one-afternoon add |

### 6.3 The ladder, restated as a sentence each

Floor (this doc): every deploy is a reviewed SHA with a rehearsal and a per-unit rollback story; failures on money paths page a phone; no orphaned resource outlives its grace period even if the whole control plane is down. Next rung (~hundreds of seats or second engineer): DO/multi-instance relay, log aggregation, tracing, canary. Rung after (~enterprise): compliance, SLAs, multi-region, rotation. The floor is deliberately the smallest set that makes charging money honest — everything above it is bought with revenue the floor makes possible.

---

## §7 — Decision summary (feeds WS-D scoping in doc 012)

| # | Decision | Choice |
|---|---|---|
| 1 | Deploy pipeline | GitHub Actions, staging auto-deploy on `dev` + smoke gate + one-click prod promotion via environment approval; order Convex → Worker → relay; DO migrations and Convex schema changes ship solo; sandbox image stays a pinned artifact |
| 1b | Relay deploys | Drain-then-deploy orchestration with reconvergence assertion now; published windows for tunnel-affecting changes; multi-instance/DO relay deferred with named trigger |
| 1c | Rollback doctrine | Worker: `wrangler rollback`; Fly: redeploy prior image; Convex: roll-forward-only — additive schema discipline is the rollback substitute |
| 2 | Observability | Sentry across Worker + relay + Convex (exception integration, Pro) with release=SHA; two page classes only; external uptime pinger; Workers Logs kept as free forensics; OTel + log aggregation deferred |
| 3 | Reconciliation | Layered: Daytona autoStop/autoArchive/autoDelete as the money backstop, CF Cron Trigger → existing `garbageCollect()` extended to a two-way sweep as truth-keeper (Sentry Crons-monitored), event-driven release kept as fast path only |
| 4 | Convex evolution | Expand-migrate-contract as law + `@convex-dev/migrations` component as the mechanism; hand-rolled backfills retired; down-migrations only for money tables |

### Vendor references

- Cloudflare Workers rollbacks and limits: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/ · gradual deployments & DOs: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/
- Workers Logs (retention/pricing): https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Fly rollback (redeploy prior image; config not versioned): https://fly.io/docs/blueprints/rollback-guide/
- Convex deploy (push-only): https://docs.convex.dev/cli/reference/deploy · production/schema-safety: https://docs.convex.dev/production · exception reporting (Sentry, Pro): https://docs.convex.dev/production/integrations/exception-reporting · log streams: https://docs.convex.dev/production/integrations/log-streams/ · migrations component: https://www.convex.dev/components/migrations
- Sentry Cloudflare Workers SDK (`withSentry`): https://docs.sentry.io/platforms/javascript/guides/cloudflare/
- Daytona sandbox lifecycle (autoStop/autoArchive/autoDelete): https://www.daytona.io/docs/en/typescript-sdk/sandbox/ · https://www.daytona.io/docs/en/sandboxes/
