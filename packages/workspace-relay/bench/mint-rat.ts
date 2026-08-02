#!/usr/bin/env bun
// Standalone RAT keygen + minter. The relay requires a valid Runtime Access
// Token on every relayed request (src/server.ts verify path,
// RuntimeAccessTokenClaims in src/auth.ts). In production the control plane
// mints these; the bench mints its own, giving the relay the PUBLIC key via
// CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM and signing tokens with the
// PRIVATE key. Claims/alg (EdDSA, iss=claxedo-control-plane, aud=workspace-relay,
// workspace_id/host_id/jti/exp) are produced by src/auth.ts mintRuntimeAccessToken,
// so they match the verifier exactly.
//
// keygen — emit a keypair PEM pair (configure the relay with the public half,
//          keep the private half for minting / loadgen --rat-private-key-pem):
//   bun bench/mint-rat.ts --action keygen
//   bun bench/mint-rat.ts --action keygen --out bench/reports/bench-key   # writes .pub.pem/.key.pem
//
// mint — sign one RAT from a private-key PEM (file path or the PEM itself):
//   bun bench/mint-rat.ts --action mint --private-key-pem <file|pem> \
//     --workspace ws_bench --host host_bench [--org bench_org] [--role editor] [--ttl 1800]
//
// The RAT rides to the relay as the client authorization: `Authorization:
// Bearer <rat>` (HTTP) or the `claxedo-rat.<rat>` WS subprotocol.

import { readFile, writeFile } from "node:fs/promises"
import { benchKeypairPems, benchIdentityFromPrivatePem } from "./lib/tokens"
import type { RelayRole } from "../src/auth"

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
    console.error(`[mint-rat] could not read private key from "${value}" (not a PEM and not a readable file)`)
    process.exit(2)
  }
}

async function main() {
  const action = clean(arg("action")) ?? "keygen"

  if (action === "keygen") {
    const { publicKeyPem, privateKeyPem } = await benchKeypairPems()
    const out = clean(arg("out"))
    if (out) {
      await writeFile(`${out}.pub.pem`, publicKeyPem)
      await writeFile(`${out}.key.pem`, privateKeyPem)
      console.error(`[mint-rat] wrote ${out}.pub.pem (relay CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM) and ${out}.key.pem (minting)`)
      return
    }
    // Machine-readable on stdout; guidance on stderr.
    process.stdout.write(JSON.stringify({ publicKeyPem, privateKeyPem }, null, 2) + "\n")
    console.error("[mint-rat] configure the relay with publicKeyPem; keep privateKeyPem for minting")
    return
  }

  if (action === "mint") {
    const pemArg = clean(arg("private-key-pem")) ?? clean(process.env.BENCH_RAT_PRIVATE_KEY_PEM)
    if (!pemArg) {
      console.error("[mint-rat] mint requires --private-key-pem <file|pem> (or BENCH_RAT_PRIVATE_KEY_PEM)")
      process.exit(2)
    }
    const privateKeyPem = await resolvePem(pemArg)
    const workspaceId = clean(arg("workspace")) ?? "ws_bench"
    const hostId = clean(arg("host")) ?? "host_bench"
    const identity = await benchIdentityFromPrivatePem(privateKeyPem, { workspaceId, hostId })
    const rat = await identity.mintRat({
      workspaceId,
      hostId,
      ...(clean(arg("org")) ? { orgId: clean(arg("org"))! } : {}),
      ...(clean(arg("role")) ? { role: clean(arg("role"))! as RelayRole } : {}),
      ...(clean(arg("ttl")) ? { ttlSeconds: Number(clean(arg("ttl"))) } : {}),
    })
    // The token itself on stdout so it can be captured; nothing else.
    process.stdout.write(rat + "\n")
    return
  }

  console.error(`[mint-rat] unknown --action ${action} (keygen|mint)`)
  process.exit(2)
}

main().catch((err) => {
  console.error("[mint-rat] failed:", err)
  process.exit(1)
})
