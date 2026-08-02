#!/usr/bin/env bun
// Standalone Host Tunnel Token (HTT) minter for the DIAL-IN cloud path. In
// dial-in the sandbox opens ONE outbound tunnel INTO the relay and the relay
// routes browser clients into channels over it — flipping today's dial-out
// (relay dials the Daytona preview URL). The host leg is authenticated with an
// HTT instead of a Daytona preview token: control-plane-signed, bound to
// host_id + workspace_ids, short-lived (5m), audience `workspace-relay-host-tunnel`.
//
// The bench mints its own HTT with the SAME ed25519 private key it uses for
// RATs; the relay already trusts the public half via
// CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM (verifyHostTunnelToken in
// src/cloudflare.ts:1296 uses options.runtimeAccessKey — the RAT key). Claims
// and alg (EdDSA) are produced by src/auth.ts mintHostTunnelToken so they match
// the verifier exactly.
//
//   bun bench/mint-htt.ts --private-key-pem <file|pem> \
//     --workspace ws_reeval_dtn --host host_bench [--ttl 300] [--subject bench_provisioner]
//
// Prints the token (only) on stdout so it can be captured; guidance on stderr.

import { readFile } from "node:fs/promises"
import { benchHostTunnelTokenFromPrivatePem } from "./lib/tokens"

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) {
    return process.argv[index + 1]
  }
  return undefined
}

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

// A --private-key-pem value may be a file path or the PEM text itself.
async function resolvePem(value: string): Promise<string> {
  if (value.includes("BEGIN")) return value.replaceAll("\\n", "\n")
  try {
    return await readFile(value, "utf8")
  } catch {
    console.error(`[mint-htt] could not read private key from "${value}" (not a PEM and not a readable file)`)
    process.exit(2)
  }
}

async function main() {
  const pemArg = clean(arg("private-key-pem")) ?? clean(process.env.BENCH_RAT_PRIVATE_KEY_PEM)
  if (!pemArg) {
    console.error("[mint-htt] requires --private-key-pem <file|pem> (or BENCH_RAT_PRIVATE_KEY_PEM)")
    process.exit(2)
  }
  const privateKeyPem = await resolvePem(pemArg)
  const workspaceId = clean(arg("workspace")) ?? "ws_reeval_dtn"
  const hostId = clean(arg("host")) ?? "host_bench"
  const token = await benchHostTunnelTokenFromPrivatePem(privateKeyPem, {
    workspaceIds: [workspaceId],
    hostId,
    ...(clean(arg("subject")) ? { subject: clean(arg("subject"))! } : {}),
    ...(clean(arg("ttl")) ? { ttlSeconds: Number(clean(arg("ttl"))) } : {}),
  })
  process.stdout.write(token + "\n")
}

main().catch((err) => {
  console.error("[mint-htt] failed:", err)
  process.exit(1)
})
