# Cloudflare Relay Evaluation

Status: Cloudflare Worker/Durable Object relay should not be used for the
Daytona cloud-workspace relay path. Keep it only as a bounded option for
Cloudflare-sandbox targets unless a later product requirement specifically needs
that pairing.

## Decision

Use Fly/Bun relay for Daytona cloud workspaces.

Do not continue the Cloudflare relay to Daytona path for production. It can pass
some HTTP rows and modest WebSocket rows, but it repeatedly fails the real
streaming shapes that Fly/Bun passes. The failure is not central auth, runtime
access token verification, target lookup, relay host token minting, or relay
queueing. It is the Cloudflare relay's outbound upstream WebSocket admission and
cross-provider path to Daytona preview/proxy endpoints.

## What Was Tested

All meaningful rows used real relay deployments and real sandbox targets. Local
or self-hosted controls were used only to validate the harness.

- Cloudflare relay -> Daytona sandbox.
- Cloudflare relay -> Cloudflare sandbox.
- Fly relay -> Cloudflare sandbox.
- Fly relay -> Daytona sandbox for comparison.
- Direct raw WebSocket upgrade probes against the same target runtime whenever
  relayed WebSocket setup failed.
- Durable Object WebSocket trace fields for upstream-open, queued frames, queue
  delay, and established-message RTT.
- Bounded WebSocket opener caps, including `16`, `4`, and `64`.
- Active load shapes from small smoke through c200/load600 and c140/load1000
  match attempts.

## Cloudflare Hibernation

The user-hosted incoming WebSocket path already uses Durable Object hibernation:
`acceptWebSocket`, attachments, and `getWebSockets` are present in
`packages/workspace-relay/src/cloudflare.ts`.

That API does not solve the cloud relay bridge case. The bridge still needs a
live outbound WebSocket from the Durable Object to the runtime. Cloudflare
hibernates inbound client sockets, not arbitrary outbound upstream sockets. For
the cloud-workspace path, the failing layer is that outbound upstream open and
provider/proxy admission path.

## Fixes And Variants Tried

### 1. Cloudflare sandbox WebSocket endpoint fix

Early Cloudflare-sandbox rows failed because the target endpoint could not accept
WebSocket upgrades. The direct raw upgrade returned Cloudflare Worker exceptions
or TLS failures through preview URLs.

Changes made:

- Added/fixed the Cloudflare sandbox `/proxy` WebSocket upgrade path.
- Kept preview `exposePort` as a probe, but fell back to `/proxy` when preview
  TLS was unusable.
- Added direct raw WebSocket upgrade artifacts to distinguish target failure
  from relay failure.

Result:

- Cloudflare sandbox targets became WebSocket-capable through `/proxy`.
- Fly relay -> Cloudflare sandbox passed bounded rows.
- Cloudflare relay -> Cloudflare sandbox passed bounded rows.

### 2. Cloudflare relay smoke to Daytona

The Cloudflare relay deployed, authenticated, forwarded HTTP, and bridged modest
WebSocket traffic to Daytona in smoke rows.

Representative result:

| Row | Result |
| --- | --- |
| `dtn-cf-smoke-20260621235125` | Failed smoke: HTTP p99 overhead `173.18ms`; WS-message p99 overhead `126.23ms`. |
| `dtn-cf-trace-015154` | Failed with zero sample failures: load `1` HTTP overhead `528.9ms`, WS `122.92ms`; load `10` HTTP `119.44ms`, WS `141.68ms`. |

Trace read:

- Runtime handler was effectively `0ms`.
- Queue delay was `0ms`.
- HTTP tail came from `relay_upstream_fetch`.
- WS upstream open was roughly `743-778ms`.
- Established WS RTT was roughly `326-348ms` relayed versus `203-206ms` direct.

This pointed away from auth or application work and toward Cloudflare relay
egress to Daytona.

### 3. Bounded opener retries to Daytona

The Cloudflare upstream WebSocket opener was throttled to reduce burst pressure.

Representative result:

