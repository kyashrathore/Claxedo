import { describe, expect, test } from "bun:test"
import { SignJWT, createLocalJWKSet, decodeJwt, decodeProtectedHeader, errors, exportJWK, generateKeyPair, importPKCS8 } from "jose"
import { CURRENT_CHANNEL_IDENTITY_VERSION } from "@claxedo/workspace-relay-protocol"
import {
  RUNTIME_ACCESS_TOKEN_ISSUED_AT_FLOOR_SECONDS,
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
  validateRuntimeAccessTokenClaims,
  deriveRelayHostKid,
  deriveRelayHostPublicKey,
} from "./auth"

async function keys() {
  return await generateKeyPair("EdDSA", { extractable: true })
}

function caught(run: () => unknown) {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error("expected the call to throw")
}

const base = {
  principalKind: "user" as const,
  actorId: "actor_1",
  actorKind: "human" as const,
  actorPublicId: "usr_public_1",
  actorName: "Ada Lovelace",
  actorAvatarUrl: "https://example.test/ada.png",
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
      principal_kind: "user",
      actor_id: "actor_1",
      actor_kind: "human",
      actor_public_id: "usr_public_1",
      actor_name: "Ada Lovelace",
      actor_avatar_url: "https://example.test/ada.png",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "editor",
      jti: "jti_1",
    })
  })

  test("rejects legacy Runtime Access Tokens without canonical actor claims", async () => {
    const key = await keys()
    const token = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setSubject("legacy-user")
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti("legacy_jti")
      .sign(key.privateKey)

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({ code: "relay_token_claims_invalid" })
  })

  test("rejects tokens that carry only one actor claim", async () => {
    const key = await keys()
    const token = await new SignJWT({
      principal_kind: base.principalKind,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      actor_id: "actor_1",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti("partial_actor_jti")
      .sign(key.privateKey)

    await expect(verifyRuntimeAccessToken(token, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({ code: "relay_token_claims_invalid" })
  })

  test("rejects incomplete signed actor display profiles", async () => {
    const key = await keys()
    const token = await new SignJWT({
      principal_kind: base.principalKind,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      actor_public_id: base.actorPublicId,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti("incomplete_profile")
      .sign(key.privateKey)

    await expect(verifyRuntimeAccessToken(token, key.publicKey, { workspaceId: base.workspaceId }))
      .rejects.toMatchObject({ code: "relay_token_claims_invalid" })
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

  test("refuses a Runtime Access Token issued before the provenance floor on both verification paths", async () => {
    const key = await keys()
    const token = await new SignJWT({
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setIssuedAt(RUNTIME_ACCESS_TOKEN_ISSUED_AT_FLOOR_SECONDS - 1)
      .setExpirationTime("30m")
      .setJti("pre_floor")
      .sign(key.privateKey)

    await expect(verifyRuntimeAccessToken(token, key.publicKey, { workspaceId: "ws_1" }))
      .rejects.toMatchObject({ code: "relay_token_claims_invalid", message: expect.stringContaining("floor") })
    expect(caught(() => validateRuntimeAccessTokenClaims(decodeJwt(token), { workspaceId: "ws_1" })))
      .toMatchObject({ code: "relay_token_claims_invalid", message: expect.stringContaining("floor") })
  })

  const channelIdentity = {
    channel: "telegram",
    externalUserId: "123456789",
    identityVersion: CURRENT_CHANNEL_IDENTITY_VERSION,
  }
  const channelClaim = {
    channel: "telegram",
    external_user_id: "123456789",
    identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
  }

  test("carries channel provenance at the current identity version through both verification paths", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken({ ...base, channelIdentity }, key.privateKey, "EdDSA")

    await expect(verifyRuntimeAccessToken(token, key.publicKey, { workspaceId: "ws_1", hostId: "host_1" }))
      .resolves.toMatchObject({ actor_id: "actor_1", channel_identity: channelClaim })
    expect(validateRuntimeAccessTokenClaims(decodeJwt(token), { workspaceId: "ws_1" }))
      .toMatchObject({ channel_identity: channelClaim })
  })

  test("refuses a channel token whose identity version predates the boundary", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken({
      ...base,
      channelIdentity: { ...channelIdentity, identityVersion: CURRENT_CHANNEL_IDENTITY_VERSION - 1 },
    }, key.privateKey, "EdDSA")

    await expect(verifyRuntimeAccessToken(token, key.publicKey, { workspaceId: "ws_1" }))
      .rejects.toMatchObject({ code: "relay_token_claims_invalid", message: expect.stringContaining("identity version") })
    expect(caught(() => validateRuntimeAccessTokenClaims(decodeJwt(token), { workspaceId: "ws_1" })))
      .toMatchObject({ code: "relay_token_claims_invalid", message: expect.stringContaining("identity version") })
  })

  test("refuses a channel provenance claim that is malformed", async () => {
    const key = await keys()
    const malformed: unknown[] = [
      { channel: "telegram", identity_version: CURRENT_CHANNEL_IDENTITY_VERSION },
      { external_user_id: "123456789", identity_version: CURRENT_CHANNEL_IDENTITY_VERSION },
      { channel: "telegram", external_user_id: "123456789" },
      { channel: "telegram", external_user_id: "123456789", identity_version: String(CURRENT_CHANNEL_IDENTITY_VERSION) },
      { channel: "telegram", external_user_id: "123456789", identity_version: 1.5 },
      { channel: "telegram", external_user_id: " ", identity_version: CURRENT_CHANNEL_IDENTITY_VERSION },
      "telegram",
      null,
    ]
    for (const channel_identity of malformed) {
      const token = await new SignJWT({
        principal_kind: base.principalKind,
        actor_id: base.actorId,
        actor_kind: base.actorKind,
        org_id: base.orgId,
        workspace_id: base.workspaceId,
        host_id: base.hostId,
        role: base.role,
        channel_identity,
      })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(runtimeAccessTokenIssuer)
        .setAudience(runtimeAccessTokenAudience)
        .setIssuedAt()
        .setExpirationTime("30m")
        .setJti("malformed_channel")
        .sign(key.privateKey)

      await expect(verifyRuntimeAccessToken(token, key.publicKey, { workspaceId: "ws_1" }))
        .rejects.toMatchObject({ code: "relay_token_claims_invalid" })
    }
  })

  test("a token minted now without channel provenance verifies with no provenance attached", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")

    expect(decodeJwt(token)).not.toHaveProperty("channel_identity")
    const claims = await verifyRuntimeAccessToken(token, key.publicKey, { workspaceId: "ws_1" })
    expect(claims).not.toHaveProperty("channel_identity")
    expect(validateRuntimeAccessTokenClaims(decodeJwt(token), { workspaceId: "ws_1" })).not.toHaveProperty("channel_identity")
  })

  test("a Relay Host Token minted for a channel actor carries its provenance", async () => {
    const key = await keys()
    const token = await mintRelayHostToken({
      ...base,
      channelIdentity,
      backing: "cloud-vm",
      parentJti: "parent_jti",
    }, key.privateKey, "EdDSA")

    await expect(verifyRelayHostToken(token, key.publicKey, { workspaceId: "ws_1" }))
      .resolves.toMatchObject({ parent_jti: "parent_jti", channel_identity: channelClaim })
  })

  test("preserves remote JWKS timeouts as verifier unavailability", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")
    const resolver = async () => { throw new errors.JWKSTimeout() }

    await expect(verifyRuntimeAccessToken(token, resolver, { workspaceId: "ws_1" }))
      .rejects.toBeInstanceOf(errors.JWKSTimeout)
  })

  test("rejects tampered Runtime Access Token signatures", async () => {
    const key = await keys()
    const token = await mintRuntimeAccessToken(base, key.privateKey, "EdDSA")
    const [header, payload, signature] = token.split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
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
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
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
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
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
      parentJti: base.jti,
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
      parent_jti: base.jti,
      backing: "cloud-vm",
    })

    await expect(verifyRelayHostToken(directClientToken, key.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).rejects.toMatchObject({
      code: "invalid_relay_token",
    } satisfies Partial<WorkspaceRelayAuthError>)
  })

  test("rejects Relay Host Tokens that do not identify their parent Runtime Access Token", async () => {
    const key = await keys()
    const token = await new SignJWT({
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      backing: "cloud-vm",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("workspace-relay")
      .setAudience("workspace-host-service")
      .setIssuedAt()
      .setExpirationTime("1m")
      .setJti("rht_without_parent")
      .sign(key.privateKey)

    await expect(verifyRelayHostToken(token, key.publicKey, {
      workspaceId: base.workspaceId,
      hostId: base.hostId,
    })).rejects.toMatchObject({ code: "relay_token_claims_invalid" })
  })

  test("rejects a Relay Host Token backing that names no placement", async () => {
    const key = await keys()
    await expect(mintRelayHostToken({
      ...base,
      parentJti: base.jti,
      backing: "user-hosted",
    } as unknown as Parameters<typeof mintRelayHostToken>[0], key.privateKey, "EdDSA")).rejects.toMatchObject({
      code: "relay_token_claims_invalid",
    } satisfies Partial<WorkspaceRelayAuthError>)

    const forged = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      parent_jti: base.jti,
      backing: "user-hosted",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("workspace-relay")
      .setAudience(relayHostTokenAudience)
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

  test("refuses a Relay Host Token that still carries an access claim", async () => {
    const key = await keys()
    const minted = await new SignJWT({
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      parent_jti: base.jti,
      access: "cloud",
      backing: "cloud-vm",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("workspace-relay")
      .setAudience(relayHostTokenAudience)
      .setIssuedAt()
      .setExpirationTime("30m")
      .setJti(base.jti)
      .sign(key.privateKey)

    await expect(verifyRelayHostToken(minted, key.publicKey, {
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
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
      org_id: base.orgId,
      workspace_id: base.workspaceId,
      host_id: base.hostId,
      role: base.role,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "key-b" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
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
      principal_kind: base.principalKind,
      actor_id: base.actorId,
      actor_kind: base.actorKind,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "key-b" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
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
      parentJti: base.jti,
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
      parentJti: base.jti,
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

  test("Host Tunnel Tokens carry the serving-generation fence only when minted with one", async () => {
    const key = await keys()
    const fenced = await mintHostTunnelToken({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      enrollmentId: "enr_1",
      generation: 0,
    }, key.privateKey, "EdDSA")
    const claims = await verifyHostTunnelToken(fenced, key.publicKey, { hostId: "host_1", workspaceIds: ["ws_1"] })
    expect(claims).toMatchObject({ enrollment_id: "enr_1", generation: 0 })

    const unfenced = await mintHostTunnelToken({
      subject: "user_1",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
    }, key.privateKey, "EdDSA")
    const plain = await verifyHostTunnelToken(unfenced, key.publicKey, { hostId: "host_1", workspaceIds: ["ws_1"] })
    expect("enrollment_id" in plain).toBe(false)
    expect("generation" in plain).toBe(false)
  })

  test("refuses to mint a Host Tunnel Token whose fence is malformed", async () => {
    const key = await keys()
    const input = { subject: "user_1", hostId: "host_1", workspaceIds: ["ws_1"] }
    for (const fence of [
      { generation: 1 },
      { enrollmentId: "enr_1", generation: -1 },
      { enrollmentId: "enr_1", generation: 1.5 },
      { enrollmentId: "enr_1", generation: Number.NaN },
    ]) {
      await expect(mintHostTunnelToken({ ...input, ...fence }, key.privateKey, "EdDSA")).rejects.toMatchObject({
        code: "relay_token_claims_invalid",
      } satisfies Partial<WorkspaceRelayAuthError>)
    }
  })

  test("rejects signed Host Tunnel Tokens whose generation claim is malformed", async () => {
    const key = await keys()
    const now = Math.floor(Date.now() / 1000)
    const signed = async (claims: Record<string, unknown>) => await new SignJWT({
      host_id: "host_1",
      workspace_ids: ["ws_1"],
      ...claims,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience("workspace-relay-host-tunnel")
      .setSubject("user_1")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti("jti_fence")
      .sign(key.privateKey)

    for (const claims of [
      { enrollment_id: "enr_1", generation: "3" },
      { enrollment_id: "enr_1", generation: -1 },
      { enrollment_id: "enr_1", generation: 2.5 },
      { generation: 3 },
      { enrollment_id: "", generation: 3 },
    ]) {
      await expect(verifyHostTunnelToken(await signed(claims), key.publicKey, {
        hostId: "host_1",
        workspaceIds: ["ws_1"],
      })).rejects.toMatchObject({
        code: "relay_token_claims_invalid",
      } satisfies Partial<WorkspaceRelayAuthError>)
    }
  })
})
/*
 * A fixed Ed25519 key and the `kid` this repository publishes for it.
 *
 * The value below is a PUBLISHED IDENTIFIER, not a test detail. `kid` is how a
 * relay host advertises its signing key and how the other side looks that key
 * up, so `deriveRelayHostKid` must return the same string for the same key in
 * every runtime that signs: the Bun relay (`main.ts`) and the Cloudflare
 * relay/worker (`worker.ts`) both call this one implementation precisely so a
 * token minted by one verifies at the other.
 *
 * Therefore: if a change to `deriveRelayHostKid` (or to
 * `deriveRelayHostPublicKey` feeding it) makes this test fail, the fix is NOT
 * to update the literal. Changing it rotates the `kid` of every enrolled host,
 * which is a breaking deployment requiring both sides to be redeployed
 * together — not a refactor. Update the value only as a deliberate,
 * coordinated key-id migration.
 */
const RELAY_HOST_KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIK5deGJyYg+DtM2fydAGN6XUzQpAgck9coVQNFVd57p4\n-----END PRIVATE KEY-----"
const RELAY_HOST_KEY_PUBLIC_X = "e__LBs0bIcSli9PmbUEJTa9cgtKGV6EMX8-h-PHj2FU"
const RELAY_HOST_KEY_KID = "b2c8b0497a919fed"

describe("relay host key identity", () => {
  test("derives the pinned kid for the pinned signing key", async () => {
    const privateKey = await importPKCS8(RELAY_HOST_KEY_PEM, "EdDSA", { extractable: true })
    if (privateKey instanceof Uint8Array) throw new Error("fixture key imported as raw bytes, not a CryptoKey")

    const publicKey = await deriveRelayHostPublicKey(privateKey)

    // Pin the public component too: the kid is sha256(utf8(jwk.x)), so a change
    // in how the public key is recovered from the private key moves the kid
    // just as surely as a change to the hashing does.
    expect((await exportJWK(publicKey)).x).toBe(RELAY_HOST_KEY_PUBLIC_X)
    expect(await deriveRelayHostKid(publicKey)).toBe(RELAY_HOST_KEY_KID)
  })

  test("derives the same kid whether the public key is recovered or supplied directly", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const roundTripped = await deriveRelayHostPublicKey(pair.privateKey)

    expect(await deriveRelayHostKid(roundTripped)).toBe(await deriveRelayHostKid(pair.publicKey))
  })
})
