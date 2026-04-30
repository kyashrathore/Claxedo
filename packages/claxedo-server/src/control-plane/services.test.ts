import fs from "node:fs"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import type { SyncDB } from "../sync-db"
import { createControlPlaneServices } from "./services"

function fakeSync() {
  return {
    mode: () => "central_canonical",
    sync_session_meta: vi.fn(async () => {}),
    sync_session_metas: vi.fn(async () => {}),
    put_session_meta: vi.fn(async () => {}),
    delete_session_meta: vi.fn(async () => {}),
    session_meta: vi.fn(async () => undefined),
    session_metas: vi.fn(async () => new Map()),
    list_session_metas: vi.fn(async () => []),
    tagged_session_metas: vi.fn(async () => []),
    persist_message_event: vi.fn(),
    read_session_messages: vi.fn(() => []),
    subscribe_message_replay: vi.fn(() => () => {}),
  } satisfies SyncDB
}

describe("control-plane services", () => {
  test("uses injected sync implementation when provided", () => {
    const sync = fakeSync()
    const services = createControlPlaneServices({
      sync,
    })

    expect(services.projectionStore.put_session_meta).toBe(sync.put_session_meta)
    expect(services.projectionStore.read_session_messages).toBe(sync.read_session_messages)
    expect(services.durableSessionLog.subscribe_message_replay).toBe(sync.subscribe_message_replay)
  })

  test("server composition uses createApp with explicit services", () => {
    const file = path.resolve(import.meta.dirname, "../server.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("export function createApp(services: ControlPlaneServices)")
    expect(text).toContain("const services = createControlPlaneServices({")
    expect(text).toContain("sync: createSyncDB({ mode: getSessionWriteMode })")
    expect(text).toContain("mount(app, \"/\", AgentSessionRoutes(services))")
    expect(text).toContain("configureHarnessHost(createPiHost(services.projectionStore))")
    expect(text).toContain("services.durableSessionLog.subscribe_message_replay(globalBus)")
    expect(text).toContain("app.all(\"/api/control/trpc/*\"")
    expect(text).toContain("controlPlaneTrpcHandler(services)")
    expect(text).toContain("app.route(\"/api/control\", ControlPlaneSessionRoutes(services))")
  })

  test("agent session routes do not create a file-local sync singleton", () => {
    const file = path.resolve(import.meta.dirname, "../routes/agent-session.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("export function AgentSessionRoutes(services: ControlPlaneServices)")
    expect(text).toContain("const projectionStore = services.projectionStore")
    expect(text).not.toContain("const sync = createSyncDB")
  })

  test("runtime-facing server files do not reach around control-plane ports", () => {
    const files = [
      path.resolve(import.meta.dirname, "../server.ts"),
      path.resolve(import.meta.dirname, "../routes/agent-session.ts"),
      path.resolve(import.meta.dirname, "../harness/host.ts"),
      path.resolve(import.meta.dirname, "../harness/pi-host.ts"),
      path.resolve(import.meta.dirname, "../harness/pi-adapter.ts"),
    ]

    for (const file of files) {
      const text = fs.readFileSync(file, "utf8")
      expect(text).not.toContain("services.sync")
      expect(text).not.toContain("import type { SyncDB }")
    }
  })

  test("remote runtime launch injects the control-plane URL", () => {
    const file = path.resolve(import.meta.dirname, "../workspace-supervisor.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("CLAXEDO_CONTROL_PLANE_URL: needOpts().server_url")
  })

  test("runtime control-plane router exposes typed session and runtime procedures", () => {
    const file = path.resolve(import.meta.dirname, "./trpc.ts")
    const text = fs.readFileSync(file, "utf8")

    expect(text).toContain("session: t.router({")
    expect(text).toContain("sync: t.procedure.input(sessionSyncInput).mutation")
    expect(text).toContain("syncMany: t.procedure.input(sessionSyncManyInput).mutation")
    expect(text).toContain("delete: t.procedure.input(sessionDeleteInput).mutation")
    expect(text).toContain("gateway: t.procedure.input(gatewayInput).query")
    expect(text).toContain("runtime: t.router({")
    expect(text).toContain("register: t.procedure.input(runtimeSnapshotInput).mutation")
    expect(text).toContain("heartbeat: t.procedure.input(runtimeSnapshotInput).mutation")
  })

  test("hosted session bootstrap exposes a real frontend gateway resolution seam", () => {
    const routeFile = path.resolve(import.meta.dirname, "../routes/control-plane-session.ts")
    const routeText = fs.readFileSync(routeFile, "utf8")
    const extensionFile = path.resolve(import.meta.dirname, "../../../claxedo-app/src/extensions/server.tsx")
    const extensionText = fs.readFileSync(extensionFile, "utf8")
    const layoutFile = path.resolve(import.meta.dirname, "../../../claxedo-app/src/overrides/pages/directory-layout.tsx")
    const layoutText = fs.readFileSync(layoutFile, "utf8")

    expect(routeText).toContain(".get(\"/sessions/:sessionId/gateway\"")
    expect(routeText).toContain("resolveSessionGateway(services, c.req.param(\"sessionId\"))")
    expect(extensionText).toContain("resolveSessionUrl: async (sessionId: string)")
    expect(extensionText).toContain("/api/control/sessions/${encodeURIComponent(sessionId)}/gateway")
    expect(extensionText).toContain("if (body.runnerHost === \"central\") return base")
    expect(layoutText).toContain("void ext.server.resolveSessionUrl(sessionId).then((gatewayUrl) => {")
    expect(layoutText).not.toContain("^https?:\\\\/\\\\/(localhost|127\\\\.0\\\\.0\\\\.1)")
  })
})