| Row | Result |
| --- | --- |
| `dtn-cf-lastchance-sin-131732` | Modest WS survived: `40/40` messages at c1/c10/c50/c70, WS p99 overhead `38-65ms`; still failed HTTP at c1 with `487.09ms` p99 overhead and multi-second upstream-open tails. |
| `dtn-cf-highload-sin-132145` | Failed at c100/c200/c400/c600: relayed WS messages `0/80` at every level. Upstream upgrade returned `429`, then `503`/timeouts at higher levels. |

Direct raw Daytona WebSocket upgrade returned `101 Switching Protocols` in these
runs, so the target runtime was alive.

### 4. Match against the passing Fly c200/load600 shape

The key comparison was to run Cloudflare relay with the same real Daytona target
class and the same high-load shape that Fly/Bun passed.

Representative result:

| Row | Shape | Result |
| --- | --- | --- |
| `dtn-cf-ratcache-match-c200-sin-1` | c200/load600, Fly `sin`, `800` WS messages | HTTP p99 overhead passed at `+0.63ms`, but relayed WS messages were `0/800`; direct WS was `800/800`; relayed WS connect p95 was `7334.86ms`; upstream upgrade failed with `429`. |
| `dtn-cf-match-q64-c200-sin` | Same shape with Cloudflare upstream-open cap `64` | HTTP p99 overhead passed at `-214.89ms`, but relayed WS messages were again `0/800`; direct WS was `800/800`; every relayed message failed with upstream upgrade `429`. |
| `dtn-cf-decision-161736` | Shared decision profile: c200/load600, Fly `sin`, cap `64` | Holder setup was `0/600`; warm app and established WS comparison could not run; direct raw Daytona upgrade returned `101`. |

Read:

The `q64` attempt improved connect timing compared with earlier rows, but it did
not restore established relayed messages. This is the strongest evidence that
Cloudflare relay to Daytona fails on upstream WebSocket admission, not simply on
an overly conservative opener limit.

### 5. Match against the passing Fly c1000 proof shape

After Fly/Bun survived a c140/load1000 stress row, Cloudflare relay was retried
against the same shape.

Representative result:

| Row | Shape | Result |
| --- | --- | --- |
| `dtn-cf-match-fly-c1000-sin-16345` | c140/load1000, Fly `sin`, cap `64` | Holder setup was `0/1000`; direct raw Daytona upgrade returned `101`. |
| `dtn-cf-rematch-fly-c1000-sin-165` | Same c1000 shape, focused on relayed p95 viability | Holder setup was again `0/1000`; no p95 comparison could run; direct raw Daytona upgrade returned `101`. |

Read:

Cloudflare relay could not even establish the held sockets required to measure
latency at the shape Fly/Bun handled.

### 6. Cloudflare relay -> Cloudflare sandbox

After the Cloudflare sandbox `/proxy` WebSocket fix, this path became viable for
bounded loads.

Representative result:

| Row | Result |
| --- | --- |
| `cf-cf-bounded-wsfix-004656` | Passed load `1`, `10`, and `50`: HTTP p99 overhead `-55.49ms`, `-5.77ms`, `41.81ms`; WS p99 overhead `-28.46ms`, `-11.25ms`, `-4.25ms`; zero WS failures. |
| `cf-cf-trace-015444` | Passed traced smoke: load `1` HTTP p99 overhead `6.58ms`, WS `-19.38ms`; load `10` HTTP `27.68ms`, WS `3.97ms`. Queue delay stayed `0ms`. |

Later threshold rows were mixed but the latest clean rows passed through held
load `200`. This suggests the Cloudflare relay is usable when the runtime target
is also Cloudflare, but that is a different architecture from Daytona cloud
workspaces.

### 7. Fly relay -> Cloudflare sandbox

This path was used to prove that Cloudflare sandbox targets can work when the
relay is not Cloudflare.

Representative result:

