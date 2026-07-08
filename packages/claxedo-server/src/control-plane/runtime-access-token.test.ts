import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, SignJWT } from "jose"
import {
  hostTunnelTokenSigner,
  runtimeAccessTokenSigner,
  mintSupervisorBackplaneToken,
  verifySupervisorBackplaneToken,
  supervisorBackplaneTokenAudience,
  supervisorBackplaneTokenIssuer,
} from "./runtime-access-token"
import {
  runtimeAccessTokenAudience,
  runtimeAccessTokenIssuer,
} from "@claxedo/workspace-relay"

const ENV_KEYS = [
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_KID",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM",
] as const

const previous: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

async function ed25519PrivateKeyPem() {
  const keyPair = await generateKeyPair("EdDSA", { extractable: true })
  return {
    privatePem: await exportPKCS8(keyPair.privateKey),
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})

describe("runtimeAccessTokenSigner", () => {
  test("mints a token whose protected header carries a kid", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const sign = runtimeAccessTokenSigner()
    const result = await sign({
      subject: "user_kid_test",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    })

    const header = decodeProtectedHeader(result.runtimeAccessToken)
    expect(typeof header.kid).toBe("string")
    expect((header.kid as string).length).toBeGreaterThan(0)
    expect(header.alg).toBe("EdDSA")
  })

  test("kid is stable across multiple mints with the same key", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const sign = runtimeAccessTokenSigner()
    const a = await sign({
      subject: "u1", orgId: "o", workspaceId: "w", hostId: "h", role: "editor",
    })
    const b = await sign({
      subject: "u2", orgId: "o", workspaceId: "w", hostId: "h", role: "viewer",
    })

    const headerA = decodeProtectedHeader(a.runtimeAccessToken)
    const headerB = decodeProtectedHeader(b.runtimeAccessToken)
    expect(headerA.kid).toEqual(headerB.kid)
  })

  test("explicit kid env override is honored", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_KID = "explicit-kid-2026-05-08"

    const sign = runtimeAccessTokenSigner()
    const result = await sign({
      subject: "u",
      orgId: "o",
      workspaceId: "w",
      hostId: "h",
      role: "editor",
    })

    const header = decodeProtectedHeader(result.runtimeAccessToken)
    expect(header.kid).toBe("explicit-kid-2026-05-08")
  })

  test("returns expected envelope (jti, expiresAt, token)", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const sign = runtimeAccessTokenSigner()
    const before = Date.now()
    const result = await sign({
      subject: "u",
      orgId: "o",
      workspaceId: "w",
      hostId: "h",
      role: "editor",
    })

    expect(typeof result.runtimeAccessToken).toBe("string")
    expect(result.runtimeAccessToken.split(".").length).toBe(3)
    expect(typeof result.jti).toBe("string")
    expect(result.jti.length).toBeGreaterThan(0)
    expect(result.tokenExpiresAt).toBeGreaterThan(before)
  })

  test("throws control-plane error when private key is missing", async () => {
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"
    const sign = runtimeAccessTokenSigner()
    await expect(
      sign({ subject: "u", orgId: "o", workspaceId: "w", hostId: "h", role: "editor" }),
    ).rejects.toThrow(/signer/i)
  })
})

