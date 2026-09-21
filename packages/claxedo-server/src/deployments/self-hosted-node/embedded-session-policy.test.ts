import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  childCompletionTurnIdPrefix,
  SessionTurnGrantError,
  type GrantSessionTurnInput,
  type SessionTurnGrant,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { embeddedManagedPrivateSessionPolicy } from "./app"
import { createConnectionTurnCredentials } from "../../connections/turn-credentials"
import { deferredTurnGrantClaims, mintDeferredTurnGrant, verifyDeferredTurnGrant } from "../../session/deferred-turn-grant"

/**
 * The embedded workspace runtime asks its policy for a stream lease before it
 * hands a managed terminal its agent-hook callback token. The self-hosted
 * composition answers that in process through the same owner
 * `POST /api/runtime-authority/session-authorize` serves to isolated runtimes.
 */

const previous = {
  privateKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM,
  publicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
}

beforeAll(async () => {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = await exportPKCS8(key.privateKey)
  process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(key.publicKey)
})

afterAll(() => {
  for (const [name, value] of [
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM", previous.privateKey],
    ["CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", previous.publicKey],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const input = {
  actor: { actorId: "actor_alice", actorKind: "human" as const },
  authority: { managed: true as const, workspaceId: "ws_1", orgId: "org_1", role: "editor" as const },
  operation: "agent_lifecycle_write" as const,
  sessionId: "ses_private",
}

const turnLease = {
  sessionId: "ses_private",
  workspaceId: "ws_1",
  turnId: "msg_1",
  leaseId: "lease_1",
  fencingToken: 7,
  acquiredAt: 1,
  expiresAt: Date.now() + 60_000,
}

// The turn half is not optional decoration: declaring `managed-private` is what
// switches the runtime's durable prompt admission on, so a stub without these
// composes a policy that can authorize a turn and then refuse to admit it.
function authorityStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    authorizeRuntimeSessionStartStatus: async () => {},
    authorizeRuntimeSessionStart: async () => {},
    registerRuntimeSession: async () => ({}),
    markSessionRegistrationAmbiguous: async () => ({}),
    beginSessionCompensation: async () => ({}),
    completeSessionCompensation: async () => ({}),
    authorizeRuntimeSession: async () => {},
    runtimeAccessTokenActive: async () => ({ active: true }),
    acquireSessionTurn: async () => turnLease,
    renewSessionTurn: async () => turnLease,
    releaseSessionTurn: async () => ({ released: true, sessionId: turnLease.sessionId, turnId: turnLease.turnId, fencingToken: turnLease.fencingToken }),
    grantSessionTurn: async () => { throw new Error("deferred turn grants are not under test") },
    revokeSessionTurnGrants: async () => ({ revoked: 0 }),
    ...overrides,
  } as unknown as WorkspaceAuthority
}

describe("embeddedManagedPrivateSessionPolicy", () => {
  test("authorizes a session stream and issues a lease its renewal can present", async () => {
    const authorizeRuntimeSession = vi.fn(async () => {})
    const runtimeAccessTokenActive = vi.fn(async () => ({ active: true }))
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({
      authorizeRuntimeSession,
      runtimeAccessTokenActive,
    }))

    expect(policy.sessionAuthority).toBe("managed-private")
    const first = await policy.authorizeStream!(input)
    expect(first.allowed).toBe(true)
    if (!first.allowed) throw new Error("unreachable")
    expect(first.expiresAt).toBeGreaterThan(Date.now())
    expect(authorizeRuntimeSession).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_alice",
      actorKind: "human",
      sessionId: "ses_private",
      workspaceId: "ws_1",
      action: "write",
    })
    // An embedded runtime holds no Relay Host Token chain, so there is no
    // parent Runtime Access Token to re-check.
    expect(runtimeAccessTokenActive).not.toHaveBeenCalled()

    const renewed = await policy.authorizeStream!(input, first.lease)
    expect(renewed.allowed).toBe(true)
    expect(authorizeRuntimeSession).toHaveBeenCalledTimes(2)
  })

  test("refuses a renewal whose lease belongs to another session", async () => {
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub())
    const issued = await policy.authorizeStream!(input)
    if (!issued.allowed) throw new Error("unreachable")

    await expect(policy.authorizeStream!({ ...input, sessionId: "ses_other" }, issued.lease))
      .resolves.toMatchObject({ allowed: false, status: 401, code: "session_stream_lease_invalid" })
  })

  test("ends the stream when the private-session authority revokes the participant", async () => {
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({
      authorizeRuntimeSession: async () => {
        throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "participant revoked")
      },
    }))

    await expect(policy.authorizeStream!(input)).resolves.toMatchObject({
      allowed: false,
      status: 403,
      code: "workspace_authorization_denied",
    })
  })

  // The gap this pins: a managed-private policy that declares itself managed
  // turns on the runtime's durable prompt admission (`acquireManagedPromptLease`,
  // workspace-runtime routes/session-core.ts), and a policy with no turn
  // callbacks answers every prompt 503 `session_turn_authority_unavailable` —
  // a machine-placed host that can authorize a turn and never run one.
  test("admits a turn through the same owner the HTTP oracle serves", async () => {
    const acquireSessionTurn = vi.fn(async () => turnLease)
    const releaseSessionTurn = vi.fn(async () => ({
      released: true,
      sessionId: turnLease.sessionId,
      turnId: turnLease.turnId,
      fencingToken: turnLease.fencingToken,
    }))
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ acquireSessionTurn, releaseSessionTurn }))

    const turnInput = { ...input, operation: "prompt" as const, turnId: "msg_1" }
    await expect(policy.acquireTurn!(turnInput)).resolves.toMatchObject({
      allowed: true,
      turnId: "msg_1",
      leaseId: "lease_1",
      fencingToken: 7,
    })
    expect(acquireSessionTurn).toHaveBeenCalledWith({
      principalKind: "user",
      actorId: "actor_alice",
      actorKind: "human",
      sessionId: "ses_private",
      workspaceId: "ws_1",
      turnId: "msg_1",
    })

    await expect(policy.releaseTurn!({ ...turnInput, leaseId: "lease_1", fencingToken: 7 }))
      .resolves.toMatchObject({ released: true })
    expect(releaseSessionTurn).toHaveBeenCalledTimes(1)
  })

  test("mints a connection credential at admission, bound to the actor's user partition, and ends it with the turn", async () => {
    const turns = createConnectionTurnCredentials()
    const resolveRuntimeMachineAccess = vi.fn(async () => ({
      actorId: "actor_alice",
      actorKind: "human" as const,
      orgId: "org_1",
      role: "owner" as const,
      userId: "alice",
    }))
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ resolveRuntimeMachineAccess }), turns)
    const turnInput = { ...input, operation: "prompt" as const, turnId: "msg_1" }

    const acquired = await policy.acquireTurn!(turnInput)
    expect(acquired).toMatchObject({ allowed: true, leaseId: "lease_1" })
    if (!acquired.allowed) throw new Error("unreachable")
    expect(acquired.connectionCredential).toBeDefined()
    // The mint binds the session and the ACTOR'S user-scoped partition — the
    // subject a connections row names as `owner` — resolved through the
    // authority, never decoded from the request.
    expect(resolveRuntimeMachineAccess).toHaveBeenCalledWith("actor_alice", "ws_1", "viewer")
    expect(turns.resolve(acquired.connectionCredential)).toEqual({
      sessionId: "ses_private",
      subject: "alice",
      orgId: "org_1",
    })

    // Renewal keeps the same credential and carries it to the renewed deadline.
    const renewed = await policy.renewTurn!({ ...turnInput, leaseId: "lease_1", fencingToken: 7 })
    expect(renewed).toMatchObject({ allowed: true, connectionCredential: acquired.connectionCredential })

    // Release revokes: the credential outlives the turn by nothing.
    await policy.releaseTurn!({ ...turnInput, leaseId: "lease_1", fencingToken: 7 })
    expect(turns.resolve(acquired.connectionCredential)).toBeUndefined()
    turns.dispose()
  })

  test("a turn credential dies at the lease deadline even without release", async () => {
    const turns = createConnectionTurnCredentials()
    const expired = { ...turnLease, leaseId: "lease_dead", expiresAt: Date.now() - 1 }
    const policy = embeddedManagedPrivateSessionPolicy(
      authorityStub({ acquireSessionTurn: async () => expired }),
      turns,
    )
    const acquired = await policy.acquireTurn!({ ...input, operation: "prompt", turnId: "msg_1" })
    expect(acquired).toMatchObject({ allowed: true })
    if (!acquired.allowed) throw new Error("unreachable")
    expect(acquired.connectionCredential).toBeDefined()
    expect(turns.resolve(acquired.connectionCredential)).toBeUndefined()
    turns.dispose()
  })

  test("a service principal's turn mints a session-bound credential with no personal partition", async () => {
    const turns = createConnectionTurnCredentials()
    const resolveRuntimeMachineAccess = vi.fn()
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ resolveRuntimeMachineAccess }), turns)
    const agentInput = {
      ...input,
      actor: { actorId: "actor_agent", actorKind: "agent" as const },
      operation: "prompt" as const,
      turnId: "msg_1",
    }
    const acquired = await policy.acquireTurn!(agentInput)
    expect(acquired).toMatchObject({ allowed: true })
    if (!acquired.allowed) throw new Error("unreachable")
    expect(resolveRuntimeMachineAccess).not.toHaveBeenCalled()
    expect(turns.resolve(acquired.connectionCredential)).toEqual({
      sessionId: "ses_private",
      orgId: "org_1",
    })
    turns.dispose()
  })

  test("refuses turn admission without verified actor claims", async () => {
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub())
    const { actor: _actor, ...actorless } = input

    await expect(policy.acquireTurn!({ ...actorless, operation: "prompt", turnId: "msg_1" }))
      .resolves.toMatchObject({ allowed: false, status: 403, code: "session_actor_required" })
  })

  test("requires verified actor claims before issuing a lease", async () => {
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub())
    const { actor: _actor, ...actorless } = input

    await expect(policy.authorizeStream!(actorless)).resolves.toMatchObject({
      allowed: false,
      status: 403,
      code: "session_actor_required",
    })
  })

  const wakeRow = (value: Pick<GrantSessionTurnInput, "sessionId" | "workspaceId" | "actorId" | "intent" | "subjectSessionId" | "turnId">): SessionTurnGrant => ({
    grantId: "grant_1",
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    actorId: value.actorId,
    intent: value.intent,
    ...(value.subjectSessionId ? { subjectSessionId: value.subjectSessionId, turnIdPrefix: childCompletionTurnIdPrefix(value.subjectSessionId) } : {}),
    ...(value.turnId ? { turnId: value.turnId } : {}),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60 * 60_000,
  })

  test("mints a deferred grant in process for the verified embedded principal, signed as the HTTP oracle signs it", async () => {
    const grantSessionTurn = vi.fn(async (value: GrantSessionTurnInput) => wakeRow(value))
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ grantSessionTurn }))

    const decision = await policy.grantTurn!({
      ...input, operation: "prompt", intent: "child_completion", subjectSessionId: "ses_child", registrationOperationId: "op_child",
      actor: { ...input.actor }, authority: { ...input.authority, workspaceId: "ws_1" },
    })
    if (!decision.allowed) throw new Error(decision.code)
    expect(grantSessionTurn).toHaveBeenCalledWith({
      principalKind: "user", actorId: "actor_alice", actorKind: "human",
      sessionId: "ses_private", workspaceId: "ws_1", intent: "child_completion", subjectSessionId: "ses_child", registrationOperationId: "op_child",
    })
    expect(decision.expiresAt).toBe((await grantSessionTurn.mock.results[0].value).expiresAt)
    await expect(verifyDeferredTurnGrant(decision.grant, process.env, { sessionId: "ses_private" })).resolves.toMatchObject({
      grantId: "grant_1", actorId: "actor_alice", orgId: "org_1", workspaceId: "ws_1", intent: "child_completion", turnIdPrefix: "msg_wake_ses_child_",
    })

    const { actor: _actor, ...actorless } = input
    await expect(policy.grantTurn!({ ...actorless, operation: "prompt", intent: "queued_prompt", turnId: "msg_q1" }))
      .resolves.toMatchObject({ allowed: false, status: 403, code: "workspace_authorization_denied" })
    grantSessionTurn.mockRejectedValueOnce(new SessionTurnGrantError("session_turn_grant_mismatch", "not the child's creator"))
    await expect(policy.grantTurn!({ ...input, operation: "prompt", intent: "child_completion", subjectSessionId: "ses_child", registrationOperationId: "op_other" }))
      .resolves.toMatchObject({ allowed: false, status: 403, code: "session_turn_grant_mismatch" })
  })

  test("redeems a grant in process: the row id reaches the authority, and a grant for another session or from another key admits nothing", async () => {
    const acquireSessionTurn = vi.fn(async () => turnLease)
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ acquireSessionTurn }))
    const principal = { principalKind: "user" as const, actorId: "actor_alice", actorKind: "human" as const }
    const mint = (sessionId: string, env: Record<string, string | undefined> = process.env) =>
      mintDeferredTurnGrant(deferredTurnGrantClaims(principal, "org_1", wakeRow({ sessionId, workspaceId: "ws_1", actorId: "actor_alice", intent: "queued_prompt", turnId: "msg_1" })), env)

    const { grant } = await mint("ses_private")
    await expect(policy.acquireTurn!({ ...input, operation: "prompt", turnId: "msg_1", grant })).resolves.toMatchObject({ allowed: true, leaseId: "lease_1" })
    expect(acquireSessionTurn).toHaveBeenCalledWith({
      principalKind: "user", actorId: "actor_alice", actorKind: "human", sessionId: "ses_private", workspaceId: "ws_1", turnId: "msg_1", grantId: "grant_1",
    })

    const other = await generateKeyPair("EdDSA", { extractable: true })
    const foreign = await mint("ses_private", {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(other.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(other.publicKey),
    })
    await expect(policy.acquireTurn!({ ...input, operation: "prompt", turnId: "msg_1", grant: foreign.grant }))
      .resolves.toMatchObject({ allowed: false, status: 401, code: "session_turn_grant_invalid" })
    await expect(policy.acquireTurn!({ ...input, operation: "prompt", turnId: "msg_1", grant: (await mint("ses_other")).grant }))
      .resolves.toMatchObject({ allowed: false, status: 401, code: "session_turn_grant_mismatch" })
    expect(acquireSessionTurn).toHaveBeenCalledTimes(1)
  })
})


test("startup calls reservation authority with the verified embedded principal", async () => {
  const authorizeRuntimeSessionStart = vi.fn(async () => {})
  const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ authorizeRuntimeSessionStart }))
  expect(await policy.authorizeSessionStart({ ...input, registrationOperationId: "op_start" })).toEqual({ allowed: true })
  expect(authorizeRuntimeSessionStart).toHaveBeenCalledWith({ principalKind: "user", actorKind: "human", actorId: "actor_alice", workspaceId: "ws_1", sessionId: "ses_private", registrationOperationId: "op_start" })
})


test("startup status uses the separate read-only reservation authority", async () => {
  const authorizeRuntimeSessionStartStatus = vi.fn(async () => {})
  const policy = embeddedManagedPrivateSessionPolicy(authorityStub({ authorizeRuntimeSessionStartStatus }))
  expect(await policy.authorizeSessionStartStatus({ ...input, operation: "session_meta_read", registrationOperationId: "op_start" })).toEqual({ allowed: true })
  expect(authorizeRuntimeSessionStartStatus).toHaveBeenCalledWith({ principalKind: "user", actorKind: "human", actorId: "actor_alice", workspaceId: "ws_1", sessionId: "ses_private", registrationOperationId: "op_start" })
})