| Row | Result |
| --- | --- |
| `cf-fly-bounded-wsfix-004228` | Passed load `1`, `10`, and `50`: HTTP p99 overhead `-28.65ms`, `-86.35ms`, `5.12ms`; WS p99 overhead `33.42ms`, `-10.5ms`, `-12.53ms`; raw direct upgrade returned `101`. |
| `cf-fly-loadcurve-100-500-010238` | Passed through held load `500` with mostly clean WS and HTTP p99 overhead under `36ms`; one WS message failure at load `250`. |
| `cf-fly-directproof-222051` | Real Cloudflare sandbox + temporary Fly/Bun relay + Fly `sin` loadgen. c32 passed with warm-app p99 overhead `-85ms` and WS-message p99 overhead `-12.76ms`; c48 HTTP missed with `+163.13ms` while WS-message passed. Relay-local c48 warm-app work stayed tiny: auth/lookup/cache/queue under `2ms`; the miss was client/edge/upstream residual. |
| `cf-fly-directproof-c48-m2-222435` | Retried c48 with `2x2048MB` Fly relay machines. Still failed: warm-app p99 overhead `+148.02ms`, WS-message p99 overhead `+1648.13ms`, zero sample failures. Relay-local warm-app overhead was `0.85ms`; increasing Fly relay capacity did not remove the Cloudflare sandbox path tail. |
| `central-fly-temp-override-223556` / `central-fly-temp-c48-repeat-2246` | Real staging central -> temporary Fly/Bun relay -> Cloudflare sandbox with Fly `sin` loadgen and per-workspace temporary direct/relay trust. First c32/c48 run passed c32 and c48 warm-app but missed c48 WS-message by `2.64ms` over the 100ms gate; focused c48 repeat passed with warm-app p99 overhead `-638.35ms` and WS-message p99 overhead `-16.55ms`. Relay-local auth/resolver/revocation/RHT/queue work stayed under `2ms`; remaining tails are provider/network/upstream variance, not relay-local logic. |
| `central-fly-temp-c64-c96-225543` | Same real staging central path above c48. c64 warm-app passed with p99 overhead `+72.91ms`, but c64 WS-message failed at `+276.76ms`; c96 warm-app and WS-message both passed. All samples succeeded. Relay-local auth/control/queue remained tiny; c64 WS-message relayed `ws_upstream_open` p99 was `691.72ms`, so the tail is intermittent WS/provider/upstream behavior. |
| `central-fly-temp-c64-m3-230215` | Same c64 row with `3x2048MB` Fly relay machines. Warm-app passed at `+56.02ms`, but WS-message still failed at `+220.61ms`. New WS runtime attribution showed relayed WS-message runtime handler p99 `0.04ms` and queue delay `0ms`; extra Fly relay capacity alone does not remove the Cloudflare sandbox WS RTT tail. |
| `central-fly-temp-c64-m3-ws100-23` | Same c64 row with `3x2048MB` Fly relay machines and `100` WS-message samples. Passed: warm-app p99 overhead `+15.34ms`, WS-message p99 overhead `-215.5ms`, direct/relayed WS-message p95 `223.43ms/223.81ms`, relayed runtime handler p99 `0.05ms`, queue delay `0ms`. This is stronger evidence than the prior 16-sample c64 failures and argues against a linear Fly relay overhead curve. |

Read:

Cloudflare sandbox WebSocket support was not the general blocker after the proxy
fix. Fly relay -> Cloudflare sandbox can work at bounded and medium load, but
fresh c48 direct-vs-relayed rows still show non-relay-local provider/network
tails. The decisive production blocker remains the Cloudflare relay to Daytona
cross-provider path, where relayed WebSocket admission fails outright under the
same high-load shapes that Fly/Bun handles.

## Why Cloudflare Relay Failed For Daytona

The repeated pattern was:

- Direct raw Daytona WebSocket upgrade returned `101`.
- Direct WS message batches succeeded, often `800/800`.
- Relayed HTTP sometimes passed, proving auth and basic target resolution worked.
- Relayed WebSocket holder or message setup failed under real load.
- Failures were upstream upgrade `429`, `503`, timeout, or plain holder open
  failure.
- Trace showed queue delay `0ms`, so messages were not sitting inside our relay.
- Runtime handler timing was near zero, so the target app code was not the tail.
- Auth/cache phases were hot or negligible in later runs.

