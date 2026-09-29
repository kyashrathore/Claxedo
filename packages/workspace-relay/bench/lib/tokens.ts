// Bench identity material. In production the control plane mints Runtime
// Access Tokens; the bench has no control plane, so it generates its own
// ed25519 keypair, configures the relay with the PUBLIC half
// (CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), and mints RATs with the
// private half. This is the same trust shape the real system uses, just with
// the bench standing in as issuer — no relay code path is bypassed.

import { exportSPKI, generateKeyPair } from "jose"
import { mintRuntimeAccessToken, type RelayRole } from "../../src/auth"

export type BenchIdentity = {
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicKeyPem: string
  mintRat: (input?: Partial<MintRatInput>) => Promise<string>
}

export type MintRatInput = {
  actorId: string
  orgId: string
  workspaceId: string
  hostId: string
  role: RelayRole
  ttlSeconds: number
}

const DEFAULTS: MintRatInput = {
  actorId: "bench_user",
  orgId: "bench_org",
  workspaceId: "ws_bench",
  hostId: "host_bench",
  role: "editor",
  ttlSeconds: 30 * 60,
}

function identityFromKeys(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  publicKeyPem: string,
  overrides: Partial<MintRatInput>,
): BenchIdentity {
  const base = { ...DEFAULTS, ...overrides }
  return {
    privateKey,
    publicKey,
    publicKeyPem,
    mintRat: (input = {}) => {
      const merged = { ...base, ...input }
      return mintRuntimeAccessToken(
        {
          principalKind: "user",
          actorId: merged.actorId,
          actorKind: "human",
          orgId: merged.orgId,
          workspaceId: merged.workspaceId,
          hostId: merged.hostId,
          role: merged.role,
          ttlSeconds: merged.ttlSeconds,
        },
        privateKey,
        "EdDSA",
      )
    },
  }
}

export async function createBenchIdentity(overrides: Partial<MintRatInput> = {}): Promise<BenchIdentity> {
  const pair = await generateKeyPair("EdDSA", { extractable: true })
  const publicKeyPem = await exportSPKI(pair.publicKey)
  return identityFromKeys(pair.privateKey, pair.publicKey, publicKeyPem, overrides)
}
