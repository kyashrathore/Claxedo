import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import { WORKSPACE_ID, sessionHostPlane, type SessionHostPlane } from "../../../test-support/session-host-plane"

let plane: SessionHostPlane

beforeAll(async () => {
  plane = await sessionHostPlane()
})

afterAll(async () => {
  await plane.close()
})

describe("deleting a workspace whose sessions live in their own hosts", () => {
  test("is refused while a host still keeps a session, and a session reserved before the delete registers nowhere after it", async () => {
    await plane.createHostedSession("ses_kept")
    await expect(plane.store.deleteWorkspace(plane.owner, { workspaceId: WORKSPACE_ID })).rejects.toMatchObject({ code: "resource_conflict" })
    await expect(plane.store.openWorkspace(plane.owner, { workspaceId: WORKSPACE_ID })).resolves.toBeDefined()

    const late = "ses_late"
    await plane.store.reserveSession(plane.owner, { operationId: `op_${late}`, sessionId: late, workspaceId: WORKSPACE_ID, kind: "create", harnessId: "pi" })
    const proof = await plane.relayProof(plane.owner, { hostId: sessionHostId(late), backing: "durable-object", jti: `rat_${late}` })
    await plane.store.deleteHostedSession({ workspaceId: WORKSPACE_ID, sessionId: "ses_kept" })
    await expect(plane.store.deleteWorkspace(plane.owner, { workspaceId: WORKSPACE_ID })).resolves.toEqual({ deleted: true })

    const registered = await plane.post("/session-authorize", { action: "register", sessionId: late, operationId: `op_${late}`, createdAt: Date.now(), updatedAt: Date.now() }, proof)
    expect(registered.status).not.toBe(200)
    expect(await plane.store.listHostedSessions(WORKSPACE_ID)).toEqual([])
  })
})
