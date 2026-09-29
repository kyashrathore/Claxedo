# Relay gate

`bun run bench:gate` boots the relay Worker under `wrangler dev --local`
(workerd), points it at a bench resolver and an echo target, and drives HTTP
requests and WS upgrades through it and directly at the target in the same run.
It prints one markdown row and fails unless the HTTP requests and relayed WS
messages round-trip. CI runs it through `.github/workflows/relay-bench-gate.yml`;
it needs no Cloudflare account.

Everything runs from `packages/workspace-relay/`.

| File | Role |
|---|---|
| `cf-dev-smoke.ts` | The gate. Writes the boot secrets to `.dev.vars`, starts `wrangler dev`, runs one loadgen row, removes `.dev.vars`. |
| `loadgen.ts` | `runRow()`: opens N direct + N relayed HTTP/WS pairs and returns the row's metrics. |
| `lib/tokens.ts` | Bench identity: an ed25519 keypair whose public half the Worker trusts, minting Runtime Access Tokens in place of the control plane. |
| `lib/resolver.ts` | The relay's `/internal/relay` `target`/`revocation` endpoints, pointed at the echo target. |
| `lib/echo-target.ts` | Local HTTP + WS echo runtime, the stand-in for a sandbox. |
| `lib/ws.ts`, `lib/stats.ts` | WS probe (connect/RTT/trace timing) and percentile, row and gate math. |

```sh
bun run bench:gate                                     # wrangler.toml
bun bench/cf-dev-smoke.ts --config wrangler-h2.toml    # opener-sharding variant
bun bench/cf-dev-smoke.ts --connections 30 --ws-messages 8
```

A relayed request is resolved workspace → target through
`CLAXEDO_RELAY_RESOLVER_URL` and authorized by a Runtime Access Token
(`src/auth.ts`), so `/health` alone proves nothing about the relay path; a
relayed WS round-trip does.
