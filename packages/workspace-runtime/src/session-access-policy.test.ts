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
  type SessionAccessPolicyInput,
} from "./session-access-policy"

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
    const policy = managedWorkspaceSessionAccessPolicy({
      authorizeSessionRead: () => true,
      authorizeSessionWrite: () => true,
    })
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

  test("denies a workspace viewer a session write with session_write_forbidden", async () => {
    const policy = managedWorkspaceSessionAccessPolicy({
      authorizeSessionRead: () => true,
      authorizeSessionWrite: () => true,
    })
    const viewer = { ...authority, role: "viewer" as const }
    const actor = { actorId: "actor_1", actorKind: "human" as const }

    // A viewer + a write operation is refused on role rank, before any
    // creator/participant check — a viewer must not be able to mutate a session.
    await expect(policy.authorize({
      authority: viewer,
      actor,
      operation: "prompt",
      sessionId: "ses_1",
    })).resolves.toMatchObject({ allowed: false, code: "session_write_forbidden", status: 403 })

    // The same viewer may still READ (the gate is write-only).
    await expect(policy.authorize({
      authority: viewer,
      actor,
      operation: "session_meta_read",
      sessionId: "ses_1",
    })).resolves.toEqual({ allowed: true })
  })

  test("denies a workspace editor who is not a private-session participant", async () => {
    const participants = new Set(["actor_alice"])
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authorizeSessionRead: (input) => participants.has(input.actor.actorId),
      authorizeSessionWrite: (input) => participants.has(input.actor.actorId),
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

  test("bounds concurrent authority calls while filtering large session collections", async () => {
    let active = 0
    let peak = 0
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authorizeSessionRead: async () => {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return true
      },
      authorizeSessionWrite: () => true,
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
})
