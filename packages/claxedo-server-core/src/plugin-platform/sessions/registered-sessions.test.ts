import { describe, expect, test } from "vitest"
import { originIds } from "./origin-ids"
import { registeredSessionStates, type OriginSession } from "./registered-sessions"

const ORIGIN = { namespace: "plugin", key: "org:notes:prj_1:draft-1" }

async function originFor(workspaceId: string): Promise<OriginSession> {
  return { origin: ORIGIN, session: { sessionId: (await originIds(ORIGIN)).sessionId, workspaceId } }
}

describe("registered session states", () => {
  test("a session registered in the origin's workspace reads live, and sent once a person's turn landed", async () => {
    const origin = await originFor("ws_root")
    const id = origin.session.sessionId
    expect(await registeredSessionStates([origin], new Map([[id, { workspaceID: "ws_root" }]]))).toEqual([
      { session: origin.session, state: "live", handoff: "pending" },
    ])
    expect(await registeredSessionStates([origin], new Map([[id, { workspaceID: "ws_root", lastHumanTurnAt: 5 }]]))).toEqual([
      { session: origin.session, state: "live", handoff: "sent" },
    ])
  })

  test("a person's turn on a session another origin created is no evidence that this origin's handoff was sent", async () => {
    const session = { sessionId: "ses_elsewhere", workspaceId: "ws_root" }
    expect(await registeredSessionStates([{ origin: ORIGIN, session }], new Map([[session.sessionId, { workspaceID: "ws_root", lastHumanTurnAt: 5 }]]))).toEqual([
      { session, state: "live", handoff: "pending" },
    ])
  })

  test("an origin naming a session registered in another workspace reads it as deleted, archived or not, so the row's existence is never told", async () => {
    const origin = await originFor("ws_root")
    const id = origin.session.sessionId
    for (const row of [{ workspaceID: "ws_elsewhere" }, { workspaceID: "ws_elsewhere", archived: 7 }, { workspaceID: "ws_elsewhere", lastHumanTurnAt: 5 }]) {
      expect(await registeredSessionStates([origin], new Map([[id, row]]))).toEqual([
        { session: origin.session, state: "deleted", handoff: "unknown" },
      ])
    }
  })
})
