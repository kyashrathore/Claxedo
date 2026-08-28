import { describe, expect, test } from "bun:test"
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
      registerSession: () => true,
    })
    const input: SessionAccessPolicyInput = { authority, operation: "session_list" }

    await expect(policy.filterSessions({ ...input, sessionIds: ["ses_1", "ses_2"] })).resolves.toEqual([])
    await expect(policy.filterSessions({
      ...input,
      actor: { actorId: "actor_1", actorKind: "human" },
      sessionIds: ["ses_1", "ses_2"],
    })).resolves.toEqual(["ses_1", "ses_2"])
  })

  test("denies a workspace viewer before consulting private-session write authority", async () => {
    let writeChecks = 0
    const policy = managedWorkspaceSessionAccessPolicy({
      authorizeSessionRead: () => true,
      authorizeSessionWrite: () => {
        writeChecks += 1
        return true
      },
      registerSession: () => true,
    })
    const actor = { actorId: "actor_1", actorKind: "human" as const }

    await expect(policy.authorize({
      authority: { ...authority, role: "viewer" },
      actor,
      operation: "prompt",
      sessionId: "ses_1",
    })).resolves.toMatchObject({ allowed: false, code: "session_write_forbidden", status: 403 })
    expect(writeChecks).toBe(0)
    await expect(policy.authorize({
      authority: { ...authority, role: "viewer" },
      actor,
      operation: "session_meta_read",
      sessionId: "ses_1",
    })).resolves.toEqual({ allowed: true })
  })

  test("denies an editor who is not a private-session participant", async () => {
    const participants = new Set(["actor_alice"])
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authorizeSessionRead: (input) => participants.has(input.actor.actorId),
      authorizeSessionWrite: (input) => participants.has(input.actor.actorId),
      registerSession: () => true,
    })
    const input = { authority, operation: "message_read" as const, sessionId: "ses_private" }

    await expect(policy.authorize({
      ...input,
      actor: { actorId: "actor_alice", actorKind: "human" },
    })).resolves.toEqual({ allowed: true })
    await expect(policy.authorize({
      ...input,
      actor: { actorId: "actor_bob", actorKind: "human" },
    })).resolves.toMatchObject({ allowed: false, code: "session_private" })
  })

  test("requires one immutable registration operation id", async () => {
    const observed: string[] = []
    const policy = managedWorkspaceSessionAccessPolicy({
      requireActor: true,
      authorizeSessionRead: () => true,
      authorizeSessionWrite: () => true,
      registerSession: (input) => {
        observed.push(input.registrationOperationId ?? "")
        return true
      },
    })

    await expect(policy.registerSession({
      actor: { actorId: "actor_1", actorKind: "human" },
      authority,
      operation: "session_create",
      sessionId: "ses_1",
      registrationOperationId: "op_create_1",
    })).resolves.toEqual({ allowed: true })
    expect(observed).toEqual(["op_create_1"])
  })

  test("derives actor, author, and tenant only from verified relay claims", () => {
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
      req: { header: () => "Bearer signed-rht" },
    } as never)

    expect(context).toEqual({
      credential: "Bearer signed-rht",
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

  test("bounds concurrent authority calls while filtering large collections", async () => {
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
      registerSession: () => true,
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
