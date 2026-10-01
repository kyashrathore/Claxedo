import { describe, expect, mock, test } from "bun:test"
import * as ids from "../../server/ids"
import type { BindingScope } from "./services"

mock.module("@/server", () => ids)
const routes = await import("../../shell/routes")
mock.module("@/shell", () => routes)
const { dataBindings } = await import("./data")

function fixture() {
  const ref = { projectId: "project-1", placementId: "workspace-1", sessionId: "session-1" }
  const placement = { id: ref.placementId, projectId: ref.projectId, kind: "folder" }
  const navigated: string[] = []
  const row = { ref, status: { kind: "working" } }
  const scope = {
    manifest: { id: "fixture", version: "0.1.0" },
    signal: new AbortController().signal,
    services: {
      platform: "desktop",
      i18n: { locale: () => "en" },
      projects: () => [],
      routing: {
        route: () => ({ kind: "session", placementId: ref.placementId, sessionId: ref.sessionId }),
        placementId: () => ref.placementId,
        navigate: (path: string) => navigated.push(path),
      },
      server: { placements: { list: () => [placement], byId: () => placement } },
      sessions: {
        list: { create: async () => ref, view: () => row },
        open: () => ({ send: async () => undefined }),
      },
    },
  } as unknown as BindingScope
  return { api: dataBindings(scope), navigated }
}

describe("plugin session bindings", () => {
  test("creation returns workspace identity while project context remains separate", async () => {
    const { api } = fixture()
    expect(await api.sessions.create({ projectId: "project-1", prompt: "Ship" })).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" })
  })

  test("current session identifies its workspace without embedding project metadata", () => {
    const { api } = fixture()
    expect(api.context.currentSession()).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" })
    expect(api.context.currentProjectId()).toBe("project-1")
  })

  test("status and open do not accept a session from a different workspace", () => {
    const { api, navigated } = fixture()
    const foreign = { sessionId: "session-1", workspaceId: "workspace-elsewhere" }
    expect(api.sessions.status(foreign)).toBe("idle")
    expect(() => api.sessions.open(foreign)).toThrow("not in the session list")
    expect(navigated).toEqual([])
    const own = { sessionId: "session-1", workspaceId: "workspace-1" }
    expect(api.sessions.status(own)).toBe("running")
    api.sessions.open(own)
    expect(navigated).toEqual(["/w/workspace-1/session/session-1"])
  })
})
