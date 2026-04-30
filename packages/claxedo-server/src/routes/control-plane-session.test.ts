import { beforeEach, describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../control-plane/services"

const resolveWorkspace = vi.fn()
const getLease = vi.fn()
const resolveRunnerHostForRequest = vi.fn()

vi.mock("../workspace-store", () => ({
  resolveWorkspace,
}))

vi.mock("../cloud/authority", () => ({
  getLease,
}))

vi.mock("../runner-resolution", () => ({
  resolveRunnerHostForRequest,
}))

import { ControlPlaneSessionRoutes } from "./control-plane-session"

function services(): ControlPlaneServices {
  return {
    projectionStore: {
      sync_session_meta: vi.fn(async () => {}),
      sync_session_metas: vi.fn(async () => {}),
      put_session_meta: vi.fn(async () => {}),
      delete_session_meta: vi.fn(async () => {}),
      session_meta: vi.fn(async () => undefined),
      session_metas: vi.fn(async () => new Map()),
      list_session_metas: vi.fn(async () => []),
      tagged_session_metas: vi.fn(async () => []),
      read_session_messages: vi.fn(() => []),
    },
    durableSessionLog: {
      persist_message_event: vi.fn(),
      subscribe_message_replay: vi.fn(() => () => {}),
    },
  }
}

describe("control plane session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
    })
    resolveRunnerHostForRequest.mockResolvedValue("workspace")
    getLease.mockReturnValue({
      runtime_url: "https://runtime.example.com/",
    })
  })

  test("resolves a hosted session to its gateway URL", async () => {
    const svc = services()
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      workspaceID: "ws_1",
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))
    const app = ControlPlaneSessionRoutes(svc)

    const res = await app.request("http://localhost/sessions/session-1/gateway")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      gatewayUrl: "https://runtime.example.com",
      workspaceId: "ws_1",
      directory: "/tmp/demo",
      runnerHost: "workspace",
    })
  })

  test("keeps central sessions attached to the control plane", async () => {
    const svc = services()
    resolveRunnerHostForRequest.mockResolvedValue("central")
    svc.projectionStore.session_meta = vi.fn(async () => ({
      sessionID: "session-1",
      workspaceID: "ws_1",
      directory: "/tmp/demo",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      attachments: [],
    }))
    const app = ControlPlaneSessionRoutes(svc)

    const res = await app.request("http://localhost/sessions/session-1/gateway")

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      gatewayUrl: null,
      workspaceId: "ws_1",
      directory: "/tmp/demo",
      runnerHost: "central",
    })
  })
})
