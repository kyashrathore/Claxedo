#!/usr/bin/env bun
// Standalone stub resolver — the minimal control-plane stand-in the relay needs
// to serve a relayed request. The Fly/Bun relay does not proxy to arbitrary
// URLs: it resolves workspace/host → target through its
// CLAXEDO_RELAY_RESOLVER_URL (src/main.ts createResolverClient) and checks RAT
// revocation. This process answers both, mapping every workspace to one target
// base URL.
//
// Runs in-process inside local-dry-run.ts / cf-dev-smoke.ts via the same
// startBenchResolver(); this CLI is the deployable standalone form — run it
// next to the relay and point CLAXEDO_RELAY_RESOLVER_URL at it. The relay
// presents CLAXEDO_RELAY_RESOLVER_TOKEN as a Bearer; set --token
// (or CLAXEDO_RELAY_RESOLVER_TOKEN) to require it.
//
//   bun bench/stub-resolver.ts --target-base-url https://<sandbox-preview>/ \
//     --port 8790 --token <resolver-token>
//
// Emits GET /target?workspaceId=&hostId= → WorkspaceRelayTarget (backing: cloud-vm)
// and GET /revocation?... → { active: true }. GET /health for liveness.

import { trimToUndefined } from "@claxedo/helpers/string"
import { startBenchResolver } from "./lib/resolver"

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1]
  }
  return undefined
}

function main() {
  const targetBaseUrl = trimToUndefined(arg("target-base-url")) ?? trimToUndefined(process.env.BENCH_TARGET_BASE_URL)
  if (!targetBaseUrl) {
    console.error("[stub-resolver] --target-base-url (or BENCH_TARGET_BASE_URL) is required")
    process.exit(2)
  }
  const port = Number(trimToUndefined(arg("port")) ?? trimToUndefined(process.env.PORT) ?? "8790")
  const hostname = trimToUndefined(arg("host")) ?? "0.0.0.0"
  const token = trimToUndefined(arg("token")) ?? trimToUndefined(process.env.CLAXEDO_RELAY_RESOLVER_TOKEN)

  const resolver = startBenchResolver({
    targetBaseUrl,
    ...(token ? { token } : {}),
    port,
    hostname,
  })
  console.error(
    `[stub-resolver] listening ${resolver.url} → target=${targetBaseUrl} auth=${token ? "bearer" : "none"}`,
  )
  console.error("[stub-resolver] relay env: CLAXEDO_RELAY_RESOLVER_URL=" + resolver.url + (token ? " CLAXEDO_RELAY_RESOLVER_TOKEN=<token>" : ""))

  const shutdown = () => {
    resolver.stop()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main()
