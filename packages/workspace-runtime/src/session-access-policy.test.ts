import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  createWorkspaceRuntimeExposureMiddleware,
  embeddedWorkspaceRuntimeExposure,
  EMBEDDED_RELAY_HOST_AUTH_HEADER,
} from "./exposure"
import {
  managedWorkspaceSessionAccessPolicy,
  sessionAccessContext,
  sessionAccessWriteClass,
  sessionRequestProvenance,
  type ManagedSessionAuthority,
  type SessionAccessPolicyInput,
} from "./session-access-policy"
import { createRelayHostAuthMiddleware } from "./workspace-host-service-auth"

function allowAll(): ManagedSessionAuthority {
  return {
    authorizeSessionRead: () => true,
    authorizeSessionWrite: () => true,
    authorizeSessionStream: () => ({ allowed: true, lease: "lease_1", expiresAt: Date.now() + 15_000 }),
    registerSession: () => true,
    acquireTurn: (input) => ({
      allowed: true,
      turnId: input.turnId,
      leaseId: "turn_lease_1",
      fencingToken: 1,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 15_000,
    }),
    renewTurn: (input) => ({
      allowed: true,
      turnId: input.turnId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken + 1,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 15_000,
    }),
    releaseTurn: () => ({ released: true }),
  }
}

const authority = {
  managed: true as const,
  workspaceId: "ws_1",
  orgId: "org_1",
  role: "editor" as const,
}

