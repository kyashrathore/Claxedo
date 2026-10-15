import { describe, expect, test } from "vitest"
import type { SessionOrigin } from "@claxedo/tasks"
import { originIds } from "./origin-ids"
import { registeredSessionStates } from "./registered-sessions"

async function originFor(workspaceId: string): Promise<SessionOrigin> {
  const ids = await originIds({ scopeId: "org", taskId: "tsk_1", slot: "primary", attempt: 1 })
  return { scopeId: "org", taskId: "tsk_1", slot: "primary", attempt: 1, sessionRef: { sessionId: ids.sessionId, workspaceId } }
}

describe("registered session states", () => {
  test("a session registered in the link's workspace reads live, and sent once a person's turn landed", async () => {
    const origin = await originFor("ws_root")
    const id = origin.sessionRef.sessionId
    expect(await registeredSessionStates([origin], new Map([[id, { workspaceID: "ws_root" }]]))).toEqual([
      { session: origin.sessionRef, state: "live", handoff: "pending" },
    ])
    expect(await registeredSessionStates([origin], new Map([[id, { workspaceID: "ws_root", lastHumanTurnAt: 5 }]]))).toEqual([
      { session: origin.sessionRef, state: "live", handoff: "sent" },
    ])
  })

  test("a link naming a session registered in another workspace reads it as deleted, archived or not, so the row's existence is never told", async () => {
    const origin = await originFor("ws_root")
    const id = origin.sessionRef.sessionId
    for (const row of [{ workspaceID: "ws_elsewhere" }, { workspaceID: "ws_elsewhere", archived: 7 }, { workspaceID: "ws_elsewhere", lastHumanTurnAt: 5 }]) {
      expect(await registeredSessionStates([origin], new Map([[id, row]]))).toEqual([
        { session: origin.sessionRef, state: "deleted", handoff: "unknown" },
      ])
    }
  })
})
