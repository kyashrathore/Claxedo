import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { RuntimeSessionAuthorityRoutes, type RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

const relayInput = {
  principalKind: "user" as const,
  actorId: "actor_1",
  actorKind: "human" as const,
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  access: "cloud" as const,
  backing: "cloud-vm" as const,
  jti: "rht_child_1",
  parentJti: "rat_parent_1",
}

const transitionStubs = {
  markSessionRegistrationAmbiguous: async () => ({}) as never,
  beginSessionCompensation: async () => ({}) as never,
  completeSessionCompensation: async () => ({}) as never,
}

function app(options: RuntimeSessionAuthorityOptions) {
  return new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes(options))
}

function request(target: Hono, token: string | undefined, body: Record<string, unknown>) {
  return target.request("/api/runtime-authority/session-authorize", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("runtime private-session authority oracle", () => {
  test("requires the exact registration operation and derives actor/workspace only from a current RHT", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const registerRuntimeSession = vi.fn(async () => ({}))
    const authorizeRuntimeSession = vi.fn(async () => {})
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession,
        authorizeRuntimeSession,
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    })
    const token = await mintRelayHostToken(relayInput, key.privateKey, "EdDSA")

    expect((await request(target, token, {
      sessionId: "ses_private",
      action: "register",
    })).status).toBe(400)
    expect((await request(target, token, {
      operationId: "op_create_1",
      sessionId: "ses_private",
      workspaceId: "attacker_workspace",
      actorId: "attacker_actor",
      action: "register",
      title: "Private",
    })).status).toBe(200)
    expect(registerRuntimeSession).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      operationId: "op_create_1",
      sessionId: "ses_private",
      workspaceId: "ws_1",
      title: "Private",
    })

    const expired = await mintRelayHostToken({
      ...relayInput,
      jti: "rht_expired",
      now: Date.now() - 120_000,
      ttlSeconds: 60,
    }, key.privateKey, "EdDSA")
    expect((await request(target, expired, { sessionId: "ses_private", action: "read" })).status).toBe(401)
    expect(authorizeRuntimeSession).not.toHaveBeenCalled()
  })

  test("rejects inconsistent principal and actor kinds even when the relay signature is valid", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const now = Math.floor(Date.now() / 1_000)
    const token = await new SignJWT({
      principal_kind: "user",
      actor_id: "agent_1",
      actor_kind: "agent",
      org_id: "org_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      parent_jti: "rat_parent_1",
      role: "editor",
      access: "cloud",
      backing: "cloud-vm",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer("workspace-relay")
      .setAudience("workspace-host-service")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti("rht_inconsistent")
      .sign(key.privateKey)
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    })
    expect((await request(target, token, { sessionId: "ses_private", action: "read" })).status).toBe(401)
  })

  test("binds reconciliation and compensation transitions to RHT actor, workspace, session, and operation", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const markSessionRegistrationAmbiguous = vi.fn(async () => ({} as never))
    const beginSessionCompensation = vi.fn(async () => ({} as never))
    const completeSessionCompensation = vi.fn(async () => ({} as never))
    const target = app({
      authority: {
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => ({ active: true }),
        markSessionRegistrationAmbiguous,
        beginSessionCompensation,
        completeSessionCompensation,
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    })
    const token = await mintRelayHostToken(relayInput, key.privateKey, "EdDSA")

    for (const action of ["registration_ambiguous", "compensation_begin", "compensation_complete"]) {
      expect((await request(target, token, {
        action,
        operationId: "op_create_1",
        sessionId: "ses_private",
        workspaceId: "attacker_workspace",
        actorId: "attacker_actor",
        reason: "runtime outcome",
      })).status).toBe(200)
    }
    const expected = {
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      operationId: "op_create_1",
      sessionId: "ses_private",
      workspaceId: "ws_1",
      reason: "runtime outcome",
    }
    expect(markSessionRegistrationAmbiguous).toHaveBeenCalledWith(expected)
    expect(beginSessionCompensation).toHaveBeenCalledWith(expected)
    expect(completeSessionCompensation).toHaveBeenCalledWith(expected)
    expect((await request(target, token, {
      action: "compensation_begin",
      operationId: "op_create_1",
      sessionId: "ses_private",
    })).status).toBe(400)
  })

  test("renews short stream leases only while both the parent RAT and session authority remain active", async () => {
    const relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const runtimeKey = await generateKeyPair("EdDSA", { extractable: true })
    let active = true
    let allowed = true
    const runtimeAccessTokenActive = vi.fn(async () => active
      ? { active: true }
      : { active: false, code: "runtime_access_token_revoked", reason: "revoked" })
    const authorizeRuntimeSession = vi.fn(async () => {
      if (!allowed) throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "participant revoked")
    })
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession,
        runtimeAccessTokenActive,
      },
      env: {
        CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(runtimeKey.privateKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtimeKey.publicKey),
      },
    })
    const rht = await mintRelayHostToken(relayInput, relayKey.privateKey, "EdDSA")
    const initial = await request(target, rht, { sessionId: "ses_private", action: "read", stream: true })
    expect(initial.status).toBe(200)
    const first = await initial.json() as { lease: string; expiresAt: number }
    expect(first.lease).toBeTypeOf("string")
    expect(runtimeAccessTokenActive).toHaveBeenLastCalledWith({
      jti: "rat_parent_1",
      workspaceId: "ws_1",
      hostId: "host_1",
    })

    const renew = () => request(target, undefined, {
      sessionId: "ses_private",
      action: "read",
      stream: true,
      lease: first.lease,
    })
    expect((await renew()).status).toBe(200)
    allowed = false
    expect((await renew()).status).toBe(403)
    allowed = true
    active = false
    const revoked = await renew()
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })
  })

  test("limits request bodies before proof verification", async () => {
    const verifyRelayProof = vi.fn(async () => { throw new Error("must not run") })
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      verifyRelayProof,
    })
    const response = await target.request("/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(17 * 1024) },
      body: JSON.stringify({ sessionId: "x".repeat(17 * 1024), action: "read" }),
    })
    expect(response.status).toBe(413)
    expect(verifyRelayProof).not.toHaveBeenCalled()
  })
})