describe("SessionAccessPolicy", () => {
  test("denies actor-less and authority-less managed session access", async () => {
    const policy = managedWorkspaceSessionAccessPolicy()
    const input = {
      authority,
      operation: "session_meta_read" as const,
      sessionId: "ses_1",
    }

    await expect(policy.authorize(input)).resolves.toMatchObject({
      allowed: false,
      code: "session_actor_required",
      status: 403,
    })
    await expect(policy.authorize({
      ...input,
      actor: { actorId: "actor_1", actorKind: "human" },
    })).resolves.toMatchObject({ allowed: false, code: "session_authority_required" })
  })

  test("keeps unsigned local access an explicit policy decision", async () => {
    await expect(managedWorkspaceSessionAccessPolicy().authorize({
      operation: "session_meta_read",
      sessionId: "ses_1",
    })).resolves.toEqual({ allowed: true })
  })

  test("filters actor-less managed collections instead of authorizing the whole list", async () => {
    const policy = managedWorkspaceSessionAccessPolicy({ authority: allowAll() })
    const input: SessionAccessPolicyInput = {
      authority,
      operation: "session_list",
    }

    await expect(policy.filterSessions({ ...input, sessionIds: ["ses_1", "ses_2"] })).resolves.toEqual([])
    await expect(policy.filterSessions({
      ...input,
      actor: { actorId: "actor_1", actorKind: "human" },
      sessionIds: ["ses_1", "ses_2"],
    })).resolves.toEqual(["ses_1", "ses_2"])
  })

  test("lets the session authority answer for a workspace viewer and keeps workspace writes on the role", async () => {
    const asked: string[] = []
    const policy = managedWorkspaceSessionAccessPolicy({
      authority: {
        ...allowAll(),
        authorizeSessionWrite: (input) => {
          asked.push(`write:${input.operation}`)
          return true
        },
      },
    })
    const viewer = { ...authority, role: "viewer" as const }
    const actor = { actorId: "actor_1", actorKind: "human" as const }

    await expect(policy.authorize({
      authority: viewer,
      actor,
      operation: "prompt",
      sessionId: "ses_1",
    })).resolves.toEqual({ allowed: true })
    expect(asked).toEqual(["write:prompt"])

    await expect(policy.authorize({
      authority: viewer,
      actor,
      operation: "session_meta_read",
      sessionId: "ses_1",
    })).resolves.toEqual({ allowed: true })

    await expect(policy.authorize({
      authority: viewer,
      actor,
      operation: "checkpoint_write",
    })).resolves.toMatchObject({ allowed: false, code: "workspace_write_forbidden", status: 403 })
    await expect(policy.authorize({
      authority,
      actor,
      operation: "checkpoint_write",
    })).resolves.toEqual({ allowed: true })
  })

  test("puts every goal mutation on the write authority as session control, whatever the rank", async () => {
    const seen: string[] = []
    const policy = managedWorkspaceSessionAccessPolicy({
      authority: {
        ...allowAll(),
        authorizeSessionRead: (input) => {
          seen.push(`read:${input.operation}`)
          return true
        },
        authorizeSessionWrite: (input) => {
          seen.push(`${sessionAccessWriteClass(input)}:${input.operation}`)
          return true
        },
      },
    })
    const actor = { actorId: "actor_1", actorKind: "human" as const }
    const goalMutations = ["goal_start", "goal_pause", "goal_resume", "goal_stop", "goal_delete"] as const

    for (const operation of goalMutations) {
      await expect(policy.authorize({
        authority: { ...authority, role: "viewer" },
        actor,
        operation,
        sessionId: "ses_1",
      })).resolves.toEqual({ allowed: true })
    }

    for (const operation of goalMutations) {
      await expect(policy.authorize({
        authority,
        actor,
        operation,
        sessionId: "ses_1",
      })).resolves.toEqual({ allowed: true })
    }

    expect(seen).toEqual([
      ...goalMutations.map((operation) => `session_control:${operation}`),
      ...goalMutations.map((operation) => `session_control:${operation}`),
    ])
  })

  test("keeps goal reads on the read authority for a workspace viewer", async () => {
    const seen: string[] = []
    const policy = managedWorkspaceSessionAccessPolicy({
      authority: {
        ...allowAll(),
        authorizeSessionRead: (input) => {
          seen.push(`read:${input.operation}`)
          return true
        },
        authorizeSessionWrite: (input) => {
          seen.push(`write:${input.operation}`)
          return true
        },
      },
    })
    const goalReads = ["goal_read", "goal_state", "goal_capabilities"] as const

    for (const operation of goalReads) {
      await expect(policy.authorize({
        authority: { ...authority, role: "viewer" },
        actor: { actorId: "actor_1", actorKind: "human" },
        operation,
        sessionId: "ses_1",
      })).resolves.toEqual({ allowed: true })
    }

    expect(seen).toEqual(goalReads.map((operation) => `read:${operation}`))
  })

  test("denies a workspace editor who is not a private-session participant", async () => {
    const participants = new Set(["actor_alice"])
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authority: {
        ...allowAll(),
        authorizeSessionRead: (input) => participants.has(input.actor.actorId),
        authorizeSessionWrite: (input) => participants.has(input.actor.actorId),
      },
    })
    const input = {
      authority,
      operation: "message_read" as const,
      sessionId: "ses_private",
    }

    await expect(policy.authorize({
      ...input,
      actor: { actorId: "actor_alice", actorKind: "human" },
    })).resolves.toEqual({ allowed: true })
    await expect(policy.authorize({
      ...input,
      actor: { actorId: "actor_bob", actorKind: "human" },
    })).resolves.toMatchObject({ allowed: false, code: "session_private" })
  })

  test("derives actor and authority only from verified relay claims", () => {
    const context = sessionAccessContext({
      get(name: "relayHostAuth" | "relayHostDirectAuth") {
        if (name === "relayHostDirectAuth") return undefined
        return {
          actor_id: "actor_verified",
          actor_kind: "agent" as const,
          actor_public_id: "user_public_1",
          actor_name: "Verified User",
          actor_avatar_url: "https://example.invalid/avatar",
          workspace_id: "ws_1",
          org_id: "org_1",
          role: "admin" as const,
        }
      },
    } as never)

    expect(context).toEqual({
      actor: { actorId: "actor_verified", actorKind: "agent" },
      author: {
        id: "user_public_1",
        name: "Verified User",
        avatarUrl: "https://example.invalid/avatar",
        kind: "agent",
      },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "admin" },
    })
  })

  test("embedded verified stamp retains managed authority and the forwarded credential", async () => {
    const app = new Hono()
    app.use("*", createWorkspaceRuntimeExposureMiddleware(embeddedWorkspaceRuntimeExposure({
      owner: "session-access-test",
      guard: () => true,
    })))
    app.get("/context", (c) => c.json(sessionAccessContext(c as never)))

    const response = await app.request("http://runtime.test/context", {
      headers: {
        authorization: "Bearer verified-runtime-proof",
        [EMBEDDED_RELAY_HOST_AUTH_HEADER]: JSON.stringify({
          principal_kind: "user",
          actor_id: "actor_alice",
          actor_kind: "human",
          actor_public_id: "usr_alice",
          actor_name: "Alice",
          workspace_id: "ws_1",
          org_id: "org_1",
          role: "editor",
        }),
      },
    })
    await expect(response.json()).resolves.toEqual({
      actor: { actorId: "actor_alice", actorKind: "human" },
      author: { id: "usr_alice", name: "Alice", kind: "human" },
      authority: { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "editor" },
      credential: "Bearer verified-runtime-proof",
    })
  })

  test("reads a request's provenance off the same stamp, through the real embedded exposure", async () => {
    const app = new Hono()
    app.use("*", createWorkspaceRuntimeExposureMiddleware(embeddedWorkspaceRuntimeExposure({
      owner: "session-access-test",
      guard: () => true,
    })))
    app.get("/provenance", (c) => c.text(sessionRequestProvenance(c as never)))

    const stamped = await app.request("http://runtime.test/provenance", {
      headers: {
        [EMBEDDED_RELAY_HOST_AUTH_HEADER]: JSON.stringify({
          principal_kind: "user",
          actor_id: "actor_alice",
          actor_kind: "human",
          actor_public_id: "usr_alice",
          actor_name: "Alice",
          workspace_id: "ws_1",
          org_id: "org_1",
          role: "editor",
        }),
      },
    })
    // A bearer alone is not provenance: the ingress is what verifies one, and
    // an unstamped request reached this runtime as the machine's own user.
    const bearerOnly = await app.request("http://runtime.test/provenance", {
      headers: { authorization: "Bearer looks-official" },
    })

    await expect(stamped.text()).resolves.toBe("relay-replayed")
    await expect(bearerOnly.text()).resolves.toBe("loopback-direct")
  })

  test("the control plane's own injected token is a remote caller, not the machine's user", async () => {
    const app = new Hono()
    app.use("*", createRelayHostAuthMiddleware({
      // The direct-grant branch answers before any signature is checked.
      key: new Uint8Array(32),
      workspaceId: "ws_1",
      hostId: "host_1",
      trustedDirectTokenForRequest: ({ token }) => token === "control-plane-direct-token",
    }))
    app.get("/provenance", (c) => c.text(sessionRequestProvenance(c)))

    const direct = await app.request("http://runtime.test/provenance", {
      headers: { authorization: "Bearer control-plane-direct-token" },
    })

    // It names no actor, so nothing can be attributed to it — but a cloud VM
    // has no keyboard, and the one thing holding this token is the control
    // plane reaching in from outside.
    await expect(direct.text()).resolves.toBe("relay-replayed")
  })

  test("bounds concurrent authority calls while filtering large session collections", async () => {
    let active = 0
    let peak = 0
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authority: {
        ...allowAll(),
        authorizeSessionRead: async () => {
          active += 1
          peak = Math.max(peak, active)
          await Promise.resolve()
          active -= 1
          return true
        },
      },
    })

    const sessionIds = Array.from({ length: 50 }, (_, index) => `ses_${index}`)
    await expect(policy.filterSessions({
      actor: { actorId: "actor_1", actorKind: "human" },
      authority,
      operation: "session_list",
      sessionIds,
    })).resolves.toEqual(sessionIds)
    expect(peak).toBe(16)
  })

  test("gates turn admission behind verified actor and authority claims, then delegates to the bundle", async () => {
    const policy = managedWorkspaceSessionAccessPolicy({ requireActor: true, authority: allowAll() })
    const actor = { actorId: "actor_1", actorKind: "human" as const }

    await expect(policy.acquireTurn!({
      authority,
      operation: "prompt",
      sessionId: "ses_1",
      turnId: "turn_1",
    })).resolves.toMatchObject({ allowed: false, code: "session_actor_required", status: 403 })

    await expect(policy.acquireTurn!({
      actor,
      authority,
      operation: "prompt",
      sessionId: "ses_1",
      turnId: "turn_1",
    })).resolves.toMatchObject({ allowed: true, turnId: "turn_1", leaseId: "turn_lease_1", fencingToken: 1 })

    await expect(policy.renewTurn!({
      actor,
      authority,
      operation: "prompt",
      sessionId: "ses_1",
      turnId: "turn_1",
      leaseId: "turn_lease_1",
      fencingToken: 1,
    })).resolves.toMatchObject({ allowed: true, fencingToken: 2 })

    await expect(policy.releaseTurn!({
      actor,
      authority,
      operation: "prompt",
      sessionId: "ses_1",
      turnId: "turn_1",
      leaseId: "turn_lease_1",
      fencingToken: 2,
    })).resolves.toEqual({ released: true })
  })

  test("puts turn admission on the session authority, not on the workspace role", async () => {
    const refusing = managedWorkspaceSessionAccessPolicy({
      authority: {
        ...allowAll(),
        acquireTurn: () => ({ allowed: false, status: 403, code: "session_private", message: "no grant" }),
      },
    })
    const admitting = managedWorkspaceSessionAccessPolicy({ authority: allowAll() })
    const viewer = { ...authority, role: "viewer" as const }
    const turn = {
      actor: { actorId: "actor_1", actorKind: "human" as const },
      authority: viewer,
      operation: "prompt" as const,
      sessionId: "ses_1",
      turnId: "turn_1",
    }

    await expect(refusing.acquireTurn!(turn))
      .resolves.toMatchObject({ allowed: false, code: "session_private", status: 403 })
    await expect(admitting.acquireTurn!(turn))
      .resolves.toMatchObject({ allowed: true, turnId: "turn_1", leaseId: "turn_lease_1" })
  })
})


