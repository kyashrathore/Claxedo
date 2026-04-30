import { beforeEach, describe, expect, test, vi } from "vitest"
import { TRPCError } from "@trpc/server"
import { createControlPlaneRouter } from "./trpc"
import type { ControlPlaneServices } from "./services"

const resolveWorkspace = vi.fn()
const updateWorkspace = vi.fn(async () => undefined)
const getLease = vi.fn()
const updateLease = vi.fn()

vi.mock("../workspace-store", () => ({
  resolveWorkspace,
  updateWorkspace,
}))

vi.mock("../cloud/authority", () => ({
  getLease,
  updateLease,
}))

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

describe("control plane trpc router", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveWorkspace.mockResolvedValue({
      id: "ws_1",
      kind: "cloud",
      directory: "/tmp/demo",
      status: "starting",
    })
    getLease.mockReturnValue({
      status: "starting",
    })
  })

  test("delegates session mutations to the projection store", async () => {
    const svc = services()
    const caller = createControlPlaneRouter(svc).createCaller({ services: svc })

    await caller.session.sync({
      workspaceId: "ws_1",
      session: { id: "session-1", directory: "/tmp/demo" },
    })
    await caller.session.syncMany({
      workspaceId: "ws_1",
      sessions: [{ id: "session-1" }],
    })
    await caller.session.delete({
      workspaceId: "ws_1",
      sessionId: "session-1",
    })

    expect(svc.projectionStore.sync_session_meta).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      { id: "session-1", directory: "/tmp/demo" },
    )
    expect(svc.projectionStore.sync_session_metas).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_1" }),
      [{ id: "session-1" }],
    )
    expect(svc.projectionStore.delete_session_meta).toHaveBeenCalledWith("session-1")
  })

  test("register and heartbeat delegate to workspace and authority state", async () => {
    const svc = services()
    const caller = createControlPlaneRouter(svc).createCaller({ services: svc })
    const input = {
      workspaceId: "ws_1",
      ok: true,
      status: "ready",
      directory: "/tmp/demo",
      profile: "workspace",
      agentType: "opencode",
      model: "gpt-5.4",
      ptyCount: 1,
      processCount: 2,
      activeProcessCount: 1,
      runtimeUrl: "https://runtime.example.com",
      leaseId: "lease_1",
      sandboxId: "sandbox_1",
      epoch: 2,
    }

    await caller.runtime.register(input)
    await caller.runtime.heartbeat(input)

    expect(updateWorkspace).toHaveBeenCalledWith("ws_1", { status: "ready" })
    expect(updateLease).toHaveBeenCalledWith("ws_1", expect.objectContaining({
      status: "ready",
      runtime_url: "https://runtime.example.com",
    }))
  })

  test("invalid payloads fail at the router boundary", async () => {
    const svc = services()
    const caller = createControlPlaneRouter(svc).createCaller({ services: svc })

    await expect(caller.session.sync({
      workspaceId: "",
      session: {},
    })).rejects.toBeInstanceOf(TRPCError)
  })
})
