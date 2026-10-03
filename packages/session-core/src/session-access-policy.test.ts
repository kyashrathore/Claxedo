import { describe, expect, test } from "bun:test"
import { managedWorkspaceSessionAccessPolicy, type ManagedSessionAuthority, type SessionWorkspaceAuthority } from "./session-access-policy"

const refuse = async () => ({ allowed: false as const, status: 403 as const, code: "unexpected", message: "unexpected" })

function policy(starts: string[]) {
  const authority: ManagedSessionAuthority = {
    authorizeSessionStart: async (input) => { starts.push(input.sessionId) },
    authorizeSessionStartStatus: async (input) => { starts.push(`status:${input.sessionId}`) },
    authorizeSessionRead: refuse,
    authorizeSessionWrite: refuse,
    authorizeSessionStream: refuse,
    registerSession: refuse,
    acquireTurn: refuse,
    renewTurn: refuse,
    releaseTurn: refuse,
  }
  return managedWorkspaceSessionAccessPolicy({ requireActor: true, authority })
}

describe("starting a reserved session through a token scoped to one session", () => {
  const scoped: SessionWorkspaceAuthority = { managed: true, workspaceId: "ws_1", orgId: "org_1", role: "editor", sessionId: "ses_scoped" }
  const actor = { actorId: "actor_1", actorKind: "human" as const }

  test("reaches the start of that session and its status", async () => {
    const starts: string[] = []
    const access = policy(starts)
    const input = { actor, authority: scoped, operation: "session_create" as const, sessionId: "ses_scoped", registrationOperationId: "op_1" }
    expect(await access.authorizeSessionStart(input)).toEqual({ allowed: true })
    expect(await access.authorizeSessionStartStatus(input)).toEqual({ allowed: true })
    expect(starts).toEqual(["ses_scoped", "status:ses_scoped"])
  })

  test("reaches no other session's start", async () => {
    const starts: string[] = []
    const decision = await policy(starts).authorizeSessionStart({ actor, authority: scoped, operation: "session_create", sessionId: "ses_other", registrationOperationId: "op_2" })
    expect(decision).toMatchObject({ allowed: false, code: "session_scope_denied" })
    expect(starts).toEqual([])
  })

  test("leaves a create that claims a reservation to that reservation, and asks the authority about one that claims none", async () => {
    const starts: string[] = []
    const access = policy(starts)
    const create = { actor, authority: scoped, operation: "session_create" as const, sessionId: "ses_scoped" }
    expect(await access.authorize({ ...create, registrationOperationId: "op_1" })).toEqual({ allowed: true })
    expect(await access.authorize(create)).toMatchObject({ allowed: false, code: "unexpected" })
    expect(await access.authorize({ ...create, sessionId: "ses_other", registrationOperationId: "op_1" }))
      .toMatchObject({ allowed: false, code: "session_scope_denied" })
    expect(starts).toEqual([])
  })
})