describe("supervisorBackplaneToken", () => {
  test("audience constant is supervisor-backplane", () => {
    expect(supervisorBackplaneTokenAudience).toBe("supervisor-backplane")
  })

  test("issuer constant matches the runtime access token issuer", () => {
    expect(supervisorBackplaneTokenIssuer).toBe(runtimeAccessTokenIssuer)
  })

  test("mint produces a JWT with aud=supervisor-backplane and iss=claxedo issuer", async () => {
    const { privatePem, publicKey } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const result = await mintSupervisorBackplaneToken({
      subject: "supervisor_1",
      workspaceId: "ws_1",
      hostId: "host_1",
    })

    expect(typeof result.supervisorBackplaneToken).toBe("string")
    expect(result.supervisorBackplaneToken.split(".").length).toBe(3)
    expect(typeof result.jti).toBe("string")
    expect(result.tokenExpiresAt).toBeGreaterThan(Date.now())

    const verified = await verifySupervisorBackplaneToken(
      result.supervisorBackplaneToken,
      publicKey,
      { workspaceId: "ws_1", hostId: "host_1" },
    )
    expect(verified.aud).toBe("supervisor-backplane")
    expect(verified.iss).toBe(runtimeAccessTokenIssuer)
    expect(verified.workspace_id).toBe("ws_1")
    expect(verified.host_id).toBe("host_1")
    expect(verified.sub).toBe("supervisor_1")
    expect(verified.action).toBe("runtime.config.apply")
    expect(verified.scopes).toContain("runtime.config.apply")
  })

  test("mint protected header includes a kid using the same derivation strategy as RAT", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const ratSign = runtimeAccessTokenSigner()
    const rat = await ratSign({
      subject: "u",
      orgId: "o",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    })
    const sb = await mintSupervisorBackplaneToken({
      subject: "u",
      workspaceId: "ws_1",
      hostId: "host_1",
    })

    const ratHeader = decodeProtectedHeader(rat.runtimeAccessToken)
    const sbHeader = decodeProtectedHeader(sb.supervisorBackplaneToken)
    expect(typeof sbHeader.kid).toBe("string")
    expect((sbHeader.kid as string).length).toBeGreaterThan(0)
    expect(sbHeader.alg).toBe("EdDSA")
    expect(sbHeader.kid).toEqual(ratHeader.kid)
  })

  test("default TTL is 60 seconds", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const before = Date.now()
    const result = await mintSupervisorBackplaneToken({
      subject: "supervisor_1",
      workspaceId: "ws_1",
      hostId: "host_1",
    })
    const ttlMs = result.tokenExpiresAt - before
    // Allow for clock truncation to seconds + small jitter.
    expect(ttlMs).toBeGreaterThanOrEqual(55_000)
    expect(ttlMs).toBeLessThanOrEqual(65_000)
  })

  test("verify accepts a freshly minted token", async () => {
    const { privatePem, publicKey } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const minted = await mintSupervisorBackplaneToken({
      subject: "supervisor_1",
      workspaceId: "ws_a",
      hostId: "host_a",
    })
    const claims = await verifySupervisorBackplaneToken(
      minted.supervisorBackplaneToken,
      publicKey,
      { workspaceId: "ws_a", hostId: "host_a" },
    )
    expect(claims.workspace_id).toBe("ws_a")
    expect(claims.host_id).toBe("host_a")
  })

  test("verify rejects a token with audience workspace-relay (RAT)", async () => {
    const { privatePem, publicKey } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const ratSign = runtimeAccessTokenSigner()
    const rat = await ratSign({
      subject: "u",
      orgId: "o",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    })

    await expect(
      verifySupervisorBackplaneToken(rat.runtimeAccessToken, publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      }),
    ).rejects.toThrow()
  })

  test("verify rejects an expired token", async () => {
    const { privatePem, privateKey, publicKey } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const past = Math.floor(Date.now() / 1000) - 3600
    const expired = await new SignJWT({
      workspace_id: "ws_1",
      host_id: "host_1",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(supervisorBackplaneTokenIssuer)
      .setAudience(supervisorBackplaneTokenAudience)
      .setSubject("u")
      .setIssuedAt(past)
      .setExpirationTime(past + 60)
      .setJti("expired-jti")
      .sign(privateKey)

    await expect(
      verifySupervisorBackplaneToken(expired, publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      }),
    ).rejects.toThrow()
  })

  test("verify rejects a token with missing claims", async () => {
    const { privatePem, privateKey, publicKey } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const now = Math.floor(Date.now() / 1000)
    const incomplete = await new SignJWT({
      // workspace_id intentionally omitted
      host_id: "host_1",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(supervisorBackplaneTokenIssuer)
      .setAudience(supervisorBackplaneTokenAudience)
      .setSubject("u")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti("missing-claim-jti")
      .sign(privateKey)

    await expect(
      verifySupervisorBackplaneToken(incomplete, publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      }),
    ).rejects.toThrow()
  })

  test("verify rejects a token whose workspace_id does not match the expected target", async () => {
    const { privatePem, publicKey } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const minted = await mintSupervisorBackplaneToken({
      subject: "supervisor_1",
      workspaceId: "ws_correct",
      hostId: "host_correct",
    })

    await expect(
      verifySupervisorBackplaneToken(minted.supervisorBackplaneToken, publicKey, {
        workspaceId: "ws_other",
        hostId: "host_correct",
      }),
    ).rejects.toThrow()
  })

  test("expects audience constant differs from RAT audience", () => {
    expect(supervisorBackplaneTokenAudience).not.toBe(runtimeAccessTokenAudience)
  })
})

describe("hostTunnelTokenSigner", () => {
  test("mints a host-tunnel token whose protected header carries a kid", async () => {
    const { privatePem } = await ed25519PrivateKeyPem()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const sign = hostTunnelTokenSigner()
    const result = await sign({
      subject: "host_sub",
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
    })

    const header = decodeProtectedHeader(result.hostTunnelToken)
    expect(typeof header.kid).toBe("string")
    expect((header.kid as string).length).toBeGreaterThan(0)
    expect(header.alg).toBe("EdDSA")
  })
})
