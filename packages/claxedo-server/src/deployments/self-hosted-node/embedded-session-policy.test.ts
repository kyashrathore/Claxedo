import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { embeddedManagedPrivateSessionPolicy } from "./app"

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

function authorityStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    registerRuntimeSession: async () => ({}),
    markSessionRegistrationAmbiguous: async () => ({}),
    beginSessionCompensation: async () => ({}),
    completeSessionCompensation: async () => ({}),
    authorizeRuntimeSession: async () => {},
    runtimeAccessTokenActive: async () => ({ active: true }),
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

  test("requires verified actor claims before issuing a lease", async () => {
    const policy = embeddedManagedPrivateSessionPolicy(authorityStub())
    const { actor: _actor, ...actorless } = input

    await expect(policy.authorizeStream!(actorless)).resolves.toMatchObject({
      allowed: false,
      status: 403,
      code: "session_actor_required",
    })
  })
})
