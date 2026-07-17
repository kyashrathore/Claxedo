# Cloudflare-relay re-evaluation bench — RUNBOOK

Permanent bench tooling for `docs/plans/2026-07-17-005-relay-cf-reevaluation.md`.
It measures the exact metric set the June evaluation reported
(`docs/tech-docs/cloudflare-relay-evaluation.md`) — HTTP/WS p99 overhead vs
direct, relayed vs direct WS delivery, connect p95, upstream-open p95, holder
setup, upstream failure codes — with the June gates encoded (p99 overhead <
100ms; zero relayed-WS message loss).

Everything runs from `packages/workspace-relay/`. Reports land in
`bench/reports/` (gitignored). **Secrets are read from the environment and never
printed or committed.**

## Layout

| File | Role |
|---|---|
| `bench/loadgen.ts` | Core loadgen. Opens N direct + N relayed HTTP/WS pairs, emits a JSON + markdown row. `runRow()` is importable; the CLI writes to `--out`. |
| `bench/local-dry-run.ts` | Phase 0 gate. Boots echo target → bench resolver → real `bun src/main.ts` relay → loadgen. Proves the full metric set locally. |
| `bench/cf-dev-smoke.ts` | Local-first CF gate. Boots a worker under `wrangler dev` (Miniflare/workerd) and round-trips HTTP + WS through it. Runs for the stock worker AND the H2 variant. |
| `bench/provision.ts` | Creates/tears down one Daytona or Cloudflare sandbox via `@claxedo/sandbox-manager` (the product's own drivers). |
| `bench/stub-resolver.ts` | **Standalone** stub resolver process (CLI wrapper over `lib/resolver.ts`) — deploy/run it next to the relay in Phase 2 so `CLAXEDO_RELAY_RESOLVER_URL` has something to resolve against. |
| `bench/mint-rat.ts` | **Standalone** RAT keygen + minter (CLI). `keygen` emits a keypair PEM pair; `mint` signs a RAT from the private PEM. Lets the relay's trusted public key and the loadgen's signing key be provisioned across processes/hosts. |
| `bench/lib/tokens.ts` | Bench identity: ed25519 keypair + RAT minting (stands in for the control plane as RAT issuer). Also `benchKeypairPems()` / `benchIdentityFromPrivatePem()` for the standalone flow. |
| `bench/lib/resolver.ts` | Bench resolver core: the relay's `/internal/relay` `target`/`revocation` endpoints, pointed at whatever target you pass. Used in-process by the gates and by `stub-resolver.ts`. |
| `bench/lib/echo-target.ts` | Local HTTP + WS echo runtime (the local stand-in for a Daytona/CF sandbox). |
| `bench/lib/ws.ts`, `bench/lib/stats.ts` | WS probe (connect/RTT/trace timing) and percentile/row math. |

## Metric-name mapping (current src → June table vocabulary)

The relay's current trace vocabulary differs from June's literal names; the
loadgen reads the current names and the report maps them:

| June table term | Current source |
|---|---|
| `ws_upstream_open` / upstream-open | `relay.trace.wsUpstreamOpenMs` (WS, header `x-claxedo-relay-ws-trace: 1`); else client connect wall clock |
| queue delay | `relay.trace.maxQueuedDelayMs` |
| queued frames | `relay.trace.queuedFrames` |
| `relay_upstream_fetch` / HTTP tail | HTTP latency delta (relayed − direct); relay-local spans `rat-verify` / `target-resolve` / `rht-cache` / `rht-mint` in `server-timing` |
| established RTT | WS message round-trip (relayed vs direct) |

The `relay.trace` WS frame exists on BOTH adapters: Bun (`src/bun.ts`) and — as
of this bench work — the Cloudflare DO (`src/cloudflare.ts`, `admitCloudClient`),
gated by the same `x-claxedo-relay-ws-trace: 1` header. When the header is set
the loadgen reports `upstream-open` from the trace (`source=relay-trace`);
otherwise it falls back to the client wall clock (`source=client-wall-clock`).

## The resolve + RAT mechanism (required for ANY relayed request)

The relay does NOT proxy to arbitrary URLs. Every relayed request is (a)
resolved workspace/host → target through the relay's `CLAXEDO_RELAY_RESOLVER_URL`
(`src/main.ts` `createResolverClient`) and (b) authorized by a valid Runtime
Access Token (`src/server.ts` verify path, `RuntimeAccessTokenClaims` in
`src/auth.ts`). So a bench run — local or cloud — MUST provide both. Booting
`/health` alone (pre-auth) does NOT prove the relay path; a relayed WS message
round-trip does. This is the mechanism June's non-`central-fly-temp` rows used.

The two pieces:

- **Stub resolver** — maps every workspace to ONE target base URL and never
  revokes. In-process during the local gates; standalone via `stub-resolver.ts`
  for Phase 2 (run/deploy it next to the relay).
- **RAT keypair** — the relay trusts the PUBLIC key
  (`CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM`); the loadgen mints RATs with
  the PRIVATE key. `mint-rat.ts keygen` produces the pair; the loadgen accepts
  the private PEM via `--rat-private-key-pem` so it and the deployed relay agree
  on the signing key.

Standalone wiring (what Phase 2 does; proven end-to-end locally — relayed WS
40/40 through a standalone resolver + external-key loadgen):

```sh
# 1. Keypair. Configure the relay with the .pub.pem; keep the .key.pem.
bun bench/mint-rat.ts --action keygen --out bench/reports/bench-key
#    → bench/reports/bench-key.pub.pem  (relay CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
#    → bench/reports/bench-key.key.pem  (minting / loadgen --rat-private-key-pem)

# 2. Stub resolver next to the relay, pointed at the benchmark target.
bun bench/stub-resolver.ts --target-base-url https://<sandbox-or-echo>/ \
  --port 8790 --token <resolver-token>
#    → set CLAXEDO_RELAY_RESOLVER_URL to its URL, CLAXEDO_RELAY_RESOLVER_TOKEN to <resolver-token>

# 3. (optional) Mint a one-off RAT by hand, e.g. to curl the relay:
bun bench/mint-rat.ts --action mint --private-key-pem bench/reports/bench-key.key.pem \
  --workspace ws_bench --host host_bench          # prints the JWT

# 4. Loadgen signs its own RATs from the same private key the relay trusts:
bun bench/loadgen.ts --relay wss://<relay>/ --relay-http https://<relay>/ \
  --direct-ws wss://<target>/ --direct-http https://<target>/ \
  --workspace ws_bench --rat-private-key-pem bench/reports/bench-key.key.pem \
  --row-id <id> --connections 200 --concurrency 200 --ws-messages 4 --trace --out bench/reports
```

The local gates below do the same wiring in-process (fresh identity, in-process
resolver), so they need none of these flags.

## Phase 0 — local gates (no cloud, no deploys)

Run these before any deploy. All three must pass.

```sh
# 1. Package tests + typechecks
bun test src
bunx tsc --noEmit -p tsconfig.json          # src (incl. worker-h2.ts)
bunx tsc --noEmit -p bench/tsconfig.json     # bench kit

# 2. Loadgen end-to-end against a REAL local Bun relay (bun src/main.ts)
bun bench/local-dry-run.ts --connections 20 --ws-messages 4
#   Paced-opens (H1-style) variant: cap concurrent opens below connections
bun bench/local-dry-run.ts --connections 30 --concurrency 6 --ws-messages 4

# 3. CF workers boot under Miniflare/workerd and round-trip HTTP + WS
bun bench/cf-dev-smoke.ts --config wrangler.toml       # stock worker
bun bench/cf-dev-smoke.ts --config wrangler-h2.toml    # H2 opener-sharding variant
```

Each prints a markdown row and a PASS/FAIL. `local-dry-run` also confirms
`trace source=relay-trace`, proving the trace frame reads end-to-end.

## Phase 2 — deploy (only after Phase 0 passes; local-first per the plan)

**Never deploy to discover a failure.** Boot locally in production shape first,
then deploy. Every resource is `-reeval` suffixed; nothing touches production
DNS/routes.

### Fly/Bun relay (control)

Boot locally in production shape and smoke it before `flyctl deploy`:

```sh
# Boot-gating env (generate ephemeral ed25519 keys for the local boot; values
# never committed). Names only:
#   NODE_ENV=production
#   CLAXEDO_WORKSPACE_RELAY_HOST / CLAXEDO_WORKSPACE_RELAY_PORT
#   CLAXEDO_RELAY_RESOLVER_URL / CLAXEDO_RELAY_RESOLVER_TOKEN
#   CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM (or CLAXEDO_CONTROL_PLANE_JWKS_URL)
#   CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM
#   CLAXEDO_RELAY_METRICS_TOKEN
#   CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY=64   # plan amendment 3 — June PASS credited q64
#   CLAXEDO_RELAY_SYNTHETIC_PROBE_DISABLED=1
# then: bun run src/main.ts  → curl /health → loadgen smoke → flyctl deploy -c fly.toml
flyctl deploy -c fly.toml   # app name gets a -reeval suffix; sin region
flyctl secrets list -a <relay-app>   # verify CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY=64
```

### Cloudflare relay (subject) + H2 variant

Local-first gate already run in Phase 0 (`cf-dev-smoke.ts`). Deploy distinct
`-reeval` names, no prod routes:

```sh
npx wrangler deploy --dry-run -c wrangler.toml       # sanity build
npx wrangler deploy -c wrangler.toml                 # name it *-reeval
npx wrangler deploy -c wrangler-h2.toml              # H2 variant (OPENER_COUNT var)
#   Sweep opener count for Row 5:
npx wrangler deploy -c wrangler-h2.toml --var OPENER_COUNT:8
npx wrangler deploy -c wrangler-h2.toml --var OPENER_COUNT:32
# Secrets (names only): CLAXEDO_RELAY_RESOLVER_TOKEN, CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM,
# CLAXEDO_CONTROL_PLANE_JWKS_URL (or CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM),
# CLAXEDO_RELAY_RESOLVER_URL.  Set via `wrangler secret put <NAME> -c <config>`.
```

### Targets

```sh
# Daytona sandbox (Rows 1–5). Reads DAYTONA_API_KEY (Phase 1 verified it in
# packages/claxedo-server/.env, on the claxedo-selfhost-test Fly app, and in the
# local managed store). Snapshot: CLAXEDO_DAYTONA_SNAPSHOT else the fresh CI
# snapshot baked into provision.ts.
#   source packages/claxedo-server/.env   # or export DAYTONA_API_KEY / DAYTONA_TARGET
bun bench/provision.ts --provider daytona --action create --workspace ws_reeval_dtn
#   → prints sandbox id + url + ws url; writes bench/reports/provision-daytona-*.json

# Cloudflare sandbox (Row 6 only). Requires the sandbox worker deployed via
# scripts/sandbox/cloudflare-worker (deploy-cloudflare-sandbox-worker.yml).
#   env: CLAXEDO_SANDBOX_CLOUDFLARE_WORKER_URL, CLAXEDO_SANDBOX_CLOUDFLARE_API_TOKEN
bun bench/provision.ts --provider cloudflare --action create --workspace ws_reeval_cf
```

## Phase 3 — benchmark matrix

Wire the resolve + RAT mechanism (see the section above): run `stub-resolver.ts`
next to each relay pointed at the sandbox, configure each relay with the
keypair's `.pub.pem` (`CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM`) and the
resolver URL/token, and give the loadgen the matching `.key.pem`. Run the
loadgen from a Fly machine in `sin` (June's vantage) against each relay/target
pair. Point `--direct-ws/--direct-http` at the sandbox and `--relay/--relay-http`
at the relay.

```sh
# Row template (writes JSON + md to bench/reports/):
bun bench/loadgen.ts \
  --relay wss://<relay-reeval>/ --relay-http https://<relay-reeval>/ \
  --direct-ws wss://<sandbox-preview>/ --direct-http https://<sandbox-preview>/ \
  --workspace <wsId> --path /api/claxedo/pty/pty_1/connect \
  --rat-private-key-pem bench/reports/bench-key.key.pem \
  --row-id <rowId> --shape "c200/load600" \
  --connections 600 --concurrency 200 --ws-messages 4 --http-requests 200 \
  --trace --out bench/reports
```

Matrix (see the plan for purpose per row):
1. Direct → Daytona smoke + c200 (baseline; must show 101 + clean messages).
2. Fly relay → Daytona c200/load600, c140/load1000 (control reproduction).
3. CF relay → Daytona c200/load600 — **H0**.
4. CF relay → Daytona, paced opens (`--concurrency 6`) at c200 — **H1**.
5. CF relay (H2 sharded openers, OPENER_COUNT 8 then 32) → Daytona c200/load600, then c140/load1000 — **H2** (the only decision-changing row).
6. CF relay → CF sandbox c200 — control pair.
7. Platform-limits text capture + 429 attribution — **H3** (capture the "Simultaneous open connections" limits text verbatim; read 429 response headers/body to attribute Daytona vs CF).

Direct-vs-relayed are measured in the same run window (the loadgen does both in
one invocation).

## Teardown checklist

- [ ] `bun bench/provision.ts --provider daytona --action destroy --workspace <ws> --sandbox-id <id>`
- [ ] `bun bench/provision.ts --provider cloudflare --action destroy --workspace <ws> --sandbox-id <id>` (if Row 6 ran)
- [ ] `npx wrangler delete -c wrangler.toml` (the `-reeval` stock worker) and its DO
- [ ] `npx wrangler delete -c wrangler-h2.toml` (the `-reeval` H2 worker) and its DO
- [ ] `flyctl apps destroy <relay-reeval-app>` (the `-reeval` Fly relay)
- [ ] Destroy the `sin` loadgen Fly machine
- [ ] `rm -f .dev.vars` (cf-dev-smoke removes it on teardown; confirm none left)
- [ ] Confirm no sandboxes linger: check the Daytona dashboard / `provision --action list` equivalents
- [ ] Reports kept in `bench/reports/` (gitignored); link the filenames from the report

## Environment variables (names only — never commit values)

| Var | Used by | Notes |
|---|---|---|
| `DAYTONA_API_KEY` | provision (Daytona) | required; managed-store equivalent = driver-auth.ts `sandboxDriverAuthManaged("daytona")` |
| `DAYTONA_API_URL` / `DAYTONA_ORGANIZATION_ID` / `DAYTONA_TARGET` | provision (Daytona) | optional; SDK defaults otherwise |
| `CLAXEDO_DAYTONA_SNAPSHOT` / `CLAXEDO_SNAPSHOT_NAME` | provision (Daytona) | snapshot override; else fresh CI snapshot |
| `CLAXEDO_SANDBOX_CLOUDFLARE_WORKER_URL` / `CLAXEDO_SANDBOX_CLOUDFLARE_API_TOKEN` | provision (Cloudflare) | Row 6; from the deployed sandbox worker |
| `CLAXEDO_RELAY_RESOLVER_URL` / `CLAXEDO_RELAY_RESOLVER_TOKEN` | relay boot | resolver channel |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM` / `CLAXEDO_CONTROL_PLANE_JWKS_URL` | relay boot | RAT verification key (bench identity's public half) |
| `CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM` | relay boot | RHT signing key (required in production) |
| `CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY` | Fly relay | set to `64` for the control deploy (plan amendment 3) |
| `CLAXEDO_RELAY_METRICS_TOKEN` | Fly relay | token-gates `/metrics` |
| `CLAXEDO_RELAY_SYNTHETIC_PROBE_DISABLED` | relay boot | `1` during bench runs |
| `OPENER_COUNT` | H2 worker | opener shards per workspace (Row 5 sweeps 8, 32) |
```
