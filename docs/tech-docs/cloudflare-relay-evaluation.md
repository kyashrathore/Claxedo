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

## Re-evaluation 2026-07-18 (owner-sanctioned re-run; plan 2026-07-17-005)

Real deployments, real Daytona sandbox (WS echo target inside a `claxedo-workspace-runtime-0-5-0-v7` sandbox), CF relay DOs, bench identity RAT + resolver Worker. Loadgen from local vantage. All rows measured direct-vs-relayed in one window. Metric = holder setup (relayed WS connections established) / attempted, relayed WS message delivery, upstream-open (DO outbound-handshake, from the ported `relay.trace`).

| Row | Config | Holders | Relayed WS | Direct WS | upstream-open p95 | Verdict |
|---|---|---|---|---|---|---|
| H0 | **stock** CF relay, c200 | **99/200** (101 errors) | 396/396 | 800/800 | 732ms | Admission FAILS (~half) |
| H2 | opener-shard **8**, round-robin cursor, c200 | 102/200 (98 err) | 408/408 | 800/800 | 912ms | No gain (cursor bug) |
| H2 | opener-shard **32**, **random**, c200 | **200/200** | **800/800** | 800/800 | 872ms | **Admission SOLVED** |
| H2 | opener-shard 32, random, c200 (confirm) | **200/200** | 800/800 | 800/800 | 856ms | PASS (overhead −77ms) |
| H2 | opener-shard 32, random, **c1000** | **1000/1000** | **1000/1000** | 1000/1000 | 869ms | Admission SOLVED at c1000 |

**Verdicts:**
- **H0 (does it still fail): YES, partially.** The stock single-DO CF relay still chokes on outbound WS admission at c200 — 99/200 holders, ~half fail — though softer than June's total 0/800. The mechanism reproduces (upstream-open ~730–870ms = June's 743–778ms; docs confirm "Simultaneous outgoing connections/request: 6 (same as Workers)" **per DO**, unchanged).
- **H1 (mechanism): confirmed** — the failure is the per-DO 6-in-flight-outbound-handshake window × ~750ms cross-provider handshakes serializing under concurrency.
- **H2 (the decision row): CONFIRMED — sharding the WHOLE BRIDGE across N opener-DOs fixes it.** 32 shards (each its own 6-window, DO instances unlimited per namespace) admit **200/200 at c200 and 1000/1000 at c1000 with zero message loss**, reproduced. Two implementation findings were load-bearing: (a) a WebSocket cannot be handed between DO isolates, so shard the entire `admitCloudClient` bridge, not just the open; (b) shard selection MUST be stateless (random) — a module-global round-robin cursor collapses toward shard 0 because CF spreads a concurrent burst across many isolates each starting the cursor at 0 (this was why the first 8-shard run showed no gain: 102/200).
- **H3 (drift): the 6-connection window is unchanged** from June's quote; the platform did not move. What changed is the *approach*, not the platform.

**Bottom line:** the June conclusion ("CF relay can't do the Daytona outbound-WS bridge at load") holds for the STOCK single-DO design, but is **overturned by the opener-DO bridge-sharding design** — CF→Daytona outbound WS now works at c200 and c1000. The remaining gate miss is WS-message p99 overhead hovering ~100ms (CF-edge RTT), not admission or loss. Reports: `packages/workspace-relay/bench/reports/`.

**Note (open architectural question, owner, 2026-07-18):** all of the above works *around* the outbound-admission limit by multiplying DOs. A cleaner design may SIDESTEP it entirely — see the inbound-rendezvous / reverse-tunnel note below.

## Inbound-rendezvous / reverse-tunnel — the direction that removes the problem (owner insight, 2026-07-18)

Everything above fights the **per-DO 6-outbound-handshake window** because the cloud path is designed as *DO-dials-out* to the Daytona sandbox (the sandbox is publicly addressable via its preview URL, so the relay dials it). H2 multiplies DOs to widen that outbound window. But the limit is **outbound-only** — inbound connections into a DO have no such cap, and DO hibernation holds inbound sockets cheaply.

