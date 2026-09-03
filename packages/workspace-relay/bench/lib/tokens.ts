// Bench identity material. In production the control plane mints Runtime
// Access Tokens; the bench has no control plane, so it generates its own
// ed25519 keypair, configures the relay with the PUBLIC half
// (CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM), and mints RATs with the
// private half. This is the same trust shape the real system uses, just with
// the bench standing in as issuer — no relay code path is bypassed.

import { exportJWK, exportPKCS8, exportSPKI, generateKeyPair, importJWK, importPKCS8 } from "jose"
import { mintHostTunnelToken, mintRuntimeAccessToken, type RelayRole } from "../../src/auth"

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
  const publicKeyPem = await exportSPKI(pair.publicKey as CryptoKey)
  return identityFromKeys(pair.privateKey as CryptoKey, pair.publicKey as CryptoKey, publicKeyPem, overrides)
}

export type MintHttInput = {
  subject: string
  hostId: string
  workspaceIds: string[]
  ttlSeconds: number
}

const HTT_DEFAULTS: MintHttInput = {
  subject: "bench_provisioner",
  hostId: "host_bench",
  workspaceIds: ["ws_bench"],
  ttlSeconds: 5 * 60,
}

/** Mint a Host Tunnel Token (HTT) from a PKCS8 private-key PEM. This is the
 * dial-in host-side credential: it authorizes a workspace runtime to REGISTER
 * a tunnel into the relay (aud `workspace-relay-host-tunnel`, bound to
 * host_id + workspace_ids), replacing the Daytona preview token the dial-out
 * path used for host auth. Signed with the SAME bench key as the RAT, so the
 * relay trusts it via CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM — no extra
 * relay config. Claims/alg come from src/auth.ts mintHostTunnelToken, matching
 * verifyHostTunnelToken exactly (iss=claxedo-control-plane). */
export async function benchHostTunnelTokenFromPrivatePem(
  privateKeyPem: string,
  overrides: Partial<MintHttInput> = {},
): Promise<string> {
  const privateKey = (await importPKCS8(privateKeyPem, "EdDSA", { extractable: true })) as CryptoKey
  const merged = { ...HTT_DEFAULTS, ...overrides }
  return mintHostTunnelToken(
    {
      subject: merged.subject,
      hostId: merged.hostId,
      workspaceIds: merged.workspaceIds,
      ttlSeconds: merged.ttlSeconds,
    },
    privateKey,
    "EdDSA",
  )
}

/** Fresh ed25519 keypair as PEM strings — the persisted form the relay
 * (public) and the loadgen/minter (private) exchange across processes. */
export async function benchKeypairPems(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const pair = await generateKeyPair("EdDSA", { extractable: true })
  return {
    publicKeyPem: await exportSPKI(pair.publicKey as CryptoKey),
    privateKeyPem: await exportPKCS8(pair.privateKey as CryptoKey),
  }
}

/** Re-hydrate a bench identity from a PKCS8 private-key PEM (e.g. produced by
 * `mint-rat.ts --action keygen`), deriving the public half so the identity is
 * complete. Lets a cloud loadgen mint RATs the deployed relay already trusts. */
export async function benchIdentityFromPrivatePem(
  privateKeyPem: string,
  overrides: Partial<MintRatInput> = {},
): Promise<BenchIdentity> {
  const privateKey = (await importPKCS8(privateKeyPem, "EdDSA", { extractable: true })) as CryptoKey
  const jwk = await exportJWK(privateKey)
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x }
  const publicKey = (await importJWK(publicJwk as Parameters<typeof importJWK>[0], "EdDSA", { extractable: true })) as CryptoKey
  const publicKeyPem = await exportSPKI(publicKey)
  return identityFromKeys(privateKey, publicKey, publicKeyPem, overrides)
}