That combination isolates the issue to Cloudflare relay outbound upstream
WebSocket open/admission to Daytona.

## Comparison To Fly/Bun Relay

The passing Fly/Bun row used the same Daytona class and the aggressive decision
shape:

| Row | Shape | Result |
| --- | --- | --- |
| `dtn-fly-ratcache-c200-m3-q64-sin` | c200/load600, three `2048MB` Fly relay machines, RAT cache, q64 direct HTTP | PASS: warm-app p99 overhead `47.15ms`; WS-message p99 overhead `11.9ms`; relayed WS `800/800`; relay-local p99 about `1.18ms`. |
| `dtn-fly-c1000-rht-coalesce-sin-1` | c140/load1000 | PASS: relayed WS `64/64`; relay-local p99 `5.35ms`; WS p95/p99 overhead `5.03ms`/`3.75ms`. |

Fly/Bun is not magic; earlier Fly rows had high HTTP tails until RAT cache,
target cache, RHT coalescing, direct HTTP admission, and extra relay machines
were applied. But after those fixes, Fly passed the Daytona WebSocket shapes.
Cloudflare relay did not.

## Final Recommendation

Ship the Daytona cloud-workspace relay on Fly/Bun.

Do not spend more time trying to make Cloudflare Worker/Durable Object relay
serve the Daytona cloud-workspace WebSocket bridge unless one of these changes:

- Daytona exposes a different WS endpoint that Cloudflare can open under c200+
  admission.
- Cloudflare adds a bridge primitive that changes outbound upstream WebSocket
  behavior for Durable Objects.
- The product requirement changes to Cloudflare-sandbox targets only.

Keep the Cloudflare relay code paths only where they are already useful:

- user-hosted incoming WebSockets with DO hibernation;
- Cloudflare relay -> Cloudflare sandbox bounded experiments;
- test coverage for auth, tracing, and target resolution behavior.

## Restoration note (2026-07-17)

This document was originally captured in commit `5122db56ff` (2026-06-27) and
dropped from the tree during the repository trim. Restored verbatim on
2026-07-17 because it settled a live architecture question: hosted compute
placement (Node-on-Fly vs Cloudflare Workers) for the control plane and the
WorkGraph live-sync doorbell (`docs/plans/2026-07-17-004-workgraph-live-sync-redesign.md`).
The empirical line it draws: Cloudflare DOs are viable for INBOUND connection
holding (hibernated client sockets — e.g. a future doorbell connection edge at
very high concurrency), and demonstrated non-viable for OUTBOUND cross-provider
WebSocket bridging (the Daytona relay path, which ships on Fly/Bun).

## Mechanism identified (2026-07-17)

The measured failure now has a documented platform mechanism. Cloudflare's
Workers limits state that each invocation may have at most **six connections
simultaneously waiting for response headers**, that **outbound WebSocket
connections count** against this, and that a seventh attempt **is queued**
until a slot frees (developers.cloudflare.com/workers/platform/limits,
"Simultaneous open connections"). A WebSocket handshake is precisely a
connection waiting for headers (the `101`).

Arithmetic against the rows above: Daytona handshakes measured ~743–778ms, so
c200 opens through a 6-wide handshake window ≈ 25s of queued handshakes —
matching the observed relayed WS connect p95 of `7334.86ms`, the multi-second
upstream-open tails, and holder setup `0/600`–`0/1000` (timeouts before the
queue drained). It also explains why opener caps of 16/4/64 changed nothing
(the platform caps in-flight handshakes at 6 beneath any client-side cap), and
is consistent with the `429`s: queued handshakes release in bursts from shared
Cloudflare egress IPs, which the provider's admission layer reads as one
abusive client — while direct probes from distinct IPs at natural pacing got
`101`. CF→CF passed because intra-network handshakes return headers in
milliseconds, so the same 6-slot window drains ~100× faster and never backs up
at bounded load.

Implication unchanged, now with a mechanism: outbound cross-provider WS
bridging from Workers/DOs is structurally admission-limited — not fixable on
our side. Inbound-only DO usage (hibernated client sockets; at most one
outbound subscription per DO) does not engage this limit.