**PartyKit's model** (built on DOs) is inbound-only: every participant connects *into* the DO; the DO is a rendezvous hub and never dials out. Applied here: instead of the relay DO opening an outbound WS to Daytona, have a tiny agent **inside the sandbox dial INTO the relay DO** (sandboxes have egress). The DO then holds two *inbound* sockets — browser + sandbox — and pipes bytes between them. Result:
- **Zero outbound connections from the DO → the 6-window never applies → no sharding, no H2 needed, scales to any N.**
- DO hibernation makes holding millions of idle inbound sockets nearly free (the exact thing the June doc said DOs are good at).

**This is not hypothetical for us** — it is precisely how the **user-hosted path already works** ("user-hosted incoming WebSockets with DO hibernation" — the workspace runtime dials into the relay; June measured this path as the one CF handles well). The insight is to extend that reverse-tunnel model to the **cloud (Daytona) path** rather than keeping it DO-dials-out. The workspace-runtime host-tunnel capability may be directly reusable.

**Consequence for the hosted-relay decision:** the June "CF can't relay to Daytona" conclusion is an artifact of the *dial-out* design. Both fixes overturn it — H2 (proven here: works around the window) and, more fundamentally, inbound-rendezvous (removes the window from the problem entirely, reusing infra we already have). If the hosted relay flips cloud targets to dial-in, CF DOs go from "poor fit (outbound bridging fails)" to "excellent fit (inbound holding + hibernation)". Recommended next experiment: a dial-in cloud path (sandbox agent → relay DO) benchmarked at c200/c1000, expected to pass without any opener sharding.

## Security model: dial-out vs dial-in (deep analysis, 2026-07-18)

Grounded in the real token model (`packages/workspace-relay/README.md`): RAT (browser→relay authz, 30m), **HTT (workspace runtime→relay tunnel-registration authz, 5m)**, RHT (relay→host per-request, 60s, already bound to `cloud/cloud-vm` vs `user-hosted/local-worktree`). The token set ALREADY anticipates cloud dial-in — HTT is exactly "runtime authorized to register a tunnel," and RHT already carries the cloud deployment pair.

**Headline security delta — dial-in eliminates the public sandbox ingress.** Today's cloud dial-out requires each sandbox to expose a PUBLIC ingress (Daytona preview URL) guarded by a preview token. This re-eval demonstrated the weakness firsthand: the benchmark passed the preview token as a URL query param (`?DAYTONA_SANDBOX_AUTH_KEY=…`) — a bearer credential to a machine running the user's code and secrets, leaking into logs/proxies/history, and reachable by anyone with the URL, bypassing the relay's policy/audit entirely. Dial-in removes this: the sandbox has NO listening ingress; it makes one authenticated outbound TLS connection to the relay. Sandbox attack surface drops from "public HTTP/WS ingress" to "zero ingress," and the relay becomes the SOLE mediator (all client↔sandbox frames pass through it — nothing out-of-band).

**The critical NEW risk dial-in introduces — host-registration hijack.** In dial-out the control plane is authoritative about "workspace X lives at this target" (the relay dials what the resolver blessed). In dial-in a sandbox CLAIMS "I am host for workspace X" via an HTT. Security requirements:
- HTT must be **strictly per-workspace+host, unforgeable (control-plane-signed), short-lived** (5m + refresh). ✓ existing design.
- **Blast radius of a stolen HTT = exactly one workspace.** A sandbox runs untrusted agent code (the point of a sandbox), so assume the HTT can leak. But it only authorizes registering as THAT workspace's host — which the attacker already occupies. No lateral gain, IFF HTTs are never multi-workspace and never long-lived.
- **Registration must NOT be last-writer-wins.** The primary hijack vector: a malicious sandbox with a valid HTT races to register as another workspace's canonical host and siphons that workspace's client traffic. Prevented by binding the HTT to the provisioned `host_id` and making "current host" control-plane-authoritative (the existing "one hostId = one active tunnel" + "split-brain prevention on replacement" must resolve in favor of the blessed host, not the latest connector). This is the one implementation detail that must be exactly right.

