import { afterEach, describe, expect, test } from "bun:test"
import { queryClient } from "@/platform/query/query-client"
import { sessionGoalKey, type SessionGoalData } from "@/features/session/store/session-goal-query"
import { sessionResourceAuthorityScope } from "@/features/session/store/session-resource-authority"
import { applyLiveSessionGoalEvent, liveSessionGoalScope } from "./goal-events"

afterEach(() => {
  queryClient.clear()
})

const capabilities = {
  implemented: true,
  available: true,
  actions: ["pause", "resume", "delete"] as const,
  recovery: "reconcile" as const,
  optionalFields: [] as const,
}

const goal = {
  sessionId: "ses_1",
  objective: "Ship verified work",
  status: "active" as const,
  createdAt: 10,
  updatedAt: 20,
}

// A live session with a workspace id but no sessionRef, read over an UNSIGNED
// transport: the read/write side drops the workspace identity from the
// authority, so the event side must drop it too.
const live = {
  sessionID: "ses_1",
  directory: "/repo/main",
  workspaceId: "ws_1",
  workspaceKind: "cloud",
}

const serverUrl = "http://localhost:3001"

const readScope = sessionResourceAuthorityScope({
  sessionID: "ses_1",
  directory: "/repo/main",
  serverUrl,
  signedControlPlane: false,
  workspaceId: undefined,
  workspaceKind: undefined,
})

describe("live session Goal scope", () => {
  test("keys the same authority the unsigned read side writes", () => {
    const scope = liveSessionGoalScope({ live, serverUrl, signedControlPlane: false })
    expect(scope).toBeDefined()
    expect(sessionGoalKey(scope!)).toEqual(sessionGoalKey(readScope))
  })

  test("still carries the workspace identity under the signed control plane", () => {
    const scope = liveSessionGoalScope({ live, serverUrl, signedControlPlane: true })
    expect(scope).toMatchObject({ workspaceId: "ws_1", workspaceKind: "cloud" })
    expect(sessionGoalKey(scope!)).not.toEqual(sessionGoalKey(readScope))
  })

  test("a goal-updated event reaches the cache entry the reader owns", () => {
    queryClient.setQueryData<SessionGoalData>(sessionGoalKey(readScope), { capabilities, goal })

    const applied = applyLiveSessionGoalEvent({
      live,
      serverUrl,
      signedControlPlane: false,
      sessionId: "ses_1",
      payload: { type: "goal-updated", sessionId: "ses_1", goal: { ...goal, status: "paused", updatedAt: 21 } },
    })

    expect(applied).toBe(true)
    expect(queryClient.getQueryData<SessionGoalData>(sessionGoalKey(readScope))?.goal?.status).toBe("paused")
  })
})
