import { describe, expect, mock, test } from "bun:test"
import type { BindingScope } from "./services"
import { shellRoutes } from "./test-support/shell-routes"

let activity = "working"
await mock.module("@/session", () => ({ sessionActivity: () => activity }))
await mock.module("@/shell", () => shellRoutes)
const { dataBindings } = await import("./data")

function fixture() {
  const ref = { projectId: "project-1", placementId: "workspace-1", sessionId: "session-1" }
  const placement = { id: ref.placementId, projectId: ref.projectId, kind: "folder" }
  const navigated: string[] = []
  const located: string[] = []
  const locateSession = async (address: { workspaceId: string; sessionId: string }) => {
    located.push(address.workspaceId)
    return { placementId: address.workspaceId, sessionId: address.sessionId }
  }
  const scope = {
    manifest: { id: "fixture", version: "0.1.0" },
    services: {
      routing: { route: () => ({ kind: "session", ...ref }), placementId: () => ref.placementId, navigate: (path: string) => navigated.push(path) },
      server: { placements: { list: () => [placement], byId: () => placement, locateSession } },
      sessions: { list: { create: async () => ref, view: () => ({ ref }) }, open: () => ({ send: async () => undefined }) },
    },
  } as unknown as BindingScope
  return { api: dataBindings(scope), navigated, located }
}

describe("plugin session bindings", () => {
  test("created and current sessions name their workspace, and the project stays separate context", async () => {
    const { api } = fixture()
    expect(await api.sessions.create({ projectId: "project-1", prompt: "Ship" })).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" })
    expect(api.context.currentSession()).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" })
    expect(api.context.currentProjectId()).toBe("project-1")
  })

  test("status does not accept a session from a different workspace", () => {
    const { api } = fixture()
    expect(api.sessions.status({ sessionId: "session-1", workspaceId: "workspace-elsewhere" })).toBe("idle")
    expect(api.sessions.status({ sessionId: "session-1", workspaceId: "workspace-1" })).toBe("running")
  })

  test("open navigates only once the catalog has located the session's workspace, listed or not", async () => {
    const { api, navigated, located } = fixture()
    const opening = api.sessions.open({ sessionId: "session-new", workspaceId: "workspace-new" })
    expect(navigated).toEqual([])
    await opening
    expect(located).toEqual(["workspace-new"])
    expect(navigated).toEqual(["workspace-new/session-new"])
    await api.sessions.open({ sessionId: "session-1", workspaceId: "workspace-1" })
    expect(navigated).toEqual(["workspace-new/session-new", "workspace-1/session-1"])
  })

  test("an interrupted session reads interrupted, not waiting on the user", () => {
    const { api } = fixture()
    activity = "interrupted"
    try {
      expect(api.sessions.status({ sessionId: "session-1", workspaceId: "workspace-1" })).toBe("interrupted")
    } finally {
      activity = "working"
    }
  })
})
