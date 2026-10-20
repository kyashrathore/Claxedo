# Cold starts of the control plane Worker, 19 October 2026

The hosted control plane (`packages/claxedo-server`, the `claxedo-user-deployed-locked-staging` Worker at `https://api.claxedo.dev`, pinned to `aws:us-east-1` and answering from IAD) answers a warm request from India in about 0.37 s on a reused connection and a cold one in 0.8–1.3 s. This note measures how often a request lands cold, takes one cold request apart with what the platform exposes and what local workerd and Node attribute, records that the control plane was composed again on a quarter of warm requests and why, and says what to read on staging after the fix deploys. Every platform claim cites developers.cloudflare.com; the probe, the tail summary, the local rig and the startup attribution live beside this file.

## Cold against warm from India

`probe.sh` fetched three routes against staging from a Mac in India (edge SIN, `cf-ray …-SIN`) between 21:04 and 21:33 UTC: `/health` (no composition, no database), `/api/claxedo/auth/descriptor` (composes, no database) and `/api/auth/get-session` signed out (composes, Better Auth's session read). Each fetch is one curl invocation with the URL twice, so the first transfer opens a TLS connection and the second reuses it, and the idle gap is slept before every invocation. `cold` and `compose` are the Worker's own `Server-Timing` marks (`platform/http/server-timing.ts`): `cold` on the first request an isolate serves, `compose` on a request that built the control plane instead of reusing one. Other lanes were exercising staging in the same hour (the tail saw 316 `session-authorize` calls from the session hosts), so the Worker was not idle between probes; the gaps are the client's.

| idle gap | requests | cold | compose, not cold | fresh connection, warm (median TTFB s) | fresh, cold | reused connection, warm | reused, cold |
|---|---|---|---|---|---|---|---|
| 0 s | 36 | 2 | 10 | 0.632 (n=13) | — | 0.362 (n=11) | 0.827 (n=2) |
| 1 s | 24 | 1 | 2 | 0.698 (n=10) | 1.181 (n=1) | 0.371 (n=11) | — |
| 5 s | 24 | 4 | 1 | 0.607 (n=9) | 1.182 (n=2) | 0.365 (n=10) | 1.001 (n=2) |
| 30 s | 24 | 12 | 5 | 0.602 (n=5) | 1.073 (n=4) | 0.450 (n=2) | 0.868 (n=8) |
| 120 s | 18 | 6 | 6 | 0.598 (n=1) | 1.119 (n=3) | 0.377 (n=5) | 0.806 (n=3) |

Over all 126 answers (`staging-gaps-2026-10-19.tsv`, the probe's TSV): warm on a reused connection 0.345–0.670 s, median 0.369 (n=39); cold 0.711–1.495 s, median 0.971 (n=25). The cold penalty is the difference at equal connection state: 0.482 s on a reused connection (0.851 against 0.369), 0.506 s on a fresh one (1.139 against 0.632). A fresh connection itself costs 0.26 s before the first byte can move: TCP connect to SIN median 0.123 s, TLS done at 0.243 s (n=63).

Cold is frequent as soon as the client pauses: 5% of requests at no gap, 17% at 5 s, 50% at 30 s, a third at 120 s. The pairs show why. The second transfer of a pair, on the connection the first just used, landed cold ten times right after a first transfer that was not (21:06:18, 21:06:24, 21:14:03, 21:14:36 and six more), so a client connection does not pin an isolate: the edge terminates TLS in SIN and forwards each request to the placed data center, where it may reach a machine that holds no isolate of this Worker. Cloudflare documents the forwarding ("Cloudflare maps your specified cloud region to the data center with the lowest latency to that region", [placement](https://developers.cloudflare.com/workers/configuration/placement/)) and that isolates "are not necessarily long-lived" and are evicted under "Resource limitations on the machine" ([how Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/)); which machine inside IAD serves a forwarded request is not documented and not controllable. The `cf-placement` header the placement page says is added "to all requests when placement is enabled" arrived on 1 of 126 answers (`remote-IAD`); the page also says it "may be removed before Smart Placement exits beta", so a probe cannot rely on it.

## One cold request, taken apart

The Worker's `Server-Timing` durations count only time spent waiting on I/O (`performance.now()` advances only across I/O on Workers), so they read 0 for everything below but D1. `wrangler tail --format json` on the staging Worker (read-only; `tail-summary.py` summarizes it) reports `wallTime` and `cpuTime` per invocation, and those two numbers against the client's TTFB split a cold answer into what happens before the invocation and inside it.

| part | measured | source |
|---|---|---|
| client ↔ SIN, TCP and TLS on a fresh connection | 0.26 s (connect 0.123, TLS done 0.243) | curl timings, n=63 fresh transfers |
| client ↔ SIN ↔ IAD round trip, Worker warm, nothing composed | 0.36 s TTFB on a reused connection for `/health`, whose invocation is 1 ms wall | probe + tail (`/health` wall 1–4 ms, cpu 0–3) |
| isolate start, before the invocation | about 0.39 s: cold `/health` answered in 0.750 s with 1 ms of wall time inside | probe 21:13:32 + tail |
| of which parse and global-scope evaluation | 167–297 ms as Cloudflare reports `Worker Startup Time` at deploy for this bundle; under Node on an M4 Pro the 7,577 KiB full-hosted bundle imports in 101–104 ms, 55 of them compile and 47 global-scope evaluation; a fresh workerd isolate is ready in 152–177 ms (n=5) | deploy logs, `attribute-startup.mjs`, `cold-rig.ts` |
| of which everything else (the script reaching a machine that had none, isolate creation) | the remainder, about 100–220 ms; not exposed by the platform | inferred |
| first composition of the control plane, inside the invocation | 148–160 ms CPU on the cold isolate (`descriptor`, tail wall 154–178) against 16–48 ms CPU for a composition on a warm isolate and 1 ms for a request that reuses one | tail, 18 descriptor invocations |
| Better Auth's first session read on top (`get-session`) | 114–175 ms wall, 30–86 ms CPU; the D1 round itself 77–103 ms (`d1;dur`) | tail, 6 invocations; probe `Server-Timing` |

So a cold `descriptor` on a reused connection is 0.36 s of network, about 0.4 s of isolate start, and 0.15 s of first composition; a cold `get-session` adds a database round. Nothing in the 0.4 s of isolate start is the composition, and nothing in the composition is bytes.

Two platform facts bound what a Worker can do about the first row. Cloudflare hides a Worker's cold start behind the TLS handshake by loading the Worker when the ClientHello names its hostname ([eliminating cold starts](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/): "we hint the Workers runtime to eagerly load that hostname's Worker" and "the cold start is zero"), and that hint reaches the machine terminating TLS, in SIN; a Worker placed in IAD starts only once the forwarded request arrives, after the handshake. And startup is parse plus global scope ("A Worker must parse and execute its global scope … within 1 second", [limits](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time)), which the previous lane already cut from 10,953 to 7,396 KiB and from 76 to 51 ms of evaluation under Node ([README](../README.md)).

What is left in the global scope (`attribute-startup.py` instruments every esbuild module header of the Wrangler bundle; a header's time includes the `__esm` modules it initializes):

| ms under Node (of 47) | module | needed by the first request? |
|---|---|---|
| 25.0 | `@better-auth/oauth-provider/dist/index.mjs`: its header runs `init_zod`, `init_authorize_*` (229 KiB of schemas), `init_introspect_*`, `init_device_authorization` | yes: Better Auth with this plugin answers `get-session` and every cookie verification |
| 3.3 | `@better-auth/kysely-adapter` | yes |
| 2.7 | `@zip.js/zip.js` (configuration, constants, codecs) | no: GitHub plugin sources |
| 1.9 | `src/routes/hosted` | yes |
| 1.8 | `claxedo-server-core/src/documents` | no on the boot path |
| 1.8 | `@earendil-works/pi-ai` (`openrouter.json` 0.8, model tables) | no on the boot path |
| 1.7 | `claxedo-server-core/src/credentials` | partly |
| 1.3 | `workspace-runtime/dist/client.mjs` | no on the boot path |
| 1.2 | `zod` (v4 core index) | yes |

Everything outside the Better Auth chain sums to about 20 ms under Node, spread over dozens of modules of 0.1–2 ms each. Bytes, from the esbuild metafile of the full-hosted bundle (7,447,406 B): `node_modules` 4,442 KiB, of which zod 769 (119 of them zod v3, which the `zod/v4` alias to zod's root entry drags in beside v4), kysely 616, better-auth 422, `@better-auth/oauth-provider` 364, `@earendil-works/pi-ai` 334, `tokentracker-cli` 323 (283 of them `pricing/seed-snapshot.json`), `@better-auth/core` 301, `@zip.js/zip.js` 270, ajv 236, `@modelcontextprotocol/sdk` 205, jose 175; workspace code 3,005 KiB, the largest `claxedo-server-core/src` 589, `src/authority/adapters` 355, `claxedo-helpers/dist` 220 (`skill-frontmatter.mjs` 191). Compile under Node is about 7.4 µs per KiB, so the 1.2 MB of pure data and plugin tooling that no boot request needs costs about 9 ms of compile there and 1–2 ms of evaluation; the previous lane measured minify (−3.5 MB) at about 15 ms of workerd ready time. These are tens of milliseconds on Cloudflare's CPU against a 400 ms isolate start whose larger half is the platform's.

## The composition that never settled

`settledCompositionCache` (`deployments/hosted-workerd/settled-composition-cache.ts`) reuses a composition only once its readiness, Better Auth's `$context` followed by one read on each database, has settled; until then every request builds its own, and the request that composes carries the `compose` mark. On staging, requests that were not cold still composed: 24 of the probe's 101 answers that were not cold, 10 of 34 at no gap, 6 of 12 at 120 s. The tail put a number on each: a `descriptor` that composes costs 16–48 ms of CPU and 23–61 ms of wall time, one that reuses 1 ms and 1–2 ms. Under local workerd the rig showed the mechanism outright: every request of an isolate composed, the sixth `descriptor` as surely as the first.

The cause is documented. "An async call that is neither awaited nor passed to `ctx.waitUntil()` can be canceled when the invocation ends" ([context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)). The readiness reads were started by the composing request and awaited by no one; `descriptor` answers in 2 ms of Worker time, the reads take two database rounds, so the invocation ended first and the promise never settled, never set the cache, and the next request composed again. An isolate escaped only when some request kept its invocation alive long enough (the same page: a streamed body keeps the invocation active), which is why staging showed a mix and local workerd none.

The change: the composing request hands the readiness to its `ExecutionContext.waitUntil`, which the page says "can extend execution for up to 30 seconds after the response is sent or the client disconnects". `createBetterAuthD1Worker` and `createHostedCoreWorker` pass the request's context through to the composition; the cache's rule is unchanged (an unsettled instance is never shared, a failed readiness is never cached), only its readiness now runs to a settlement, and a Durable Object's call, which has no such context, still gets its own instance. Pinned in `settled-composition-cache.test.ts` and `better-auth-d1-worker.timing.d1.test.ts` (the context's `waitUntil` receives exactly one readiness per composition, and the request after it carries no mark).

Local workerd, plain artifact, five rounds each, `cold-rig.ts`:

| request | before (ms wall) | after |
|---|---|---|
| `descriptor` #1 (composes) | 24–28 | 23–26 |
| `descriptor` #2–#6 | 6–12, each `compose` | 2–5, none |
| `get-session` #1–#3 | 7–14, each `compose` | 5–6, none |
| `bootstrap` #1–#2 | 6–7, each `compose` | 2, none |

On staging this removes 16–48 ms of CPU (and the Better Auth, Hono and D1 adapter allocations behind it) from every warm request that previously composed, a quarter of them in the probe, and leaves one composition per isolate. It does not change the cold request: that one composed before and composes now.

## Experiments not taken, with the reason

- **Sharing the in-flight composition among requests that arrive before it settles.** The browser's first wave sends `descriptor`, `bootstrap` and `get-session` together, so a cold isolate builds up to three compositions at 16–48 ms CPU each. Sharing would let a reader await a promise owned by another request's context; with `waitUntil` that context now lives until the readiness settles or 30 s, so the 2026-08-31 wedge (a canceled constructor request leaving every later caller hanging) would need the readiness itself to hang for 30 s, which only a hung database does. Not taken: the rule in the module's header is the one proven live, the saving is bounded to the readiness window (two database rounds, 160–200 ms on staging) of a cold isolate, and the probe shows a wave's requests often land on different machines anyway.
- **Keep-warm requests or a cron.** Nothing on developers.cloudflare.com describes a request or a schedule as a way to keep an isolate resident; the one documented pre-warm is the ClientHello hint above, which region placement forfeits. The probe also shows warmth is per machine inside IAD, so a ping warms one machine of the pool.
- **Smart placement instead of the region pin.** Smart Placement "only considers locations where the Worker has previously run" and weighs forwarded requests, not D1; the Worker would drift to the edge and every signed request would pay its serial D1 rounds across the ocean (`d1-signed-reads-2026-10-18`: 4–7 rounds). The pin stays.
- **Minify, `keep_names = false`, a lazy zip.js.** Measured by the previous lane ([AGENTS.md](../AGENTS.md)); not adopted for the reasons there. This note's attribution agrees: the bytes outside the Better Auth chain are worth tens of milliseconds of startup on Cloudflare's CPU.
- **Dynamic chunks for the plugin tooling, sandbox drivers, pricing and model tables.** Wrangler bundles the Worker into one module, so an `import()` wraps the module without removing its bytes from the parsed script; real chunks need the Worker uploaded as several modules (`no_bundle` with rules) and the closure scanner taught the chunk graph. The measurable prize is the 1.2 MB above: about 9 ms of compile under Node, perhaps 30 ms on Cloudflare. Recorded, not built.
- **A lighter first request** (answering `descriptor` and `bootstrap` without composing). `descriptor` is static configuration; but the first wave also carries `get-session`, which needs Better Auth, so the isolate composes within the same wave either way and the user-visible wait moves by nothing.

## The arrangement that would remove the cold start, as a case, not a change

The two biggest rows above, 0.36 s of forwarding on every request and about 0.4 s of isolate start on a cold one, both follow from running the Worker in IAD while the person's TLS ends in SIN. Cloudflare's documented way to run the Worker where TLS ends and still read the database nearby is D1 read replication with the Sessions API: "D1 automatically creates a read replica in every supported region" (ENAM, WNAM, WEUR, EEUR, APAC, OC), "All write queries are still forwarded to the primary database instance", and a session "ensures sequential consistency", including "Read my own writes" ([read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)). With the pin removed, a request from India would be served by an isolate in SIN that the ClientHello hint loads during the handshake, read `AUTH_DB` and `CONTROL_PLANE_DB` from the APAC replica, and forward only writes to ENAM.

Expected from the numbers here: a warm read-only request 0.36 → about 0.12 s (the client ↔ SIN round trip alone); a cold one 0.85 → about 0.2–0.4 s (the 167–297 ms startup overlapping a 0.24 s handshake); a write-carrying request unchanged or worse (each write round 0.23 s to the primary instead of a few ms beside it, and a `first-primary` session's first read with it). Costs: every reader on the Worker moves from the bare binding to `withSession` with a bookmark carried per client (the page's constraint), replica lag becomes visible wherever a reader deliberately omits the bookmark, and the deployment's two databases must have replication enabled. This needs the owner's decision on consistency and on which routes are read-only; it is not implemented here.

## What the one-origin lane changes

When the app Worker forwards `/api/*` over a service binding, the control plane still runs placed: placement "only affects the execution of fetch event handlers", and the page's own advice is "Enable placement on your back-end Worker to invoke it close to your database" ([placement](https://developers.cloudflare.com/workers/configuration/placement/)). The browser saves the API origin's own connection (0.26 s of connect and TLS before its first request), and the control plane's `fetch(request, env, ctx)` receives its own `ctx`, so the composition's `waitUntil` works the same. The cold start is unchanged.

## What to read on staging after the deploy

1. `./docs/perf/worker-cold-starts-2026-10-19/probe.sh https://api.claxedo.dev gaps.csv "0:6 1:4 5:4 30:4 120:3" /health /api/claxedo/auth/descriptor /api/auth/get-session` (about 25 minutes) and the summary in this note's table: the `compose` column should hold only requests that are also `cold` (an isolate's first composing request) and, rarely, a request inside the 160–200 ms readiness window of one; cold frequency and the cold penalty should match the table above, since this change does not touch the isolate start.
2. `wrangler tail claxedo-user-deployed-locked-staging --format json > tail.jsonl` during the probe, then `python3 tail-summary.py tail.jsonl`: `descriptor` CPU should be 1 ms on every warm invocation and 16–48 ms only on the composing one; a warm `descriptor` above 10 ms CPU means a composition that did not settle.
3. The deploy log's `Worker Startup Time` for this bundle, beside the 167–297 ms of the five deploys before 2026-10-18.
4. For the first wave of a browser boot, the three `Server-Timing` headers in the devtools network panel: at most one of `descriptor`, `bootstrap`, `get-session` should carry `compose` when they share an isolate, and any that is `cold` is a different machine.

## Reproduction

```sh
# staging, read-only
./docs/perf/worker-cold-starts-2026-10-19/probe.sh https://api.claxedo.dev gaps.csv "0:6 1:4 5:4 30:4 120:3" /health /api/claxedo/auth/descriptor /api/auth/get-session
packages/claxedo-server/node_modules/.bin/wrangler tail claxedo-user-deployed-locked-staging --format json > tail.jsonl
python3 docs/perf/worker-cold-starts-2026-10-19/tail-summary.py tail.jsonl

# local workerd: isolate ready and the first requests, per built artifact
bun run --cwd packages/claxedo-server build:workerd-boundary
cd packages/claxedo-server && node --import tsx ../../docs/perf/worker-cold-starts-2026-10-19/cold-rig.ts dist-boundary/workerd/user-deployed-better-auth-d1/better-auth-d1-worker.cf.js 5

# global-scope attribution under Node
python3 docs/perf/worker-cold-starts-2026-10-19/attribute-startup.py \
  packages/claxedo-server/dist-boundary/workerd/user-deployed-better-auth-d1-agent-plugins-full-hosted/better-auth-d1-worker.agent-plugins.full-hosted.cf.js \
  /tmp/instrumented.mjs "$PWD/docs/perf/worker-cold-starts-2026-10-19/cf-stub.mjs"
node docs/perf/worker-cold-starts-2026-10-19/attribute-startup.mjs /tmp/instrumented.mjs
```

The full-hosted artifact composes only with the sandbox drivers' settings (`CLAXEDO_SANDBOX_IMAGE` and the driver keys `hosted-sandbox-key-drivers.ts` requires), so the rig measures its isolate ready time and the plain artifact's requests; the composition cost it reports is the plain artifact's, a lower bound for staging's.

## After one origin, 20 October 2026: the binding hop doubles the cold rate

Since `app.claxedo.dev` fronts the control plane (`scripts/deploy/app-worker.ts` forwards the control plane's paths over the `CONTROL_PLANE` service binding; `api.claxedo.dev` is detached), the same probe against `https://app.claxedo.dev`, run 10 minutes after deploy run 39349027406 finished at 01:09 UTC and with no deploy during it (01:20–01:47 UTC, `staging-gaps-one-origin-2026-10-20.tsv`), lands cold on **66 of 126** answers against 25 of 126 on the direct path, matching the 63 of 126 measured at 23:38–00:05 the night before. The `compose`-without-`cold` count is 4 of 126 (24 before the `waitUntil` change).

| idle gap | n | cold (direct path) | fresh warm | fresh cold | reused warm | reused cold |
|---|---|---|---|---|---|---|
| 0 s | 36 | 15 (2) | 0.673 | 1.288 | 0.379 | 0.922 |
| 1 s | 24 | 5 (1) | 0.668 | 1.466 | 0.418 | 0.954 |
| 5 s | 24 | 11 (4) | 0.642 | 1.183 | 0.380 | 0.963 |
| 30 s | 24 | 20 (12) | 0.756 | 1.345 | 0.470 | 1.004 |
| 120 s | 18 | 15 (6) | 0.705 | 1.401 | 0.373 | 1.043 |

Medians: warm reused 0.396 (direct 0.369), warm fresh 0.667 (0.632), cold reused 0.967 (0.851), cold fresh 1.293 (1.139). `cf-placement: remote-IAD` now arrives on every answer; every `cf-ray` is SIN.

**What the two tails say.** `wrangler tail --format json` on both Workers during the probe, 126 invocations each, zipped with the probe's rows per path in time order:

| state | TTFB | app Worker wall / CPU | control plane wall / CPU | TTFB − app wall | app wall − cp wall | cp arrival − app start |
|---|---|---|---|---|---|---|
| warm, reused connection (n=24) | 396 | 254 / 0 | 2 / 2 | 133 | 248 | 131 |
| warm, fresh (n=32) | 667 | 250 / 0 | 2 / 1 | 412 | 247 | 133 |
| cold, reused (n=36) | 967 | 791 / 0 | 245 / 82 | 154 | 592 | 130 |
| cold, fresh (n=30) | 1,293 | 755 / 0 | 284 / 93 | 448 | 602 | 141 |

The app Worker's own start is not in the numbers: its CPU is 0–2 ms on all 126 invocations and the time outside it (TTFB − app wall) is 133 ms warm against 154 cold on a reused connection, the client's round trip to SIN plus 21 ms. The binding hop is 248 ms on a warm call (the app waits 254 ms for a 2 ms control-plane invocation; the control plane's invocation timestamp follows the app's by 131 ms, one way). A cold call keeps the same 130 ms one-way arrival but the app waits 592–602 ms over the control plane's invocation: about 300 ms of isolate start between the request's arrival at the IAD machine and the invocation's wall clock, then 245–284 ms of invocation holding the first composition (82–114 ms CPU, 87–233 across the 21 cold `descriptor` answers). So one cold answer on this path is 0.13 client ↔ SIN + 0.25 hop + ~0.3 isolate start + ~0.25 first invocation; the app Worker contributes nothing measurable, and the control plane's cold cost per occurrence is what it was (0.48–0.51 s over warm, now 0.57–0.63 with the hop's share of the slower cold invocation).

**Why it happens more often.** `stickiness.sh` sent twelve `descriptor` requests on one client connection (one SIN machine, `cf-ray …f8e2`, one app Worker isolate) one after another: the first five were `cold` on five different isolates, the next six warm, the twelfth cold again; `/health` on one connection: cold, warm, cold, warm ×4, cold, warm ×3, cold. Twelve fresh connections back to back: 6 of 12 cold for `descriptor`, 4 of 12 for `/health`. On the direct path the same pace met 2 cold in 36 at no gap and 16 of 18 consecutive pairs warm → warm. So a service-binding call into the region-placed control plane is forwarded to an IAD machine chosen anew for every call, with no affinity to the caller's previous call or connection, while the edge's own forwarding of a client's request to the placed Worker kept such affinity. The docs say where a bound Worker runs by default ("both Workers run on the same thread of the same Cloudflare server") and that placement applies to the callee ("Enable placement on your back-end Worker to invoke it close to your database"; "Placement only affects the execution of fetch event handlers", [placement](https://developers.cloudflare.com/workers/configuration/placement/); "when you enable Smart Placement, each Worker runs in the optimal location", [service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)); how the machine is chosen per call is not documented, and the per-call spread above is observed, not read. Time of day and version churn are ruled out by the quiet repeat (one version, ten idle minutes, same count); the app Worker's own start by its 0–2 ms CPU and the unchanged time outside it.

**Options.**

1. **Routes on the control plane under the app's hostname** (recommended). `[[routes]]` on the control plane's Wrangler config for each path `public-origin.ts` names — `app.claxedo.dev/api/*`, `/internal/*`, `/.well-known/*`, `/bindings/*`, `/health`, `/global/health`, `/path` — with the zone, while the app Worker keeps the custom domain for the shell, the assets and `/relay/*`. Routes "take precedence if configured on the same hostname" over a custom domain and "the most specific route pattern wins" ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)); a Worker on a custom domain "is treated as an origin" the route's Worker may call, and the control plane never does ([custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)). The browser's `/api` requests then take the edge's direct forwarding to the placed Worker, the path the first table measured: expected cold rate about 20% (25 of 126), warm reused 0.37, cold 0.85 / 1.14, on the same origin, with no CORS and the cookie host unchanged. Costs: the deploy token needs the zone's Workers Routes permission (a `zone_name` route "will require the Account scope", [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)); the `CONTROL_PLANE` binding and the app Worker's control-plane branch become unreachable and go, with `app-worker.test.ts` following; the e2e front (`packages/claxedo-app/e2e/harness/hosted-app-front.ts`) proxies for itself and is untouched. A route cannot be proven under Miniflare; `wrangler deploy --dry-run` validates the config and the first staging deploy proves it.
2. **Placement on the app Worker too.** With both pinned the binding call runs "on the same thread of the same Cloudflare server", so the control plane's cold rate becomes the app Worker's, presumably the direct path's 20%, but both isolates start cold together and every shell and asset answer the app Worker fetches through `ASSETS` is served "from the location where your Worker runs" ([placement limitations](https://developers.cloudflare.com/workers/configuration/placement/)), the docs warning that with `run_worker_first` "the entire Worker script is placed as a single unit" ([static assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)): about 0.25 s onto every document and uncached asset from India. Not recommended.
3. **RPC or a named entrypoint instead of `fetch` over the binding.** Placement "does not affect RPC methods or named entrypoints", so the control plane would run beside the app Worker in SIN and every signed request's 4–7 serial D1 rounds would cross to ENAM at 0.23 s each. Not an option.
4. **A `fetch()` from the app Worker to a reattached custom domain of the control plane** ("Custom Domains can also be invoked within the same zone via fetch()"). Takes the edge's forwarding and its affinity, at the price of a second edge pass per request and a second hostname to keep. Routes do the same with one Worker invocation.

Option 1 is implemented on `perf/cp-route`: `controlPlaneRoutePatterns` in `scripts/deploy/public-origin.ts` turns the one path list into the control plane's `routes` (`<host>/api/*`, `/internal/*`, `/.well-known/*`, `/bindings/*`, `/health*`, `/global/health*`, `/path*`; the three former exact paths carry a wildcard because route matching "considers the entire request URL, including the query parameter string" and a pattern "may not contain any query parameters", so `/path?directory=…` matches only `/path*`), rendered as simple routes whose zone Wrangler resolves from the hostname as `--domain` already does; the app Worker keeps the custom domain, the assets and `/relay/*`, loses the `CONTROL_PLANE` binding, and answers a control-plane path that still reaches it with 503 `deployment_candidate_unavailable`, the deploy-window code the clients retry. What to read after it deploys: the same probe against `https://app.claxedo.dev` should return to the first table's cold counts (2 / 1 / 4 / 12 / 6 by gap) and medians, `cf-placement` absent again except by chance, and the app Worker's tail should show no `/api` invocations at all.
