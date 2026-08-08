import { describe, expect, test } from "vitest"
import { exportJWK, generateKeyPair, jwtVerify } from "jose"
import { randomToken, sha256Hex16 } from "@claxedo/server-core/platform/auth/web-crypto"
import { runtimeAccessTokenSigner, hostTunnelTokenSigner } from "../platform/auth/runtime-access-token"

/**
 * Proves the JWKS `kid` derivation and the RAT/HTT signers work on the global
 * Web Crypto path (no `node:crypto`), which is what makes them Worker-safe.
 */

async function ed25519Pems() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true })
  const { exportPKCS8, exportSPKI } = await import("jose")
  return {
    privatePem: await exportPKCS8(privateKey),
    publicPem: await exportSPKI(publicKey),
    publicKey,
  }
}

describe("web-crypto helpers", () => {
  test("sha256Hex16 is deterministic and 16 hex chars", async () => {
    const a = await sha256Hex16("hello")
    const b = await sha256Hex16("hello")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(await sha256Hex16("world")).not.toBe(a)
  })

  test("randomToken returns distinct UUIDs", () => {
    expect(randomToken()).not.toBe(randomToken())
    expect(randomToken()).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("Worker-compatible token signing", () => {
  test("runtime access token signs and verifies, with a JWKS-agreeing kid", async () => {
    const { privatePem, publicPem, publicKey } = await ed25519Pems()
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
    } as unknown as NodeJS.ProcessEnv

    const result = await runtimeAccessTokenSigner(env)({
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "owner",
    })
    expect(result.runtimeAccessToken).toBeTruthy()

    const { payload, protectedHeader } = await jwtVerify(result.runtimeAccessToken, publicKey, {
      issuer: "claxedo-control-plane",
      audience: "workspace-relay",
    })
    expect(payload.workspace_id).toBe("ws_1")
    expect(payload.host_id).toBe("host_1")
    // The kid in the header is SHA-256(public x) — what the JWKS endpoint derives.
    const jwk = await exportJWK(publicKey)
    expect(protectedHeader.kid).toBe(await sha256Hex16(String(jwk.x)))
  })

  test("host tunnel token signs with the host-tunnel audience", async () => {
    const { privatePem, publicPem, publicKey } = await ed25519Pems()
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
    } as unknown as NodeJS.ProcessEnv

    const result = await hostTunnelTokenSigner(env)({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    })
    const { payload } = await jwtVerify(result.hostTunnelToken, publicKey, {
      issuer: "claxedo-control-plane",
      audience: "workspace-relay-host-tunnel",
    })
    expect(payload.host_id).toBe("host_1")
    expect(payload.workspace_ids).toEqual(["ws_1"])
  })
})
