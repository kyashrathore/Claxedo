import { describe, expect, test } from "bun:test"
import { SignJWT, createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair } from "jose"
import {
  WorkspaceRelayAuthError,
  relayHostTokenAudience,
  mintHostTunnelToken,
  mintRelayHostToken,
  mintRuntimeAccessToken,
  runtimeAccessTokenAudience,
  runtimeAccessTokenIssuer,
  verifyHostTunnelToken,
  verifyRelayHostToken,
  verifyRuntimeAccessToken,
  type RelayClaimPair,
} from "./auth"

async function keys() {
  return await generateKeyPair("EdDSA", { extractable: true })
}

const base = {
  subject: "user_1",
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  jti: "jti_1",
}

describe("workspace relay auth", () => {
  test("verifies Runtime Access Tokens for the expected workspace and host", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).resolves.toMatchObject({
      iss: "claxedo-control-plane",
      aud: "workspace-relay",
      sub: "user_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "editor",
      jti: "jti_1",
    })
  })

  test("rejects Runtime Access Tokens for the wrong workspace or host", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_2",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "relay_token_workspace_mismatch",
    } satisfies Partial<WorkspaceRelayAuthError>)

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_2",
    })).rejects.toMatchObject({
      code: "relay_token_host_mismatch",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("rejects Runtime Access Tokens with the wrong issuer or audience", async () => {
    const key = await keys()
    const wrongIssuer = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("other-control-plane")
      .setAudience(runtimeAccessTokenAudience)
      .setSubject(base.subject)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(key.privateKey)
    const wrongAudience = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(relayHostTokenAudience)
      .setSubject(base.subject)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(key.privateKey)

    for (const token of [wrongIssuer, wrongAudience]) {
      await expect(verifyRuntimeAccessToken(token, key.publicKey, {
        workspaceId: "ws_1",
        hostId: "host_1",
      })).rejects.toMatchObject({
        code: "invalid_relay_token",
      } satisfies Partial<WorkspaceRelayAuthError>)
    }
  })

  test("rejects expired Runtime Access Tokens", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken({
      ...base,
      ttlSeconds: -1,
    }, key.privateKey, "EdDSA")

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("rejects tampered Runtime Access Token signatures", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")
    const [header, payload, signature] = token.split(".")
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>
    const tampered = [
      header,
      Buffer.from(JSON.stringify({ ...claims, role: "owner" })).toString("base64url"),
      signature,
    ].join(".")

    await expect(verifyRuntimeAccessToken(tampered, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("rejects alg none Runtime Access Tokens", async () => {
    const payload = {
      iss: runtimeAccessTokenIssuer,
      aud: runtimeAccessTokenAudience,
      sub: base.subject,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      jti: base.jti,
    }
    const token = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "",
    ].join(".")
    const key = await keys()

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("rejects symmetric-algorithm Runtime Access Token confusion attempts", async () => {
    const key = await keys()
    const token = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setSubject(base.subject)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(new TextEncoder().encode("attacker-controlled-secret"))

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("verifies Relay Host Tokens and rejects direct Runtime Access Tokens", async () => {
    const key = await keys()
    const hostToken = await mintRelayHostToken({
      ...base,
      access: "cloud",
      backing: "cloud-vm",
    }, key.privateKey, "EdDSA")
    const directClientToken = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")

    await expect(verifyRelayHostToken(hostToken, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).resolves.toMatchObject({
      iss: "workspace-relay",
      aud: "workspace-host-service",
      role: "editor",
      access: "cloud",
      backing: "cloud-vm",
    })

    await expect(verifyRelayHostToken(directClientToken, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("rejects inconsistent Relay Host Token access/backing pairs", async () => {
    const key = await keys()
    await expect(mintRelayHostToken({
      ...base,
      access: "cloud",
      backing: "local-worktree",
    } as unknown as typeof base & RelayClaimPair, key.privateKey, "EdDSA")).rejects.toMatchObject({
      code: "relay_token_claims_invalid",
    } satisfies Partial<WorkspaceRelayAuthError>)

    const forged = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      access: "user-hosted",
      backing: "cloud-vm",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("workspace-relay")
      .setAudience(relayHostTokenAudience)
      .setSubject(base.subject)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(key.privateKey)

    await expect(verifyRelayHostToken(forged, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "relay_token_claims_invalid",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("verifies Runtime Access Tokens via a JWKS resolver matching the token kid", async () => {
    const keyA = await keys()
    const keyB = await keys()
    const jwkA = { ...(await exportJWK(keyA.publicKey)), kid: "key-a", alg: "EdDSA", use: "sig" }
    const jwkB = { ...(await exportJWK(keyB.publicKey)), kid: "key-b", alg: "EdDSA", use: "sig" }
    const resolver = createLocalJWKSet({ keys: [jwkA, jwkB] })

    const token = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "key-b" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setSubject(base.subject)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(keyB.privateKey)

    await expect(verifyRuntimeAccessToken(token, resolver, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).resolves.toMatchObject({
      iss: runtimeAccessTokenIssuer,
      aud: runtimeAccessTokenAudience,
      jti: "jti_1",
      role: "editor",
    })
  })

  test("rejects tokens whose kid is not in the JWKS", async () => {
    const keyA = await keys()
    const keyB = await keys()
    const jwkA = { ...(await exportJWK(keyA.publicKey)), kid: "key-a", alg: "EdDSA", use: "sig" }
    const resolver = createLocalJWKSet({ keys: [jwkA] })

    const token = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "key-b" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setSubject(base.subject)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(keyB.privateKey)

    await expect(verifyRuntimeAccessToken(token, resolver, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("mintRelayHostToken includes a kid in the JWT protected header when provided", async () => {
    const key = await keys()
    const token = await mintRelayHostToken({
      ...base,
      access: "cloud",
      backing: "cloud-vm",
      kid: "rht-key-current",
    }, key.privateKey, "EdDSA")

    const header = decodeProtectedHeader(token)
    expect(header).toMatchObject({ alg: "EdDSA", kid: "rht-key-current" })
  })

  test("mintRelayHostToken omits kid when not provided", async () => {
    const key = await keys()
    const token = await mintRelayHostToken({
      ...base,
      access: "cloud",
      backing: "cloud-vm",
    }, key.privateKey, "EdDSA")

    const header = decodeProtectedHeader(token)
    expect(header.alg).toBe("EdDSA")
    expect(header.kid).toBeUndefined()
  })

  test("verifies Host Tunnel Tokens for the expected host and workspaces", async () => {
    const key = await keys()
    const token = await mintHostTunnelToken({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
      jti: "host_jti_1",
    }, key.privateKey, "EdDSA")

    await expect(verifyHostTunnelToken(token, key.publicKey, {
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    })).resolves.toMatchObject({
      iss: "claxedo-control-plane",
      aud: "workspace-relay-host-tunnel",
      sub: "user_1",
      host_id: "host_1",
      workspace_ids: ["ws_1", "ws_2"],
      jti: "host_jti_1",
    })

    await expect(verifyHostTunnelToken(token, key.publicKey, {
      hostId: "host_2",
      workspaceIds: ["ws_1"],
    })).rejects.toMatchObject({
      code: "relay_token_host_mismatch",
    } satisfies Partial<WorkspaceRelayAuthError>)

    await expect(verifyHostTunnelToken(token, key.publicKey, {
      hostId: "host_1",
      workspaceIds: ["ws_3"],
    })).rejects.toMatchObject({
      code: "relay_token_workspace_mismatch",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })
})