test("startup is local workspace admission or exact managed reservation admission", async () => {
  const input = { operation: "question_response" as const, sessionId: "ses_start", registrationOperationId: "op_start" }
  expect(await managedWorkspaceSessionAccessPolicy().authorizeSessionStart(input)).toEqual({ allowed: true })
  const scoped = { ...input, actor: { actorId: "actor", actorKind: "human" as const }, authority: { managed: true as const, workspaceId: "ws", orgId: "org", role: "editor" as const } }
  expect((await managedWorkspaceSessionAccessPolicy({ authority: allowAll() }).authorizeSessionStart(scoped)).allowed).toBe(false)
  const received: unknown[] = []
  const policy = managedWorkspaceSessionAccessPolicy({ authority: { ...allowAll(), authorizeSessionStart: (value) => { received.push(value); return true } } })
  expect(await policy.authorizeSessionStart(scoped)).toEqual({ allowed: true })
  expect(received).toEqual([scoped])
  expect((await policy.authorizeSessionStart({ ...scoped, authority: { ...scoped.authority, role: "viewer" } })).allowed).toBe(false)
  expect((await policy.authorizeSessionStart({ ...scoped, actor: undefined })).allowed).toBe(false)
  expect(received).toHaveLength(1)
})

test("startup status has a separate read-only predicate and never admits interactions", async () => {
  const received: unknown[] = []
  const policy = managedWorkspaceSessionAccessPolicy({ authority: { ...allowAll(), authorizeSessionStartStatus: (value) => { received.push(value); return true } } })
  const input = { operation: "session_meta_read" as const, sessionId: "ses_start", registrationOperationId: "op_start", actor: { actorId: "actor", actorKind: "human" as const }, authority: { managed: true as const, workspaceId: "ws", orgId: "org", role: "viewer" as const } }
  expect(await policy.authorizeSessionStartStatus(input)).toEqual({ allowed: true })
  expect((await policy.authorizeSessionStart(input)).allowed).toBe(false)
  expect(received).toEqual([input])
  expect((await managedWorkspaceSessionAccessPolicy({ authority: allowAll() }).authorizeSessionStartStatus(input)).allowed).toBe(false)
})
