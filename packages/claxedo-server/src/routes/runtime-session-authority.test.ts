import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import {
  childCompletionTurnIdPrefix,
  SessionTurnConflictError,
  SessionTurnGrantError,
  type GrantSessionTurnInput,
  type SessionTurnGrant,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal, ReservePrivateSessionInput } from "@claxedo/server-core/platform/auth/private-session-authority"
import { memorySandboxPassRegister } from "../platform/auth/sandbox-pass-register"
import { createOwnerGrantProof, mintOwnerGrant } from "../session/owner-grant"
import {
  DEFERRED_TURN_GRANT_AUDIENCE,
  DEFERRED_TURN_GRANT_ISSUER,
  deferredTurnGrantClaims,
  mintDeferredTurnGrant,
  verifyDeferredTurnGrant,
} from "../session/deferred-turn-grant"
import { mintTasksCapability } from "../tasks/capability"
import { RuntimeSessionAuthorityRoutes, type RuntimeSessionAuthorityOptions } from "./runtime-session-authority"

const relayInput = {
  principalKind: "user" as const,
  actorId: "actor_1",
  actorKind: "human" as const,
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  backing: "cloud-vm" as const,
  jti: "rht_child_1",
  parentJti: "rat_parent_1",
}

const transitionStubs = {
  authorizeRuntimeSessionStartStatus: async () => {},
  authorizeRuntimeSessionStart: async () => {},
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
  test("checks current runtime-token role before host setup administration", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const runtimeAccessTokenActive = vi.fn(async (input: { minimumRole?: string }) => input.minimumRole === "admin"
      ? { active: false, code: "runtime_access_token_revoked", reason: "Workspace role was downgraded" }
      : { active: true })
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive,
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey), CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey) },
    })
    const editor = await mintRelayHostToken(relayInput, key.privateKey, "EdDSA")
    const admin = await mintRelayHostToken({ ...relayInput, role: "admin", jti: "rht_admin" }, key.privateKey, "EdDSA")

    expect((await request(target, editor, { action: "host_read" })).status).toBe(200)
    expect(runtimeAccessTokenActive).toHaveBeenLastCalledWith({
      jti: "rat_parent_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      minimumRole: "viewer",
    })
    expect((await request(target, editor, { action: "host_admin" })).status).toBe(403)

    const downgraded = await request(target, admin, { action: "host_admin" })
    expect(downgraded.status).toBe(401)
    await expect(downgraded.json()).resolves.toMatchObject({ error: { code: "runtime_access_token_revoked" } })
    expect(runtimeAccessTokenActive).toHaveBeenLastCalledWith(expect.objectContaining({ minimumRole: "admin" }))
  })

  test("refuses a workspace stream when its lease signer is unavailable", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}), authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    })
    const token = await mintRelayHostToken(relayInput, key.privateKey, "EdDSA")
    const response = await request(target, token, { action: "host_read" })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "session_stream_authority_unavailable" } })
  })

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

  test("refuses a relay proof that still carries an access claim", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const now = Math.floor(Date.now() / 1_000)
    const authorizeRuntimeSession = vi.fn(async () => {})
    const token = await new SignJWT({
      principal_kind: "user",
      actor_id: "actor_1",
      actor_kind: "human",
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
      .setJti("rht_access_claim")
      .sign(key.privateKey)
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession,
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    })
    expect((await request(target, token, { sessionId: "ses_private", action: "read" })).status).toBe(401)
    expect(authorizeRuntimeSession).not.toHaveBeenCalled()
  })

  test("binds reconciliation and compensation transitions to RHT actor, workspace, session, and operation", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const markSessionRegistrationAmbiguous = vi.fn(async () => ({} as never))
    const beginSessionCompensation = vi.fn(async () => ({} as never))
    const completeSessionCompensation = vi.fn(async () => ({} as never))
    const target = app({
      authority: {
        authorizeRuntimeSessionStartStatus: async () => {},
        authorizeRuntimeSessionStart: async () => {},
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

  test("derives durable turn ownership from the RHT and preserves fenced 409 conflicts", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const turnKey = await generateKeyPair("EdDSA", { extractable: true })
    const acquireSessionTurn = vi.fn(async (input) => ({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      turnId: input.turnId,
      leaseId: "turn_lease_1",
      fencingToken: 4,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }))
    const renewSessionTurn = vi.fn(acquireSessionTurn)
    const releaseSessionTurn = vi.fn(async (input) => ({
      released: true,
      sessionId: input.sessionId,
      turnId: input.turnId,
      fencingToken: input.fencingToken,
    }))
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      turnAuthority: {
        acquireSessionTurn,
        renewSessionTurn,
        releaseSessionTurn,
        grantSessionTurn: async () => { throw new Error("deferred turn grants are not under test") },
        revokeSessionTurnGrants: async () => ({ revoked: 0 }),
      },
      env: {
        CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(turnKey.privateKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(turnKey.publicKey),
      },
    })
    const token = await mintRelayHostToken(relayInput, key.privateKey, "EdDSA")

    const acquired = await request(target, token, {
      sessionId: "ses_private",
      workspaceId: "attacker_workspace",
      actorId: "attacker_actor",
      action: "turn_acquire",
      turnId: "msg_1",
    })
    expect(acquired.status).toBe(200)
    const acquiredBody = await acquired.json() as { leaseId: string; fencingToken: number }
    expect(acquiredBody).toMatchObject({ fencingToken: 4 })
    expect(acquiredBody.leaseId).not.toBe("turn_lease_1")
    expect(acquireSessionTurn).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      sessionId: "ses_private",
      workspaceId: "ws_1",
      turnId: "msg_1",
    })

    expect((await request(target, undefined, {
      sessionId: "ses_private",
      action: "turn_renew",
      turnId: "msg_1",
      leaseId: acquiredBody.leaseId,
      fencingToken: 4,
    })).status).toBe(200)
    expect((await request(target, undefined, {
      sessionId: "ses_private",
      action: "turn_release",
      turnId: "msg_1",
      leaseId: acquiredBody.leaseId,
      fencingToken: 4,
    })).status).toBe(200)

    for (const mismatch of [
      { sessionId: "ses_other" },
      { turnId: "msg_other" },
      { fencingToken: 5 },
    ]) {
      const calls = renewSessionTurn.mock.calls.length
      const denied = await request(target, undefined, {
        sessionId: "ses_private", action: "turn_renew", turnId: "msg_1",
        leaseId: acquiredBody.leaseId, fencingToken: 4, ...mismatch,
      })
      expect(denied.status).toBe(401)
      expect(await denied.json()).toMatchObject({ error: { code: "session_turn_lease_invalid" } })
      expect(renewSessionTurn).toHaveBeenCalledTimes(calls)
    }

    acquireSessionTurn.mockRejectedValueOnce(new SessionTurnConflictError("ses_private", 999))
    const conflict = await request(target, token, {
      sessionId: "ses_private",
      action: "turn_acquire",
      turnId: "msg_2",
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: "session_turn_in_progress" } })
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

describe("the owner grant as a session proof", () => {
  const OWNER: WorkspaceOwnerIdentity = { userId: "alice", actorId: "actor_alice", orgId: "org_1", projectId: "project_a" }
  const scope = { ...OWNER, workspaceId: "ws_1" }
  const principal = { principalKind: "user", actorId: "actor_alice", actorKind: "human" }

  async function fixture(input: {
    owner?: (workspaceId: string) => Promise<WorkspaceOwnerIdentity | undefined>
    authorize?: () => Promise<void>
    reserve?: boolean
    resolver?: boolean
  } = {}) {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey),
    }
    const passes = memorySandboxPassRegister()
    const resolveWorkspaceOwner = vi.fn(input.owner ?? (async (workspaceId: string) => (workspaceId === "ws_1" ? OWNER : undefined)))
    const authority = {
      ...transitionStubs,
      authorizeRuntimeSessionStartStatus: vi.fn(async () => {}),
      authorizeRuntimeSessionStart: vi.fn(async () => {}),
      registerRuntimeSession: vi.fn(async () => ({})),
      authorizeRuntimeSession: vi.fn(input.authorize ?? (async () => {})),
      runtimeAccessTokenActive: vi.fn(async (): Promise<{ active: boolean; code?: string; reason?: string }> => ({ active: true })),
      ...(input.reserve === false ? {} : {
        reserveRuntimeSession: vi.fn(async (_principal: PrivateSessionRuntimePrincipal, intent: ReservePrivateSessionInput) => ({
          changed: true,
          operationId: intent.operationId,
          sessionId: intent.sessionId,
          workspaceId: intent.workspaceId,
          state: "reserved" as const,
        })),
      }),
    }
    const turnAuthority = {
      acquireSessionTurn: vi.fn(async (turn: { sessionId: string; workspaceId: string; turnId: string }) => ({
        ...turn, leaseId: "turn_lease_1", fencingToken: 2, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      })),
      renewSessionTurn: vi.fn(async (turn: { sessionId: string; workspaceId: string; turnId: string; leaseId: string; fencingToken: number }) => ({
        ...turn, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      })),
      releaseSessionTurn: vi.fn(async (turn: { sessionId: string; turnId: string; fencingToken: number }) => ({ released: true, ...turn })),
      grantSessionTurn: async () => { throw new Error("deferred turn grants are not under test") },
      revokeSessionTurnGrants: async () => ({ revoked: 0 }),
    }
    const target = app({
      authority,
      turnAuthority,
      env,
      ...(input.resolver === false ? {} : { ownerGrants: createOwnerGrantProof({ env, passes, resolveWorkspaceOwner }) }),
    })
    const grant = (overrides: Partial<typeof scope> = {}, minting: { now?: () => number; ttlSeconds?: number } = {}) =>
      mintOwnerGrant({ ...scope, ...overrides }, env, { register: passes, ...minting })
    const relay = () => mintRelayHostToken(relayInput, relayKey.privateKey, "EdDSA")
    return { env, passes, target, authority, turnAuthority, resolveWorkspaceOwner, grant, relay }
  }

  test("startup uses verified owner claims and requires a reservation operation", async () => {
    const { target, authority, grant } = await fixture()
    const token = (await grant()).token
    expect((await request(target, token, { action: "start", operationId: "op_start", sessionId: "ses_start", actorId: "forged", workspaceId: "forged" })).status).toBe(200)
    expect(authority.authorizeRuntimeSessionStart).toHaveBeenCalledWith({ principalKind: "user", actorId: OWNER.actorId, actorKind: "human", workspaceId: "ws_1", sessionId: "ses_start", registrationOperationId: "op_start" })
    expect((await request(target, token, { action: "start_status", operationId: "op_start", sessionId: "ses_start" })).status).toBe(200)
    expect(authority.authorizeRuntimeSessionStartStatus).toHaveBeenCalledWith({ principalKind: "user", actorId: OWNER.actorId, actorKind: "human", workspaceId: "ws_1", sessionId: "ses_start", registrationOperationId: "op_start" })
    expect((await request(target, token, { action: "start_status", sessionId: "ses_start" })).status).toBe(400)
    expect(authority.registerRuntimeSession).not.toHaveBeenCalled()
    expect(authority.authorizeRuntimeSession).not.toHaveBeenCalled()
    expect((await request(target, token, { action: "start", sessionId: "ses_start" })).status).toBe(400)
    expect((await request(target, undefined, { action: "start", operationId: "op_start", sessionId: "ses_start" })).status).toBe(401)
    expect(authority.authorizeRuntimeSessionStart).toHaveBeenCalledTimes(1)
    authority.authorizeRuntimeSessionStart.mockRejectedValueOnce(new ControlPlaneAuthError(403, "workspace_authorization_denied", "Reservation is no longer live"))
    expect((await request(target, token, { action: "start", operationId: "op_start", sessionId: "ses_start" })).status).toBe(403)
  })

  test("registers, reads and writes as the workspace's owner, re-resolved from the authority on every call and never from the request", async () => {
    const { target, authority, resolveWorkspaceOwner, grant } = await fixture()
    const token = (await grant()).token
    const registered = await request(target, token, {
      action: "register", operationId: "op_child_1", sessionId: "ses_child", title: "Reviewer",
      workspaceId: "attacker_workspace", actorId: "attacker_actor",
    })
    expect(registered.status).toBe(200)
    expect(authority.registerRuntimeSession).toHaveBeenCalledWith({
      ...principal, operationId: "op_child_1", sessionId: "ses_child", workspaceId: "ws_1", title: "Reviewer",
    })
    expect((await request(target, token, { action: "read", sessionId: "ses_parent" })).status).toBe(200)
    expect((await request(target, token, { action: "write", sessionId: "ses_child" })).status).toBe(200)
    expect(authority.authorizeRuntimeSession).toHaveBeenLastCalledWith({ ...principal, sessionId: "ses_child", workspaceId: "ws_1", action: "write" })
    expect(resolveWorkspaceOwner).toHaveBeenCalledTimes(3)
    expect(resolveWorkspaceOwner).toHaveBeenCalledWith("ws_1")
    expect(authority.runtimeAccessTokenActive).not.toHaveBeenCalled()
  })

  test("a grant whose workspace was re-owned, moved to another organization, or deleted is refused at every action", async () => {
    for (const owner of [
      { ...OWNER, userId: "bob", actorId: "actor_bob" },
      { ...OWNER, actorId: "actor_alice_2" },
      { ...OWNER, orgId: "org_2" },
      undefined,
    ]) {
      const { target, authority, grant } = await fixture({ owner: async () => owner })
      const token = (await grant()).token
      for (const body of [
        { action: "register", operationId: "op_1", sessionId: "ses_child" },
        { action: "read", sessionId: "ses_parent" },
        { action: "reserve", sessionId: "ses_child", parentSessionId: "ses_parent" },
        { action: "turn_acquire", sessionId: "ses_child", turnId: "msg_1" },
      ]) {
        const refused = await request(target, token, body)
        expect(refused.status).toBe(401)
        expect(await refused.json()).toEqual({ error: { code: "owner_grant_invalid", message: expect.any(String) } })
      }
      expect(authority.registerRuntimeSession).not.toHaveBeenCalled()
      expect(authority.authorizeRuntimeSession).not.toHaveBeenCalled()
      expect(authority.reserveRuntimeSession).not.toHaveBeenCalled()
    }
  })

  test("refuses a grant signed with another key, a Tasks capability, an expired grant, a revoked one, and every grant on a plane that mints none", async () => {
    const { env, target, authority, resolveWorkspaceOwner, grant, passes } = await fixture()
    const foreignKey = await generateKeyPair("EdDSA", { extractable: true })
    const forged = await mintOwnerGrant(scope, {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(foreignKey.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(foreignKey.publicKey),
    })
    const tasks = await mintTasksCapability({ ...scope, operations: ["read"] }, env)
    const expired = await grant({}, { now: () => Date.now() - 2 * 60 * 60_000, ttlSeconds: 60 })
    const revoked = await grant()
    await passes.revoke({ workspaceId: "ws_1", reason: "subagents_group_disabled" })
    for (const token of [forged.token, tasks.token, expired.token, revoked.token]) {
      const refused = await request(target, token, { action: "read", sessionId: "ses_parent" })
      expect(refused.status).toBe(401)
      const body = await refused.json() as { error: { code: string } }
      expect(["owner_grant_invalid", "relay_host_token_invalid"]).toContain(body.error.code)
    }
    expect(resolveWorkspaceOwner).not.toHaveBeenCalled()
    expect(authority.authorizeRuntimeSession).not.toHaveBeenCalled()

    // A plane composed without owner grants knows no such bearer: it is read as the relay proof it is not.
    const unresolvable = await fixture({ resolver: false })
    const refused = await request(unresolvable.target, (await unresolvable.grant()).token, { action: "read", sessionId: "ses_parent" })
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ error: { code: "relay_host_token_invalid" } })
    expect(unresolvable.authority.authorizeRuntimeSession).not.toHaveBeenCalled()
  })

  test("refuses a reservation that names no parent before any authority is asked", async () => {
    const { target, authority, grant } = await fixture()

    const refused = await request(target, (await grant()).token, { action: "reserve", sessionId: "ses_child" })

    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: { code: "session_authority_request_invalid" } })
    expect(authority.reserveRuntimeSession).not.toHaveBeenCalled()
  })

  test("only an owner grant may reserve, and a plane whose authority cannot reserve says so", async () => {
    const { target, authority, relay } = await fixture()
    const relayed = await request(target, await relay(), { action: "reserve", sessionId: "ses_child", parentSessionId: "ses_parent" })
    expect(relayed.status).toBe(401)
    expect(await relayed.json()).toMatchObject({ error: { code: "session_reservation_requires_owner_grant" } })
    expect(authority.reserveRuntimeSession).not.toHaveBeenCalled()

    const bare = await fixture({ reserve: false })
    const unavailable = await request(bare.target, (await bare.grant()).token, { action: "reserve", sessionId: "ses_child", parentSessionId: "ses_parent" })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ error: { code: "session_registration_unavailable" } })
  })

  test("acquires, renews and releases turns as the owner, and a renewal re-resolves the owner without a bearer", async () => {
    let owner: WorkspaceOwnerIdentity | undefined = OWNER
    const { target, turnAuthority, resolveWorkspaceOwner, grant } = await fixture({ owner: async () => owner })
    const token = (await grant()).token
    const acquired = await request(target, token, { action: "turn_acquire", sessionId: "ses_child", turnId: "msg_1" })
    expect(acquired.status).toBe(200)
    const lease = await acquired.json() as { leaseId: string; fencingToken: number }
    expect(turnAuthority.acquireSessionTurn).toHaveBeenCalledWith({ ...principal, sessionId: "ses_child", workspaceId: "ws_1", turnId: "msg_1" })

    const renew = () => request(target, undefined, { action: "turn_renew", sessionId: "ses_child", turnId: "msg_1", leaseId: lease.leaseId, fencingToken: 2 })
    expect((await renew()).status).toBe(200)
    expect(turnAuthority.renewSessionTurn).toHaveBeenCalledWith({ ...principal, sessionId: "ses_child", workspaceId: "ws_1", turnId: "msg_1", leaseId: "turn_lease_1", fencingToken: 2 })
    expect(resolveWorkspaceOwner).toHaveBeenCalledTimes(2)
    owner = { ...OWNER, actorId: "actor_bob", userId: "bob" }
    const lost = await renew()
    expect(lost.status).toBe(401)
    expect(await lost.json()).toMatchObject({ error: { code: "owner_grant_invalid" } })
    owner = OWNER
    expect((await request(target, undefined, { action: "turn_release", sessionId: "ses_child", turnId: "msg_1", leaseId: lease.leaseId, fencingToken: 2 })).status).toBe(200)
  })

  test("mints stream leases bound to the owner grant and re-resolves the owner at every renewal", async () => {
    let owner: WorkspaceOwnerIdentity | undefined = OWNER
    const { target, resolveWorkspaceOwner, grant } = await fixture({ owner: async () => owner })
    const opened = await request(target, (await grant()).token, { action: "read", sessionId: "ses_child", stream: true })
    expect(opened.status).toBe(200)
    const { lease } = await opened.json() as { lease: string }
    const renew = () => request(target, undefined, { action: "read", sessionId: "ses_child", stream: true, lease })
    expect((await renew()).status).toBe(200)
    expect(resolveWorkspaceOwner).toHaveBeenCalledTimes(2)
    owner = undefined
    const ended = await renew()
    expect(ended.status).toBe(401)
    expect(await ended.json()).toMatchObject({ error: { code: "owner_grant_invalid" } })
  })

  test("a workspace read mints a workspace lease that stands for the reader on any session, renews itself, and ends with its access token", async () => {
    const { target, authority, relay } = await fixture()
    const admitted = await request(target, await relay(), { action: "host_read" })
    expect(admitted.status).toBe(200)
    const { lease, expiresAt } = await admitted.json() as { allowed: true; lease: string; expiresAt: number }
    expect(expiresAt).toBeGreaterThan(Date.now())

    // A session first seen after the relay host token expired: the lease
    // proves the reader, and the session is still authorized on its own.
    const first = await request(target, undefined, { action: "read", sessionId: "ses_late", stream: true, lease })
    expect(first.status).toBe(200)
    expect(authority.authorizeRuntimeSession).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: "ses_late", action: "read" }))
    const sessionLease = (await first.json() as { lease: string }).lease
    // What it hands back is bound to that session, not workspace-wide.
    expect((await request(target, undefined, { action: "read", sessionId: "ses_other", stream: true, lease: sessionLease })).status).toBe(401)
    // Writes are never workspace-wide.
    expect((await request(target, undefined, { action: "write", sessionId: "ses_late", stream: true, lease })).status).toBe(401)

    const renewed = await request(target, undefined, { action: "host_read", lease })
    expect(renewed.status).toBe(200)
    expect((await renewed.json() as { lease: string }).lease).not.toBe(lease)
    // The lease carries no role: administration under it is the access
    // token's current role, asked for at admin.
    expect((await request(target, undefined, { action: "host_admin", lease })).status).toBe(200)
    expect(authority.runtimeAccessTokenActive).toHaveBeenLastCalledWith(expect.objectContaining({ jti: "rat_parent_1", minimumRole: "admin" }))
    authority.runtimeAccessTokenActive.mockResolvedValueOnce({ active: false, code: "runtime_access_token_revoked", reason: "Workspace role was downgraded" })
    expect((await request(target, undefined, { action: "host_admin", lease })).status).toBe(401)

    authority.runtimeAccessTokenActive.mockResolvedValueOnce({ active: false, code: "runtime_access_token_revoked", reason: "revoked" })
    const ended = await request(target, undefined, { action: "host_read", lease })
    expect(ended.status).toBe(401)
    expect(await ended.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })
    expect((await request(target, undefined, { action: "host_read", lease: sessionLease })).status).toBe(401)
  })
})

