# Relay bench

Measures relay overhead against a direct connection: HTTP and WS p99 overhead,
relayed vs direct WS delivery, connect and upstream-open p95, and upstream
failure codes. The gates live in `lib/stats.ts`: p99 overhead under 100 ms and
zero relayed-WS message loss. `bun run bench:gate` (the local gate below) is
what CI runs, through `.github/workflows/relay-bench-gate.yml`.

Everything runs from `packages/workspace-relay/`. Reports land in
`bench/reports/` (gitignored). Secrets are read from the environment and never
printed or committed.

## Layout

| File | Role |
|---|---|
| `loadgen.ts` | Core loadgen. Opens N direct + N relayed HTTP/WS pairs and emits a JSON + markdown row. `runRow()` is importable; the CLI writes to `--out`. |
| `local-dry-run.ts` | The local gate (`bench:gate`). Boots echo target → bench resolver → real `bun src/main.ts` relay → loadgen. |
| `cf-dev-smoke.ts` | The Cloudflare gate (`bench:gate:cf`). Boots a worker under `wrangler dev` and round-trips HTTP + WS through it. |
| `provision.ts` | Creates or tears down one Daytona or Cloudflare sandbox through `@claxedo/sandbox-manager`. |
| `stub-resolver.ts` | Standalone resolver process (CLI over `lib/resolver.ts`) to run next to a deployed relay. |
| `mint-rat.ts` | Runtime Access Token keygen and minter. `keygen` emits a PEM pair; `mint` signs a token from the private PEM. |
| `lib/tokens.ts` | Bench identity: ed25519 keypair and token minting, standing in for the control plane. |
| `lib/resolver.ts` | The relay's `/internal/relay` `target`/`revocation` endpoints, pointed at whatever target you pass. |
| `lib/echo-target.ts` | Local HTTP + WS echo runtime, the stand-in for a sandbox. |
| `lib/ws.ts`, `lib/stats.ts` | WS probe (connect/RTT/trace timing) and percentile, row and gate math. |

## What a relayed request needs

The relay does not proxy to arbitrary URLs. Every relayed request is resolved
workspace → target through `CLAXEDO_RELAY_RESOLVER_URL` (`src/main.ts`
`createResolverClient`) and authorized by a valid Runtime Access Token
(`src/auth.ts`). A bench run must provide both; `/health` alone proves nothing
about the relay path, a relayed WS round-trip does.

The local gates wire both in process. Against a deployed relay:

```sh
# 1. Keypair: the relay trusts the .pub.pem (CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM).
bun bench/mint-rat.ts --action keygen --out bench/reports/bench-key

# 2. Stub resolver next to the relay; set CLAXEDO_RELAY_RESOLVER_URL/_TOKEN to it.
bun bench/stub-resolver.ts --target-base-url https://<target>/ --port 8790 --token <resolver-token>

# 3. Loadgen signs its own tokens with the private half.
bun bench/loadgen.ts --relay wss://<relay>/ --relay-http https://<relay>/ \
  --direct-ws wss://<target>/ --direct-http https://<target>/ \
  --workspace ws_bench --rat-private-key-pem bench/reports/bench-key.key.pem \
  --row-id <id> --connections 200 --concurrency 200 --ws-messages 4 --trace --out bench/reports
```

## Local gates

```sh
bun test src
bunx tsc --noEmit -p bench/tsconfig.json
bun run bench:gate                                     # local-dry-run.ts
bun bench/local-dry-run.ts --connections 30 --concurrency 6 --ws-messages 4
bun run bench:gate:cf                                  # cf-dev-smoke.ts, stock worker
bun bench/cf-dev-smoke.ts --config wrangler-h2.toml    # opener-sharding variant
```

Each prints a markdown row and PASS/FAIL. `local-dry-run` also reports
`trace source=relay-trace`, proving the relay's trace frame reads end to end.