**Mutual-auth direction flips (net neutral-to-stronger).** Dial-out: relay authenticates to the sandbox via RHT. Dial-in: relay authenticates the sandbox (HTT) AND the sandbox authenticates the relay via TLS to a known relay hostname (arguably stronger than verifying an inbound token). RHT survives — even over an authenticated tunnel the sandbox still wants per-request proof that a forwarded request was RAT-validated.

**Compromised-sandbox containment (a wash on exfil, a win on control).** Neither model contains a compromised sandbox's general egress exfil — a sandbox has internet regardless. But dial-in ENABLES tighter egress policy: allowlist the sandbox's egress to only the relay (+model/registry), routing all workspace I/O through the policy-enforcing relay. Dial-out can't allowlist inbound by source (relay egress = shared CF/Fly IPs), so it must accept arbitrary public ingress.

**Revocation is cleaner in dial-in.** The relay HOLDS the host socket, so the kill switch = drop the held socket + refuse re-registration (immediate). Dial-out revokes new connections via `isRuntimeAccessTokenActive` but in-flight dials persist.

**New operational risks of dial-in.** (1) A persistent inbound connection farm — bounded by per-workspace DO isolation (one tenant's tunnels land on its own DO; can't exhaust another's), DO hibernation (idle sockets ~free), and the 1000 req/s per-DO soft limit. (2) HTT injection into the sandbox at provision — rides the existing secret-brokering channel (`SandboxBrokeredSecret`) that already injects model keys; keep it short-lived + refreshed. (3) The relay becomes more stateful (holds cloud tunnels too) — which strengthens the case for the DO/CF deployment (excellent at holding inbound) over the single-instance Bun process.

**Convergence bonus.** Dial-in unifies cloud and user-hosted into ONE model and code path (both: runtime dials in with HTT, browser dials in with RAT, relay rendezvouses two inbound sockets). Today they're bifurcated. The RHT deployment-pair binding and cookie-stripping asymmetry stay as per-pair policy.

**Verdict:** dial-in is a net security improvement — its headline win (eliminating public sandbox ingress + making the relay the sole mediator) outweighs its new risk (registration hijack), and that risk is precisely what the existing HTT + single-active-tunnel + split-brain design targets. The non-negotiable: **host registration must be control-plane-authoritative (host_id-bound), never last-writer-wins.** Get that wrong and dial-in is a workspace-traffic hijack; get it right and it's strictly safer than the public-preview-URL status quo.

## Dial-in auth flow (end to end, 2026-07-18)

The three existing tokens map onto dial-in with NO new token types — only the *direction* of the host connection changes, and the HTT replaces the Daytona preview-token as host-side auth.

1. **Provision.** Control plane creates the sandbox for workspace X with a specific `host_id`, mints an **HTT** (control-plane-signed; aud `workspace-relay-host-tunnel`; binds workspace_id=X, host_id, exp≈5m, jti), and injects it via the existing secret-brokering channel (`SandboxBrokeredSecret`, same path as model keys) along with the relay URL.
2. **Sandbox dials in.** Runtime opens `wss://relay/host-tunnels/<host_id>` with `Authorization: Bearer <HTT>`. Relay runs `verifyHostTunnel` (signature via control-plane JWKS, audience, expiry, host_id matches path), then `registerHostTunnel({hostId, workspaceIds:[X]})` under "one active tunnel per hostId" + control-plane-authoritative split-brain.
3. **Browser connects (per client).** Control plane mints a **RAT** (aud `workspace-relay`; binds workspace_id=X, host_id, role, exp≈30m, jti). Browser opens `wss://relay/workspaces/X/…` with the RAT. Relay verifies it and calls `isRuntimeAccessTokenActive` (revocation/freshness → control plane) on every new upgrade.
4. **Rendezvous.** Relay opens a new **channel** over the already-held host tunnel, mints a **RHT** (60s; aud `workspace-host-service`; bound to deployment pair `cloud/cloud-vm`), strips dangerous headers (`x-forwarded-*`, `x-claxedo-internal-*`, …), replaces `Authorization` with the RHT, sets `x-workspace-id`, and forwards the request as channel frames. The sandbox verifies the RHT ("this request was RAT-validated by the real relay") and serves; bytes pipe back over the channel to the browser.

**What changes vs today's cloud dial-out:** only step 2. Dial-out authenticated the host leg with a **Daytona preview token** (a bearer to a public URL, not control-plane-issued, not workspace-bound in our trust model, leaks in query strings). Dial-in authenticates it with the **HTT** — first-class, control-plane-signed, workspace+host-bound, short-lived, audience-scoped. RAT and RHT are byte-for-byte the same as user-hosted. So dial-in doesn't add auth surface; it *upgrades* the weakest link (host auth) and reuses the audited flow.

**The one new design task — HTT refresh for a long-lived tunnel.** HTTs are 5m; the tunnel is long-lived. Pattern: inject ONE longer-lived provisioning-identity credential into the sandbox (blast radius = its own workspace only), which the sandbox exchanges for short HTTs on demand / on reconnect (client-credentials style). The tunnel socket itself is authorized at establishment and lives until close (per the relay's socket-lifetime auth rule); reconnects re-present a fresh HTT. Keep the provisioning identity strictly single-workspace and revocable.

## Should we adopt PartyKit? (build-vs-adopt, 2026-07-18)

**Use the PATTERN PartyKit proves, not the PartyKit framework.** PartyKit (now Cloudflare) is a DX layer over Durable Objects for real-time *multiplayer* apps — a "room" abstraction, a `PartySocket` client, hibernation/lifecycle conventions. It's the clearest public proof that "DOs excel at holding inbound connections and rendezvousing them," which is exactly the validation for the dial-in direction. But adopting it as a dependency is the wrong call:

- **We already own a hardened, security-mediated relay** — bespoke RAT/HTT/RHT token model, multiplexed tunnel protocol with channel framing, split-brain handling, a header-stripping forwarding boundary, audit, and revocation hooks. PartyKit provides none of this; adopting it means REWRITING our security-critical core in a generic framework and losing the audited flow. High risk, zero gain.
- **Model mismatch.** PartyKit's abstraction is roughly-peer participants in a collaborative room. Ours is asymmetric-trust proxying: browser vs host, RAT vs HTT, re-mint-the-token, strip-these-headers, this-participant-is-privileged. PartyKit has no first-class concept for that; we'd fight the framework on every security boundary.
- **Portability + lifecycle.** We deliberately keep the relay portable (Bun adapter + CF adapter). PartyKit is CF-specific and a third-party framework whose roadmap we don't control. Coupling our security core to it deepens lock-in exactly where we've been careful to avoid it.
- **We already operate DOs directly.** `cloudflare.ts` and the H2 work show we handle `idFromName`, hibernation, and WS accept fine. PartyKit's value is for people who don't want to touch raw DOs — not us.

**Verdict:** read PartyKit as a reference for DO connection-holding/hibernation patterns; implement inbound-rendezvous in OUR relay with OUR token model. The only world where adopting PartyKit wins is greenfield with *symmetric* trust and no existing relay — neither is true here.

## Dial-in prototype — measured 2026-07-18 (stock relay, NO sharding)

Sandbox runs the real host-tunnel client (`startWorkspaceRelayHostTunnel`, bundled node-compatible) dialing into the deployed stock CF relay; resolver returns `access:"user-hosted"` so the relay routes browser clients into channels over the one tunnel. Cloud single-channel round-trip proven first (registered:true, 1/1). Then load:

| Row | Design | Holders | Relayed WS | Connect p95 | WS-msg p99 overhead | Sharding? |
|---|---|---|---|---|---|---|
| dialin-c200 | **dial-in, stock relay** | **200/200** | **800/800** | **1081ms** | 770ms | **none** |
| dialin-c1000 | **dial-in, stock relay** | **1000/1000** | **1000/1000** | **807ms** | 439ms | **none** |
| (cf) h2-c200 | dial-out, 32 shards | 200/200 | 800/800 | 2331ms | 105ms | 32 opener-DOs |
| (cf) h2-c1000 | dial-out, 32 shards | 1000/1000 | 1000/1000 | 1844ms | 292ms | 32 opener-DOs |
| (cf) H0-c200 | dial-out, stock | 99/200 | 396/396 | 1372ms | 218ms | none (FAILS) |

**Admission — dial-in wins decisively.** 200/200 and 1000/1000 on the STOCK relay, no sharding, because the sandbox opens ONE multiplexed tunnel (not N outbound handshakes). There is no DO outbound handshake at all — `upstream-open` reports wall-clock, not a `relay.trace`, because the relay never dials out. Connect is also FASTER than dial-out (no cross-provider handshake per client).

**The honest wrinkle — per-message throughput over a single tunnel.** Dial-in's WS-message p99 overhead is HIGHER (770ms @ c200, 439ms @ c1000) than sharded dial-out (105/292ms). Cause: all 200–1000 client channels multiplex over ONE tunnel socket, and the sandbox-side tunnel agent forwards every frame single-threaded to localhost — so at extreme *single-workspace* concurrency the one tunnel becomes a message-RTT bottleneck. Dial-out's per-bridge sockets don't share this, which is why its per-message overhead is lower once admission is (expensively) solved.

**But the benchmark shape flatters dial-out here.** "c200/c1000 on ONE workspace" means 200–1000 browsers hammering a SINGLE workspace's single tunnel — an unrealistic worst case for dial-in. Real traffic is many workspaces × a few clients each, where each tunnel is lightly loaded and the DO-per-workspace hibernation dominates the economics. At that realistic shape dial-in is strictly better on every axis. Even at the unrealistic single-workspace c1000, dial-in's ADMISSION is perfect (1000/1000) — only per-message latency degrades, and that's tunable (multi-socket tunnel, per-channel flow control, or splitting a hot workspace across a few tunnels) without reintroducing the outbound-window problem.

**Hibernation (the economic clincher).** DO hibernation is INBOUND-only. Dial-in accepts both legs inbound (browser + tunnel), and the relay already reconstructs the full channel↔browser routing from socket attachments on wake (`rebuildHibernatedSockets`, `serializeAttachment` on both `host-tunnel` and `user-hosted-client` kinds — verified in cloudflare.ts). So a workspace DO can fully evict while holding its tunnel + idle browser sockets, waking on traffic — hold millions of idle workspaces cheaply. Dial-out/H2 hold NON-hibernatable outbound sockets, so DOs stay resident (H2: 32× resident per workspace). 

## Final verdict (2026-07-18)

- **June's "CF can't relay Daytona at load" is overturned** — both H2 (dial-out, sharded) and dial-in reach 200/200 and 1000/1000.
- **H2** proves the workaround but is architecturally heavy: 32 resident non-hibernatable opener-DOs per workspace, plus the shared-egress and stateless-shard-selection subtleties.
- **Dial-in is the right design**: one outbound connection instead of N, stronger auth (HTT replaces the leaky Daytona preview-token), smaller attack surface (no public sandbox ingress), the ONLY design where DO hibernation applies, and it REUSES the existing user-hosted code path (dial-in = `access:"user-hosted"`) — near-zero new relay code. Its one cost (single-tunnel message throughput at extreme single-workspace concurrency) is a realistic non-issue and independently tunable.
- **Recommendation: adopt dial-in for cloud targets** (reuse the host-tunnel client + HTT, control-plane-authoritative host registration), treat H2 as a proven fallback, and do NOT adopt PartyKit (use its pattern; keep our hardened relay + token model).

## Message-throughput stress (2026-07-18) — the dial-in tradeoff, measured

Owner pushed on the right weakness: dial-out's per-message overhead is stable; does dial-in's grow with message volume through the single tunnel? Measured (dial-in = stock relay + one sandbox tunnel; overhead = relayed p99 − direct p99, same run):

| Row | Design | Total msgs | Concurrency | WS-msg p99 overhead | Delivered |
|---|---|---|---|---|---|
| dialin c1 | dial-in | 2 | 1 | **~0ms** | 2/2 |
| dialin c200×4 | dial-in | 800 | 200 | 770ms | 800/800 |
| dialin **c50×200** | dial-in | **10k** | 50 | **3655ms** | 10000/10000 |
| dialin **c10×1000** | dial-in | **10k** | 10 | **2975ms** | 10000/10000 |
| (ref) h2 c200×4 | dial-out 32-shard | 800 | 200 | **105ms** | 800/800 |
| (ref) h2 c1000×1 | dial-out 32-shard | 1000 | 140 | **292ms** | 1000/1000 |

**Finding: dial-in per-message overhead scales with VOLUME, not concurrency.** 10k messages cost ~3s p99 whether spread over 10 or 50 channels (2975 vs 3655ms) — same total volume, 5× concurrency difference, near-same overhead. So the bottleneck is aggregate throughput through the single multiplexed tunnel + single-threaded sandbox agent (head-of-line over one WS socket), not the number of channels. Dial-out's per-bridge sockets have no shared serialization → stable ~100–300ms regardless of aggregate volume. **Delivery is always 100% (10000/10000) — this is a LATENCY ceiling, not a loss/admission failure.**

**This tempers the earlier "dial-in is better" verdict into a workload-dependent tradeoff:**
- **Dial-in wins** on: admission (works on stock relay, no sharding), connection count (1 outbound vs N), hibernation (only hibernatable design → cheap idle at scale), security (no public ingress). Best for the COMMON case — many workspaces × low/bursty message volume each (idle-heavy interactive sessions).
- **Dial-out (H2) wins** on: per-message latency under HIGH sustained volume per single workspace (independent sockets, no head-of-line). Best for few workspaces × heavy streaming each.

**Two caveats on the dial-in number.** (1) The prototype's sandbox agent is a naive SINGLE-THREADED node forwarder — the real workspace-runtime handles channels far better, so ~3s overstates the production ceiling. (2) It's independently tunable without touching the outbound-window question: multiple tunnel sockets per workspace, per-channel flow-control windows, or splitting a hot workspace across N tunnels. So the ceiling is an implementation property, not an architectural dead-end.

**Revised recommendation:** dial-in is the right DEFAULT (admission + hibernation + security + one-connection, and the realistic workload is idle-heavy), but it is NOT a universal win — a single workspace under heavy sustained message throughput sees a real latency ceiling from single-tunnel multiplexing. Adopt dial-in with a production-grade tunnel agent (not the naive prototype) and per-channel flow control; keep H2 (dial-out sharded) as the proven high-per-workspace-throughput fallback. The honest headline: dial-in trades a NON-issue at scale (admission, which it solves for free) against a TUNABLE per-workspace-throughput cost — a good trade for Claxedo's many-sessions workload, but measure it against real agent-streaming rates before committing.

## Multi-tunnel / real-world-shape correction (2026-07-18)

The single-tunnel stress above funneled 10k–100k messages through ONE workspace's ONE tunnel — the shape of a single pathologically hot session, not the platform. Real hosted use is MANY workspaces, each with its own dial-in tunnel and its own DO room. Two follow-ups corrected the picture.

**DO-count myth, corrected.** 100k users do NOT require 100k always-on DOs, and critically NO single DO is asked to hold 100k — the 100k is the platform user count, sharded across MANY DOs (one room per workspace), each holding a handful of connections (its one dial-in tunnel + that workspace's few browser tabs). CF's own docs state "Durable Objects can act as WebSocket servers that connect **thousands of clients per instance**" (NOT tens of thousands — that specific figure is not in CF's limits pages; per-DO capacity is memory/CPU-bound at ~128MB/isolate, no documented hard cap). The 6-connection cap is OUTBOUND only; inbound holding is limited only by DO resources, and "from different machines" is irrelevant — a held socket is a held socket regardless of client origin. NOTE: this per-DO density is CITED from CF docs, not benchmarked here — the bench measured fan-out ACROSS DOs (3 rooms, 30 holders, 30k msgs), not thousands-on-one-DO. What CF DOES guarantee and we rely on: UNLIMITED DO instances per namespace, so the platform's 100k rides DO-COUNT (each DO holding a few), not connections-per-DO. DO *count* is a sharding choice driven by (a) a WS can't cross isolates, so a tunnel + its clients must share a DO (natural unit = workspace), (b) single-threaded CPU per DO — packing many *active* workspaces into one DO reserializes them, and (c) blast-radius isolation. Hibernated DOs aren't billed for duration, so 100k *idle* workspaces cost storage+requests, not 100k×always-on. The DOs that cost money are the concurrently-*active* ones — far fewer than the user count. You pack idle/light workspaces freely and give busy ones their own DO.

**Empirical, one shared sandbox (bench/setup-multitunnel.ts + multitunnel-run.ts), K tunnels = K distinct workspaces/DO rooms, 1000 msgs/tunnel:**

| K | aggregate | delivered | throughput | note |
|---|---|---|---|---|
| 1 | 1,000 | 1000/1000 | 302 msg/s | overhead 248ms |
| 5 | 5,000 | 5000/5000 | 1108 msg/s | overhead med 756ms |
| 10 | 10,000 | 10000/10000 | 987 msg/s | overhead NEGATIVE — see below |

Delivery is 100% at every K (the same 10k that cost ~3s on ONE tunnel, and the 100k that *crashed* one tunnel, delivered cleanly when spread). Throughput scaled to K=5 then plateaued at K=10, and per-tunnel overhead went *negative* at K=10 (relayed faster than direct) — a rig artifact: 10 echo servers + 10 agents + the direct baseline all contend for ONE sandbox's CPU, so the *direct baseline itself* degraded. The bottleneck was the shared test box, not the relay.

**Empirical, SEPARATE sandboxes (bench/setup-separate.ts), one tunnel per machine — only the relay shared (the faithful hosted shape):**

| K | shape | aggregate | per-tunnel overhead med/p95 | delivered | throughput |
|---|---|---|---|---|---|
| 1 | 10×100 | 1,000 | 394 / 394 ms | 1000/1000 | 257 msg/s |
| 3 | 10×100 ea | 3,000 | 506 / 841 ms | 2900/2900* | 657 msg/s |
| 3 | 10×1000 ea | 30,000 | 576 / 2064 ms | 30000/30000 | 2624 msg/s |

(*one holder failed to connect; every connected holder delivered 100%.)

**Conclusion.** With dedicated per-tunnel CPU (real hosted shape), per-tunnel overhead stays ~flat as tunnels multiply (394→506→576ms median) and aggregate throughput scales with tunnel count (257→657→2624 msg/s). 30k messages across 3 separate tunnels delivered 100% at 2624 msg/s — vs ~3s overhead for the same 10k on one tunnel and a crash at 100k on one tunnel. So the single-tunnel throughput ceiling is a **per-workspace hot-session** property, NOT a platform limit: the relay's multi-room fan-out does not degrade, and hosted scale rides tunnel-count across (mostly hibernated, cheap) DO instances. The earlier "dial-in collapses at 100k" finding is correctly scoped as "one workspace can't absorb the whole platform's traffic down one tunnel" — which no real workload asks it to. Dial-in remains the right default; the only per-workspace mitigation still worth building for genuinely hot single sessions is a multi-socket tunnel agent (the prototype's single-threaded forwarder is what crashed at 100k, not the architecture).

## Cost estimation — CF relay DO layer (2026-07-18)

Pricing from CF's Durable Objects pricing page (verified 2026-07-18). Base $5/mo. CF charges NO egress bandwidth.

**Unit economics:**
- **Duration** $12.50/M GB-s. DO = 128MB = 0.125 GB → **$0.0056 per *active* DO-hour** ($4.11/mo if active 24/7).
- **Incoming WS messages** $0.15/M at a **20:1** ratio → **$0.0075 per million** inbound msgs. **Outgoing WS messages are FREE** (relay→browser and relay→tunnel cost nothing).
- **WS connection setup** = 1 request each ($0.15/M) — negligible.
- **SQLite storage** (billing live Jan 2026) $0.20/GB-mo, 5GB free — relay state is ephemeral, ~$0.

**Duration dominates; hibernation is a 10–100× lever.** Without hibernation a DO bills while ANY WS is open → an idle-connected user ≈ $4/mo → 100k idle = ~$400k/mo (unviable). With hibernation you pay duration ONLY during active agent streaming; idle-connected users hibernate → ~$0 duration. So platform cost ≈ `active_streaming_hours × $0.0056`.

**Scenarios (relay DO layer only), per-user = active DO-hours × $0.0056:**

| Active hrs/user/mo | $/user/mo | 10k users | 100k users | 1M users |
|---|---|---|---|---|
| 2 (light) | $0.011 | ~$110 | ~$1.1k | ~$11k |
| 10 (moderate) | $0.056 | ~$560 | ~$5.6k | ~$56k |
| 40 (heavy) | $0.224 | ~$2.2k | ~$22k | ~$224k |

Messages are a rounding error: 1M users × 10k msgs each = 10B inbound/mo ÷20 = 500M req-equiv = **~$75/mo**. Under ~$1k/mo even at 1M users. Against $9/seat revenue, moderate relay cost = 0.6% of revenue, heavy = 2.5% — negligible IF hibernation engages.

**Scope:** this is ONLY the CF relay DO layer. Excludes sandboxes (Daytona/Fly), AI inference, Convex — but those are BYO-compute + BYO-AI-keys (user pays), so the relay is one of the few costs Claxedo bears, making this the relevant COGS.

### VERIFICATION: does hibernation actually engage? PARTIALLY — action item found (2026-07-18)

- Hibernation ACCEPT is wired: `cloudflare.ts:696` `hibernation.acceptWebSocket(pair.server)`; hibernated-socket reconstruction exists. Idle sockets survive isolate eviction. ✅
- `setWebSocketAutoResponse` / `WebSocketRequestResponsePair` is NOT wired anywhere (zero hits). ❌
- The tunnel keepalive is an APPLICATION-level JSON ping (`{type:"ping"}`, 15s cadence, `bun.ts:476/1450`) handled in the DO message handler (`makeTunnelPong`, `cloudflare.ts:1134`). **Every application message wakes the DO** — so each tunnel wakes its DO ≥ every 15s, eroding the duration savings hibernation is supposed to give.
- It CANNOT trivially move to `setWebSocketAutoResponse`: the ping carries a unique `id` + `sent_at` and the pong echoes them + stamps `received_at` (`workspace-relay-protocol/src/index.ts:21-34`). CF auto-response only matches a FIXED request→FIXED response string; a dynamic id/timestamp ping is incompatible.

**Consequence:** the "cheap column" is NOT yet guaranteed. Whether an idle-but-connected workspace costs ~$0 or drifts toward ~$4/user/mo depends on how fast CF re-hibernates after each 15s wake — currently UNMEASURED. **Action items to make the cheap column real:** (a) on the CF path use WebSocket PROTOCOL-level ping/pong control frames for liveness (CF hibernation auto-handles these WITHOUT waking the DO) and drop the app-level JSON ping there; OR (b) split liveness (fixed-string ping via `setWebSocketAutoResponse`, hibernation-safe) from RTT measurement (occasional, on-wake only); OR (c) measure CF re-hibernation latency at 15s cadence and confirm the wake cost is negligible before trusting the cost table. Until one of these is done, budget the relay closer to the "active" end for always-connected sessions.