describe("adopting a session the host already held", () => {
  /**
   * The two adapters reduced to what this route depends on: one row per
   * session naming its creator, and a refusal when the caller is not it.
   * `hostId` is the machine the request came through, which is what the real
   * adapters read the enrollment owner from.
   */
  function adoptingAuthority() {
    const creators = new Map<string, string>()
    const adoptRuntimeSession = vi.fn(async (value: { actorId: string; sessionId: string; workspaceId: string; hostId: string }) => {
      if (value.hostId !== "host_1") {
        throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "This machine does not serve the workspace")
      }
      const held = creators.get(value.sessionId)
      if (held && held !== value.actorId) {
        throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session is already registered to another creator")
      }
      creators.set(value.sessionId, value.actorId)
      return { adopted: !held }
    })
    return {
      creators,
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: vi.fn(async (value: { actorId: string; sessionId: string }) => {
          if (creators.get(value.sessionId) !== value.actorId) {
            throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "denied")
          }
        }),
        runtimeAccessTokenActive: vi.fn(async () => ({ active: true })),
        adoptRuntimeSession,
      },
    }
  }

  async function fixture() {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const { authority, creators } = adoptingAuthority()
    const target = app({ authority, env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) } })
    const token = (role: "owner" | "editor") =>
      mintRelayHostToken({ ...relayInput, role, jti: `rht_${role}` }, key.privateKey, "EdDSA")
    return { target, authority, creators, token }
  }

  test("the machine's owner claims a session the plane has no row for, once, and then reads it", async () => {
    const { target, authority, token } = await fixture()
    const owner = await token("owner")

    const refused = await request(target, owner, { action: "read", sessionId: "ses_local" })
    expect(refused.status).toBe(403)

    const adopted = await request(target, owner, { action: "adopt", sessionId: "ses_local", title: "Before sharing" })
    expect(adopted.status).toBe(200)
    expect(await adopted.json()).toEqual({ allowed: true, adopted: true })
    expect(authority.adoptRuntimeSession).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_1",
      actorKind: "human",
      sessionId: "ses_local",
      workspaceId: "ws_1",
      hostId: "host_1",
      title: "Before sharing",
    })
    // The parent access token is rechecked before anything is written.
    expect(authority.runtimeAccessTokenActive).toHaveBeenCalledWith(expect.objectContaining({ jti: "rat_parent_1" }))

    expect((await request(target, owner, { action: "read", sessionId: "ses_local" })).status).toBe(200)

    const again = await request(target, owner, { action: "adopt", sessionId: "ses_local" })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ allowed: true, adopted: false })
    expect(authority.adoptRuntimeSession).toHaveBeenCalledTimes(2)
  })

  test("a member of the workspace is refused before the authority is asked", async () => {
    const { target, authority, token } = await fixture()

    const refused = await request(target, await token("editor"), { action: "adopt", sessionId: "ses_local" })

    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: "session_adoption_requires_host_owner" } })
    expect(authority.adoptRuntimeSession).not.toHaveBeenCalled()
  })

  test("a session already registered to someone else stays theirs", async () => {
    const { target, creators, token } = await fixture()
    creators.set("ses_someone_elses", "actor_other")

    const refused = await request(target, await token("owner"), { action: "adopt", sessionId: "ses_someone_elses" })

    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
    expect(creators.get("ses_someone_elses")).toBe("actor_other")
  })

  test("neither a stream lease nor an owner grant carries adoption", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const { authority } = adoptingAuthority()
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
    }
    const passes = memorySandboxPassRegister()
    const target = app({
      authority,
      env,
      ownerGrants: createOwnerGrantProof({
        env,
        passes,
        resolveWorkspaceOwner: async () => ({ userId: "user_1", actorId: "actor_1", orgId: "org_1", projectId: "project_1" }),
      }),
    })
    const relayToken = await mintRelayHostToken({ ...relayInput, role: "owner" }, key.privateKey, "EdDSA")
    const opened = await request(target, relayToken, { action: "read", sessionId: "ses_local", stream: true })
    expect(opened.status).toBe(403)

    // A lease is only ever accepted beside `stream`, and `stream` is only ever
    // a read or a write, so a lease has no way to reach adoption at all.
    const withLease = await request(target, undefined, { action: "adopt", sessionId: "ses_local", lease: "anything" })
    expect(withLease.status).toBe(400)
    expect(await withLease.json()).toMatchObject({ error: { code: "session_authority_request_invalid" } })

    const grant = await mintOwnerGrant(
      { userId: "user_1", actorId: "actor_1", orgId: "org_1", projectId: "project_1", workspaceId: "ws_1" },
      env,
      { register: passes },
    )
    const byGrant = await request(target, grant.token, { action: "adopt", sessionId: "ses_local" })
    expect(byGrant.status).toBe(403)
    expect(await byGrant.json()).toMatchObject({ error: { code: "session_adoption_requires_host_owner" } })
    expect(authority.adoptRuntimeSession).not.toHaveBeenCalled()
  })

  test("a plane that records no host enrollments answers that adoption is unavailable", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const target = app({
      authority: {
        ...transitionStubs,
        registerRuntimeSession: async () => ({}),
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    })
    const owner = await mintRelayHostToken({ ...relayInput, role: "owner" }, key.privateKey, "EdDSA")

    const answer = await request(target, owner, { action: "adopt", sessionId: "ses_local" })

    expect(answer.status).toBe(503)
    expect(await answer.json()).toMatchObject({ error: { code: "session_registration_unavailable" } })
  })
})

