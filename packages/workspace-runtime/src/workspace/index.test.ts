import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { workspaceRuntimeBus } from "../bus"
import { createRuntimeEventHub } from "../runtime-event-hub"
import {
  createWorkspaceHost,
  loopbackWorkspaceRuntimeExposure,
  mountWorkspaceAgentHooks,
  mountWorkspaceCore,
  mountWorkspaceProcess,
  mountWorkspacePty,
} from "./index"

function paths(app: Hono) {
  return ((app as { routes?: Array<{ path: string }> }).routes ?? []).map((route) => route.path)
}

function has(paths: string[], prefix: string) {
  return paths.some((path) => path === prefix || path.startsWith(prefix + "/"))
}

const loopbackExposure = loopbackWorkspaceRuntimeExposure()

describe("workspace module wiring", () => {
  test("mountWorkspaceCore registers the workspace routes", async () => {
    const app = new Hono()
    mountWorkspaceCore(app, (() => () => ({})) as never, { eventHub: createRuntimeEventHub(), exposure: loopbackExposure })

    const seen = paths(app)
    expect(has(seen, "/api/wr/pty")).toBe(true)
    expect(has(seen, "/api/wr/hook")).toBe(true)
    expect(has(seen, "/api/wr/events")).toBe(true)
    expect(has(seen, "/api/wr/runtime-events")).toBe(true)
    expect(has(seen, "/api/wr/process")).toBe(true)
    expect(has(seen, "/api/wr/file")).toBe(true)
    expect(has(seen, "/api/wr/find/file")).toBe(true)
    expect(has(seen, "/api/wr/diff")).toBe(true)
  })

  test("workspace PTY, process, and agent hooks mount independently", () => {
    const upgradeWebSocket = (() => () => ({})) as never
    const pty = new Hono()
    mountWorkspacePty(pty, upgradeWebSocket)
    expect(has(paths(pty), "/api/wr/pty")).toBe(true)
    expect(has(paths(pty), "/api/wr/process")).toBe(false)
    expect(has(paths(pty), "/api/wr/hook")).toBe(false)

    const process = new Hono()
    mountWorkspaceProcess(process)
    expect(has(paths(process), "/api/wr/process")).toBe(true)
    expect(has(paths(process), "/api/wr/pty")).toBe(false)
    expect(has(paths(process), "/api/wr/hook")).toBe(false)

    const hooks = new Hono()
    mountWorkspaceAgentHooks(hooks)
    expect(has(paths(hooks), "/api/wr/hook")).toBe(true)
    expect(has(paths(hooks), "/api/wr/pty")).toBe(false)
    expect(has(paths(hooks), "/api/wr/process")).toBe(false)
  })

  test("workspace host mounts runtime routes", async () => {
    const host = createWorkspaceHost()
    const app = new Hono()
    host.mount(app, { exposure: loopbackExposure })

    const seen = paths(app)
    expect(seen).toContain("/api/wr/harness-config-options")
    expect(seen).toContain("/global/event")
    expect(seen).toContain("/session/status")

    const res = await app.request("http://localhost/api/wr/harness-config-options")
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      ok: false,
      error: {
        code: "harness_config_options_unavailable",
        harness: "opencode",
      },
    })
  })

  test("workspace host mounts core routes when core option is supplied", () => {
    const host = createWorkspaceHost()
    const app = new Hono()
    host.mount(app, { exposure: loopbackExposure, core: { upgradeWebSocket: (() => () => ({})) as never } })

    const seen = paths(app)
    // Harness/session surfaces from runtime.ts
    expect(seen).toContain("/api/wr/harness-config-options")
    // Core surfaces from workspace/core.ts
    expect(has(seen, "/api/wr/pty")).toBe(true)
    expect(has(seen, "/api/wr/process")).toBe(true)
    expect(has(seen, "/api/wr/file")).toBe(true)
    expect(has(seen, "/api/wr/find/file")).toBe(true)
    expect(has(seen, "/api/wr/diff")).toBe(true)
    expect(has(seen, "/api/wr/hook")).toBe(true)
    expect(has(seen, "/api/wr/events")).toBe(true)
  })

  test("workspace host can mount PTY, process, and agent hooks separately", () => {
    const host = createWorkspaceHost()
    const app = new Hono()
    host.mount(app, {
      exposure: loopbackExposure,
      pty: { upgradeWebSocket: (() => () => ({})) as never },
      process: true,
    })

    const seen = paths(app)
    expect(seen).toContain("/api/wr/harness-config-options")
    expect(has(seen, "/api/wr/pty")).toBe(true)
    expect(has(seen, "/api/wr/process")).toBe(true)
    expect(has(seen, "/api/wr/hook")).toBe(false)
    expect(has(seen, "/api/wr/diff")).toBe(false)
  })

  test("workspace host omits core routes when core option is absent", () => {
    const host = createWorkspaceHost()
    const app = new Hono()
    host.mount(app, { exposure: loopbackExposure })

    const seen = paths(app)
    expect(has(seen, "/api/wr/pty")).toBe(false)
    expect(has(seen, "/api/wr/process")).toBe(false)
    expect(has(seen, "/api/wr/diff")).toBe(false)
  })

  test("workspace core streams claxedo bus events", async () => {
    const app = new Hono()
    mountWorkspaceCore(app, (() => () => ({})) as never, { eventHub: createRuntimeEventHub(), exposure: loopbackExposure })

    const ac = new AbortController()
    const res = await app.request("http://localhost/api/wr/events", { signal: ac.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const reader = res.body!.getReader()
    workspaceRuntimeBus.publish({
      type: "agent.lifecycle",
      tabId: "tab_1",
      workspaceId: "ws_1",
      eventType: "Busy",
    })
    const next = await reader.read()
    ac.abort()

    expect(new TextDecoder().decode(next.value)).toContain("\"type\":\"agent.lifecycle\"")
  })

  test("workspace core replays runtime events after Last-Event-ID", async () => {
    const app = new Hono()
    const eventHub = createRuntimeEventHub()
    mountWorkspaceCore(app, (() => () => ({})) as never, { eventHub, exposure: loopbackExposure })

    eventHub.publishRuntime({
      directory: "/repo/main",
      sessionId: "session-1",
      payload: { type: "text-delta", delta: "old" },
    })
    eventHub.publishRuntime({
      directory: "/repo/main",
      sessionId: "session-1",
      payload: { type: "text-delta", delta: "new" },
    })

    const ac = new AbortController()
    const res = await app.request("http://localhost/api/wr/runtime-events", {
      headers: { "Last-Event-ID": "1" },
      signal: ac.signal,
    })
    const next = await res.body!.getReader().read()
    ac.abort()

    const frame = new TextDecoder().decode(next.value)
    expect(frame).toContain("id: 2")
    expect(frame).toContain("\"delta\":\"new\"")
    expect(frame).not.toContain("\"delta\":\"old\"")
  })

  test("workspace core emits a runtime replay gap when Last-Event-ID is stale", async () => {
    const app = new Hono()
    const eventHub = createRuntimeEventHub()
    mountWorkspaceCore(app, (() => () => ({})) as never, { eventHub, exposure: loopbackExposure })

    for (let i = 1; i <= 258; i += 1) {
      eventHub.publishRuntime({
        directory: "/repo/main",
        sessionId: "session-1",
        payload: { type: "text-delta", delta: String(i) },
      })
    }

    const ac = new AbortController()
    const res = await app.request("http://localhost/api/wr/runtime-events?directory=/repo/main", {
      headers: { "Last-Event-ID": "1" },
      signal: ac.signal,
    })
    const next = await res.body!.getReader().read()
    ac.abort()

    const frame = new TextDecoder().decode(next.value)
    expect(frame).toContain("runtime.sse_replay_gap")
    expect(frame).toContain("lastEventId")
    expect(frame).not.toContain("\"delta\":\"258\"")
  })
})