/**
 * The reservation the route sends for a child session, against a real adapter.
 *
 * Everything else in this file supplies the authority, so nothing else can
 * tell whether the body the route builds is one an adapter accepts. This runs
 * the SQLite twin, and the twins agree on the reservation input through
 * `exerciseRuntimeForkReservationConformance`, which both adapter suites run.
 */
describe("reservation and adoption against a real private-session authority", () => {
  const authorities: Array<{ close(): void }> = []
  const directories: string[] = []

  afterEach(() => {
    for (const store of authorities.splice(0)) store.close()
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
  })

  function auth(subject: string): SignedControlPlaneAuth {
    return {
      mode: "signed",
      token: `token_${subject}`,
      user: {
        subject,
        tokenIdentifier: `https://identity.example.test|${subject}`,
        issuer: "https://identity.example.test",
      },
    }
  }

  async function fixture() {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    }
    const passes = memorySandboxPassRegister()
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-runtime-session-authority-"))
    directories.push(directory)
    const databasePath = path.join(directory, "authority.db")
    const store = createSqliteWorkspaceAuthority({ path: databasePath })
    // The host assignment adoption reads is written by an enrollment flow this
    // route has no part in, so it is seeded through a second handle on the
    // same file rather than stood up here.
    const seed = openAuthorityDb({ path: databasePath })
    authorities.push(store, seed)
    const owner = auth("owner")
    const member = auth("member")
    const me = await store.usersMe(owner) as { org_id: string }
    await store.usersMe(member)
    await store.createCloudWorkspace(owner, { workspaceId: "ws_real", displayName: "Main" })
    const project = seed().prepare(`SELECT project_id FROM workspaces WHERE workspace_id = 'ws_real'`)
      .get() as { project_id: string }
    seed().prepare(`
      INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'editor', 1, 1)
    `).run(project.project_id, member.user.tokenIdentifier)
    seed().prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'member', 1, 1)
      ON CONFLICT (org_id, token_identifier) DO NOTHING
    `).run(me.org_id, member.user.tokenIdentifier)
    const identityOf = (who: SignedControlPlaneAuth) => ({
      userId: who.user.tokenIdentifier,
      actorId: who.user.tokenIdentifier,
      orgId: me.org_id,
      projectId: "project_real",
    })
    const target = app({
      authority: {
        ...store,
        runtimeAccessTokenActive: async () => ({ active: true }),
      },
      turnAuthority: store,
      env: { ...env, CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
      ownerGrants: createOwnerGrantProof({
        env,
        passes,
        // Both people hold this workspace outright here, so the grant's own
        // actor is the owner it re-resolves to; the reservation is refused by
        // the private session, not by the grant.
        resolveWorkspaceOwner: async () => identityOf(owner),
      }),
    })
    const relayToken = (who: SignedControlPlaneAuth, role: "owner" | "editor") => mintRelayHostToken({
      principalKind: "user",
      actorId: who.user.tokenIdentifier,
      actorKind: "human",
      orgId: me.org_id,
      workspaceId: "ws_real",
      hostId: "host_real",
      role,
      backing: "local-worktree",
      jti: `rht_${role}_${who.user.subject}`,
      parentJti: "rat_real",
    }, key.privateKey, "EdDSA")
    const assignHost = (who: SignedControlPlaneAuth) => {
      seed().prepare(`
        INSERT INTO host_workspace_assignments (
          workspace_id, host_id, owner_token_identifier, second_device_open_at, revision, assigned_at, updated_at
        ) VALUES (?, ?, ?, NULL, 1, 1, 1)
        ON CONFLICT (workspace_id) DO UPDATE SET owner_token_identifier = excluded.owner_token_identifier
      `).run("ws_real", "host_real", who.user.tokenIdentifier)
    }
    const grant = async (who: SignedControlPlaneAuth) =>
      (await mintOwnerGrant({ ...identityOf(who), workspaceId: "ws_real" }, env, { register: passes })).token
    const runtime = (who: SignedControlPlaneAuth) => ({
      principalKind: "user" as const,
      actorId: who.user.tokenIdentifier,
      actorKind: "human" as const,
    })
    const turnProducer = (turnId: string) => seed().prepare<unknown[], { actor_id: string }>(
      `SELECT actor_id FROM session_turn_producers WHERE session_id = 'ses_parent' AND turn_id = ?`,
    ).get(turnId)?.actor_id
    return { target, store, owner, member, grant, runtime, relayToken, assignHost, turnProducer }
  }

  test("reserves a child under a parent the owner can read, and the registration it answers with completes", async () => {
    const { target, store, owner, member, grant, runtime } = await fixture()
    await store.reserveSession(owner, {
      operationId: "op_parent",
      sessionId: "ses_parent",
      workspaceId: "ws_real",
      kind: "create",
    })
    await store.registerRuntimeSession({ ...runtime(owner), operationId: "op_parent", sessionId: "ses_parent", workspaceId: "ws_real" })

    const reserved = await request(target, await grant(owner), {
      action: "reserve",
      sessionId: "ses_child",
      parentSessionId: "ses_parent",
      title: "Reviewer",
    })

    expect(reserved.status).toBe(200)
    const body = await reserved.json() as { allowed: boolean; operationId: string }
    expect(body.allowed).toBe(true)
    expect(body.operationId).toMatch(/^session_registration_[0-9a-f-]{36}$/)

    const registered = await request(target, await grant(owner), {
      action: "register",
      operationId: body.operationId,
      sessionId: "ses_child",
      title: "Reviewer",
    })
    expect(registered.status).toBe(200)
    await expect(store.authorizeRuntimeSession({ ...runtime(owner), sessionId: "ses_child", workspaceId: "ws_real", action: "write" }))
      .resolves.toBeUndefined()
    await expect(store.authorizeRuntimeSession({ ...runtime(member), sessionId: "ses_child", workspaceId: "ws_real", action: "read" }))
      .rejects.toThrow()
  })

  test("the machine's owner adopts a session the plane has no row for, and nobody else can", async () => {
    const { target, store, owner, member, runtime, relayToken, assignHost } = await fixture()
    assignHost(owner)

    const refusedBefore = await request(target, await relayToken(owner, "owner"), { action: "read", sessionId: "ses_held_locally" })
    expect(refusedBefore.status).toBe(403)

    const adopted = await request(target, await relayToken(owner, "owner"), {
      action: "adopt",
      sessionId: "ses_held_locally",
      title: "Before sharing",
    })
    expect(adopted.status).toBe(200)
    expect(await adopted.json()).toEqual({ allowed: true, adopted: true })
    expect((await request(target, await relayToken(owner, "owner"), { action: "read", sessionId: "ses_held_locally" })).status).toBe(200)
    await expect(store.authorizeRuntimeSession({ ...runtime(member), sessionId: "ses_held_locally", workspaceId: "ws_real", action: "read" }))
      .rejects.toThrow()

    const again = await request(target, await relayToken(owner, "owner"), { action: "adopt", sessionId: "ses_held_locally" })
    expect(await again.json()).toEqual({ allowed: true, adopted: false })

    // A second person who holds the workspace outright still does not own the
    // machine, and the authority is the one that says so.
    assignHost(owner)
    const impostor = await request(target, await relayToken(member, "owner"), { action: "adopt", sessionId: "ses_also_held_locally" })
    expect(impostor.status).toBe(403)
    expect(await impostor.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
  })

  test("a parent the authority will not show the caller refuses the reservation as a denial, and reserves nothing", async () => {
    const { target, store, owner, grant, runtime } = await fixture()

    // Which parents a caller may fork under is the adapter's decision, proven
    // for a second person's private session by the fork conformance both
    // adapters run; what this asserts is that the adapter's refusal reaches
    // the wire as its own status rather than as a fault.
    const refused = await request(target, await grant(owner), {
      action: "reserve",
      sessionId: "ses_orphan_child",
      parentSessionId: "ses_no_such_parent",
    })

    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
    await expect(store.authorizeRuntimeSession({ ...runtime(owner), sessionId: "ses_orphan_child", workspaceId: "ws_real", action: "read" }))
      .rejects.toThrow()
  })

  test("a grant minted over an owner grant or a Relay Host Token redeems once against the real authority, renews and releases without a bearer, and never replays", async () => {
    const { target, store, owner, member, grant, runtime, relayToken, turnProducer } = await fixture()
    await store.reserveSession(owner, { operationId: "op_parent", sessionId: "ses_parent", workspaceId: "ws_real", kind: "create" })
    await store.registerRuntimeSession({ ...runtime(owner), operationId: "op_parent", sessionId: "ses_parent", workspaceId: "ws_real" })
    const reserved = await request(target, await grant(owner), { action: "reserve", sessionId: "ses_child", parentSessionId: "ses_parent" })
    const { operationId } = await reserved.json() as { operationId: string }
    expect((await request(target, await grant(owner), { action: "register", operationId, sessionId: "ses_child" })).status).toBe(200)

    const minted = await request(target, await grant(owner), {
      action: "turn_grant", sessionId: "ses_parent", intent: "child_completion", subjectSessionId: "ses_child", registrationOperationId: operationId,
    })
    expect(minted.status).toBe(200)
    const wake = await minted.json() as { allowed: true; grant: string; expiresAt: number }
    expect(decodeJwt(wake.grant)).toMatchObject({
      actor_id: owner.user.tokenIdentifier, session_id: "ses_parent", workspace_id: "ws_real", turn_id_prefix: "msg_wake_ses_child_",
    })
    expect(wake.expiresAt).toBeGreaterThan(Date.now())

    const outside = await request(target, undefined, { action: "turn_acquire", sessionId: "ses_parent", turnId: "msg_outside_prefix", grant: wake.grant })
    expect(outside.status).toBe(401)
    expect(await outside.json()).toMatchObject({ error: { code: "session_turn_grant_mismatch" } })
    expect(turnProducer("msg_outside_prefix")).toBeUndefined()

    const acquired = await request(target, undefined, { action: "turn_acquire", sessionId: "ses_parent", turnId: "msg_wake_ses_child_1", grant: wake.grant })
    expect(acquired.status).toBe(200)
    const lease = await acquired.json() as { leaseId: string; fencingToken: number }
    expect(decodeJwt(lease.leaseId)).toMatchObject({ transport: "deferred-grant", actor_id: owner.user.tokenIdentifier, turn_id: "msg_wake_ses_child_1" })
    expect(turnProducer("msg_wake_ses_child_1")).toBe(owner.user.tokenIdentifier)
    const retried = await request(target, undefined, { action: "turn_acquire", sessionId: "ses_parent", turnId: "msg_wake_ses_child_1", grant: wake.grant })
    expect(retried.status).toBe(200)
    expect((await retried.json() as { fencingToken: number }).fencingToken).toBe(lease.fencingToken)

    const owned = { sessionId: "ses_parent", turnId: "msg_wake_ses_child_1", leaseId: lease.leaseId, fencingToken: lease.fencingToken }
    const renewed = await request(target, undefined, { action: "turn_renew", ...owned })
    expect(renewed.status).toBe(200)
    const renewedLease = await renewed.json() as { leaseId: string }
    expect(decodeJwt(renewedLease.leaseId)).toMatchObject({ transport: "deferred-grant" })
    expect((await request(target, undefined, { action: "turn_release", ...owned, leaseId: renewedLease.leaseId })).status).toBe(200)

    for (const turnId of ["msg_wake_ses_child_1", "msg_wake_ses_child_2"]) {
      const replayed = await request(target, undefined, { action: "turn_acquire", sessionId: "ses_parent", turnId, grant: wake.grant })
      expect(replayed.status).toBe(401)
      expect(await replayed.json()).toMatchObject({ error: { code: "session_turn_grant_redeemed" } })
    }
    expect(turnProducer("msg_wake_ses_child_2")).toBeUndefined()

    const queued = await request(target, await relayToken(owner, "editor"), { action: "turn_grant", sessionId: "ses_parent", intent: "queued_prompt", turnId: "msg_q1" })
    expect(queued.status).toBe(200)
    const prompt = await queued.json() as { grant: string }
    expect(decodeJwt(prompt.grant)).toMatchObject({ intent: "queued_prompt", turn_id: "msg_q1" })
    const otherTurn = await request(target, undefined, { action: "turn_acquire", sessionId: "ses_parent", turnId: "msg_q2", grant: prompt.grant })
    expect(otherTurn.status).toBe(401)
    expect(await otherTurn.json()).toMatchObject({ error: { code: "session_turn_grant_mismatch" } })
    const prompted = await request(target, undefined, { action: "turn_acquire", sessionId: "ses_parent", turnId: "msg_q1", grant: prompt.grant })
    expect(prompted.status).toBe(200)
    expect(turnProducer("msg_q1")).toBe(owner.user.tokenIdentifier)

    const stranger = await request(target, await relayToken(member, "editor"), { action: "turn_grant", sessionId: "ses_parent", intent: "queued_prompt", turnId: "msg_m1" })
    expect(stranger.status).toBe(403)
    expect(await stranger.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
  })
})

describe("deferred turn grants over the HTTP oracle", () => {
  const principal = { principalKind: "user" as const, actorId: "actor_1", actorKind: "human" as const }
  const OWNER: WorkspaceOwnerIdentity = { userId: "alice", actorId: "actor_alice", orgId: "org_1", projectId: "project_a" }
  const ownerPrincipal = { principalKind: "user" as const, actorId: "actor_alice", actorKind: "human" as const }

  function grantRow(input: Pick<GrantSessionTurnInput, "sessionId" | "workspaceId" | "actorId" | "intent" | "subjectSessionId" | "turnId">): SessionTurnGrant {
    return {
      grantId: `grant_${input.intent}_${input.actorId}`,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      intent: input.intent,
      ...(input.subjectSessionId ? { subjectSessionId: input.subjectSessionId, turnIdPrefix: childCompletionTurnIdPrefix(input.subjectSessionId) } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60_000,
    }
  }

  async function fixture(input: { turns?: boolean } = {}) {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey),
    }
    const passes = memorySandboxPassRegister()
    const resolveWorkspaceOwner = vi.fn(async (workspaceId: string) => (workspaceId === "ws_1" ? OWNER : undefined))
    const authority = {
      ...transitionStubs,
      registerRuntimeSession: vi.fn(async () => ({})),
      authorizeRuntimeSession: vi.fn(async () => {}),
      runtimeAccessTokenActive: vi.fn(async (): Promise<{ active: boolean; code?: string; reason?: string }> => ({ active: true })),
    }
    const turnAuthority = {
      acquireSessionTurn: vi.fn(async (turn: { sessionId: string; workspaceId: string; turnId: string; grantId?: string }) => ({
        sessionId: turn.sessionId, workspaceId: turn.workspaceId, turnId: turn.turnId,
        leaseId: "turn_lease_1", fencingToken: 3, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      })),
      renewSessionTurn: vi.fn(async (turn: { sessionId: string; workspaceId: string; turnId: string; leaseId: string; fencingToken: number }) => ({
        ...turn, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      })),
      releaseSessionTurn: vi.fn(async (turn: { sessionId: string; turnId: string; fencingToken: number }) => ({ released: true, ...turn })),
      grantSessionTurn: vi.fn(async (value: GrantSessionTurnInput) => grantRow(value)),
      revokeSessionTurnGrants: vi.fn(async () => ({ revoked: 0 })),
    }
    const target = app({
      authority,
      ...(input.turns === false ? {} : { turnAuthority }),
      env,
      ownerGrants: createOwnerGrantProof({ env, passes, resolveWorkspaceOwner }),
    })
    const relay = () => mintRelayHostToken(relayInput, relayKey.privateKey, "EdDSA")
    const owner = async () => (await mintOwnerGrant({ ...OWNER, workspaceId: "ws_1" }, env, { register: passes })).token
    const wakeGrant = (overrides: { sessionId?: string; actorId?: string } = {}, minting: { now?: () => number; expiresAt?: number } = {}) => {
      const row = { ...grantRow({ sessionId: "ses_parent", workspaceId: "ws_1", actorId: "actor_1", intent: "child_completion", subjectSessionId: "ses_child", ...overrides }), ...(minting.expiresAt ? { expiresAt: minting.expiresAt } : {}) }
      const who = overrides.actorId ? { ...principal, actorId: overrides.actorId } : principal
      return mintDeferredTurnGrant(deferredTurnGrantClaims(who, "org_1", row), env, minting.now ? { now: minting.now } : {}).then((minted) => ({ ...minted, row }))
    }
    const calls = () => ({
      acquire: turnAuthority.acquireSessionTurn.mock.calls.length,
      grant: turnAuthority.grantSessionTurn.mock.calls.length,
      renew: turnAuthority.renewSessionTurn.mock.calls.length,
      release: turnAuthority.releaseSessionTurn.mock.calls.length,
      authorize: authority.authorizeRuntimeSession.mock.calls.length,
      register: authority.registerRuntimeSession.mock.calls.length,
    })
    return { env, key, target, authority, turnAuthority, resolveWorkspaceOwner, relay, owner, wakeGrant, calls }
  }

  test("mints a child-completion grant over a Relay Host Token: the token's actor and workspace, never the body's, and only while the parent token is active", async () => {
    const { env, target, authority, turnAuthority, relay } = await fixture()
    const response = await request(target, await relay(), {
      sessionId: "ses_parent", action: "turn_grant", intent: "child_completion",
      subjectSessionId: "ses_child", registrationOperationId: "op_child",
      actorId: "attacker_actor", workspaceId: "attacker_workspace",
    })
    expect(response.status).toBe(200)
    expect(turnAuthority.grantSessionTurn).toHaveBeenCalledWith({
      ...principal, sessionId: "ses_parent", workspaceId: "ws_1", intent: "child_completion", subjectSessionId: "ses_child", registrationOperationId: "op_child",
    })
    const row = await turnAuthority.grantSessionTurn.mock.results[0].value
    const body = await response.json() as { allowed: boolean; grant: string; expiresAt: number }
    expect(body).toEqual({ allowed: true, grant: expect.any(String), expiresAt: row.expiresAt })
    expect(decodeJwt(body.grant)).toEqual({
      iss: DEFERRED_TURN_GRANT_ISSUER,
      aud: DEFERRED_TURN_GRANT_AUDIENCE,
      jti: row.grantId,
      principal_kind: "user",
      actor_id: "actor_1",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      session_id: "ses_parent",
      intent: "child_completion",
      subject_session_id: "ses_child",
      turn_id_prefix: "msg_wake_ses_child_",
      iat: expect.any(Number),
      exp: Math.floor(row.expiresAt / 1_000),
    })
    await expect(verifyDeferredTurnGrant(body.grant, env, { sessionId: "ses_parent" })).resolves.toMatchObject({ grantId: row.grantId })

    authority.runtimeAccessTokenActive.mockResolvedValueOnce({ active: false, code: "runtime_access_token_revoked", reason: "revoked" })
    const revoked = await request(target, await relay(), { sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "msg_q1" })
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })
    expect(turnAuthority.grantSessionTurn).toHaveBeenCalledTimes(1)
  })

  test("mints a queued-prompt grant over an owner grant, re-resolved against the workspace's owner at mint time", async () => {
    const { target, turnAuthority, resolveWorkspaceOwner, owner } = await fixture()
    const response = await request(target, await owner(), { sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "msg_q1" })
    expect(response.status).toBe(200)
    expect(turnAuthority.grantSessionTurn).toHaveBeenCalledWith({ ...ownerPrincipal, sessionId: "ses_parent", workspaceId: "ws_1", intent: "queued_prompt", turnId: "msg_q1" })
    const body = await response.json() as { grant: string }
    expect(decodeJwt(body.grant)).toMatchObject({ actor_id: "actor_alice", intent: "queued_prompt", turn_id: "msg_q1" })
    expect(decodeJwt(body.grant)).not.toHaveProperty("turn_id_prefix")

    resolveWorkspaceOwner.mockResolvedValueOnce({ ...OWNER, actorId: "actor_bob", userId: "bob" })
    const reowned = await request(target, await owner(), { sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "msg_q2" })
    expect(reowned.status).toBe(401)
    expect(await reowned.json()).toMatchObject({ error: { code: "owner_grant_invalid" } })
    expect(turnAuthority.grantSessionTurn).toHaveBeenCalledTimes(1)
  })

  test("a grant and no bearer acquires a lease bound to deferred-grant, and that lease renews and releases like any other turn lease", async () => {
    const { target, authority, turnAuthority, resolveWorkspaceOwner, wakeGrant } = await fixture()
    const { grant, row } = await wakeGrant()
    const acquired = await request(target, undefined, { sessionId: "ses_parent", action: "turn_acquire", turnId: "msg_wake_ses_child_1", grant })
    expect(acquired.status).toBe(200)
    expect(turnAuthority.acquireSessionTurn).toHaveBeenCalledWith({
      ...principal, sessionId: "ses_parent", workspaceId: "ws_1", turnId: "msg_wake_ses_child_1", grantId: row.grantId,
    })
    const lease = await acquired.json() as { leaseId: string; fencingToken: number; connectionCredential?: string }
    expect(lease.fencingToken).toBe(3)
    expect(decodeJwt(lease.leaseId)).toMatchObject({
      aud: "workspace-runtime-session-turn",
      transport: "deferred-grant",
      grant_id: row.grantId,
      actor_id: "actor_1",
      session_id: "ses_parent",
      turn_id: "msg_wake_ses_child_1",
      authority_lease_id: "turn_lease_1",
    })
    expect(authority.runtimeAccessTokenActive).not.toHaveBeenCalled()
    expect(resolveWorkspaceOwner).not.toHaveBeenCalled()

    const owned = { sessionId: "ses_parent", turnId: "msg_wake_ses_child_1", leaseId: lease.leaseId, fencingToken: 3 }
    const renewed = await request(target, undefined, { action: "turn_renew", ...owned })
    expect(renewed.status).toBe(200)
    expect(turnAuthority.renewSessionTurn).toHaveBeenCalledWith({
      ...principal, sessionId: "ses_parent", workspaceId: "ws_1", turnId: "msg_wake_ses_child_1", leaseId: "turn_lease_1", fencingToken: 3,
    })
    const renewedLease = await renewed.json() as { leaseId: string }
    expect(decodeJwt(renewedLease.leaseId)).toMatchObject({ transport: "deferred-grant", grant_id: row.grantId })
    expect((await request(target, undefined, { action: "turn_release", ...owned, leaseId: renewedLease.leaseId })).status).toBe(200)
    expect(turnAuthority.releaseSessionTurn).toHaveBeenCalledWith({
      ...principal, sessionId: "ses_parent", workspaceId: "ws_1", turnId: "msg_wake_ses_child_1", leaseId: "turn_lease_1", fencingToken: 3,
    })
    expect(authority.runtimeAccessTokenActive).not.toHaveBeenCalled()
    expect(resolveWorkspaceOwner).not.toHaveBeenCalled()
  })

  test("refuses a grant from another key, under another audience, for another session, expired, malformed, or beside a bearer, and admits nothing", async () => {
    const { env, target, turnAuthority, relay, wakeGrant, calls } = await fixture()
    const foreign = await fixture()
    const acquire = (grant: string, token?: string) =>
      request(target, token, { sessionId: "ses_parent", action: "turn_acquire", turnId: "msg_wake_ses_child_1", grant })
    const refused = async (response: Response, status: number, code: string) => {
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
    }
    const signingKey = await importPKCS8(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM, "EdDSA")
    const { iss: _iss, aud: _aud, iat, exp, ...claims } = decodeJwt((await wakeGrant()).grant)
    const turnLeaseAudienceGrant = await new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA" }).setIssuer(DEFERRED_TURN_GRANT_ISSUER).setAudience("workspace-runtime-session-turn")
      .setIssuedAt(iat).setExpirationTime(exp!).sign(signingKey)

    await refused(await acquire((await foreign.wakeGrant()).grant), 401, "session_turn_grant_invalid")
    await refused(await acquire(turnLeaseAudienceGrant), 401, "session_turn_grant_invalid")
    await refused(await acquire((await wakeGrant({ sessionId: "ses_other" })).grant), 401, "session_turn_grant_mismatch")
    const hourAgo = Date.now() - 60 * 60_000
    await refused(await acquire((await wakeGrant({}, { now: () => hourAgo - 60 * 60_000, expiresAt: hourAgo })).grant), 401, "session_turn_grant_expired")
    await refused(await acquire("not.a.grant"), 401, "session_turn_grant_invalid")
    await refused(await acquire((await wakeGrant()).grant, await relay()), 400, "session_turn_grant_invalid")
    expect(calls().acquire).toBe(0)

    turnAuthority.acquireSessionTurn.mockRejectedValueOnce(new SessionTurnGrantError("session_turn_grant_redeemed", "already redeemed"))
    await refused(await acquire((await wakeGrant()).grant), 401, "session_turn_grant_redeemed")
    turnAuthority.acquireSessionTurn.mockRejectedValueOnce(new SessionTurnGrantError("session_turn_grant_mismatch", "outside the prefix"))
    await refused(await acquire((await wakeGrant()).grant), 401, "session_turn_grant_mismatch")
    expect(turnAuthority.renewSessionTurn).not.toHaveBeenCalled()
  })

  test("a grant proves turn_acquire and nothing else, and a deferred-grant turn lease is not a stream lease", async () => {
    const { target, relay, wakeGrant, calls } = await fixture()
    const { grant } = await wakeGrant()
    const before = calls()
    const bodies: Record<string, unknown>[] = [
      { action: "turn_renew", turnId: "msg_wake_ses_child_1", leaseId: "x", fencingToken: 3 },
      { action: "turn_release", turnId: "msg_wake_ses_child_1", leaseId: "x", fencingToken: 3 },
      { action: "turn_grant", intent: "queued_prompt", turnId: "msg_q1" },
      { action: "read" },
      { action: "write" },
      { action: "read", stream: true },
      { action: "write", stream: true },
      { action: "register", operationId: "op_1" },
      { action: "start", operationId: "op_1" },
      { action: "adopt" },
    ]
    for (const body of bodies) {
      for (const token of [undefined, await relay()]) {
        const response = await request(target, token, { sessionId: "ses_parent", ...body, grant })
        expect(response.status, JSON.stringify(body)).toBe(400)
        expect(await response.json()).toMatchObject({ error: { code: "session_authority_request_invalid" } })
      }
    }
    expect(calls()).toEqual(before)

    const acquired = await request(target, undefined, { sessionId: "ses_parent", action: "turn_acquire", turnId: "msg_wake_ses_child_1", grant })
    const { leaseId } = await acquired.json() as { leaseId: string }
    const asStream = await request(target, undefined, { sessionId: "ses_parent", action: "write", stream: true, lease: leaseId })
    expect(asStream.status).toBe(401)
    expect(await asStream.json()).toMatchObject({ error: { code: "session_stream_lease_invalid" } })

    const stream = await request(target, await relay(), { sessionId: "ses_parent", action: "read", stream: true })
    expect(stream.status).toBe(200)
    const { lease } = await stream.json() as { lease: string }
    expect(decodeJwt(lease)).toMatchObject({ aud: "workspace-runtime-session-stream", transport: "relay-host" })
    expect(decodeJwt(lease)).not.toHaveProperty("grant_id")
    expect((await request(target, undefined, { sessionId: "ses_parent", action: "read", stream: true, lease })).status).toBe(200)
  })

  test("turn_grant validates its body before any proof, needs a proof, and is bounded by the body limit", async () => {
    const { target, turnAuthority, relay } = await fixture()
    const token = await relay()
    for (const body of [
      { intent: "queued_prompt" },
      { intent: "child_completion", subjectSessionId: "ses_child" },
      { intent: "child_completion", registrationOperationId: "op_child" },
      { intent: "anything", turnId: "msg_q1" },
      { turnId: "msg_q1" },
      { intent: "queued_prompt", turnId: "msg_q1", leaseId: "x", fencingToken: 3 },
      { intent: "child_completion", subjectSessionId: " ", registrationOperationId: "op_child" },
    ]) {
      const response = await request(target, token, { sessionId: "ses_parent", action: "turn_grant", ...body })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    expect((await request(target, undefined, { sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "msg_q1" })).status).toBe(401)
    const oversized = await target.request("/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": String(17 * 1024) },
      body: JSON.stringify({ sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "x".repeat(17 * 1024) }),
    })
    expect(oversized.status).toBe(413)
    expect(turnAuthority.grantSessionTurn).not.toHaveBeenCalled()
  })

  test("the authority's refusal to mint, and a plane with no turn authority, reach the wire as their own answers", async () => {
    const { target, turnAuthority, relay } = await fixture()
    turnAuthority.grantSessionTurn.mockRejectedValueOnce(new ControlPlaneAuthError(403, "workspace_authorization_denied", "not a send grantee"))
    const denied = await request(target, await relay(), { sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "msg_q1" })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: "workspace_authorization_denied" } })
    turnAuthority.grantSessionTurn.mockRejectedValueOnce(new SessionTurnGrantError("session_turn_grant_mismatch", "not the child's creator"))
    const mismatch = await request(target, await relay(), {
      sessionId: "ses_parent", action: "turn_grant", intent: "child_completion", subjectSessionId: "ses_child", registrationOperationId: "op_child",
    })
    expect(mismatch.status).toBe(403)
    expect(await mismatch.json()).toMatchObject({ error: { code: "session_turn_grant_mismatch" } })

    const bare = await fixture({ turns: false })
    const unavailable = await request(bare.target, await bare.relay(), { sessionId: "ses_parent", action: "turn_grant", intent: "queued_prompt", turnId: "msg_q1" })
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ error: { code: "session_turn_authority_unavailable" } })
  })
})
