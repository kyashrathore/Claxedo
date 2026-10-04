import { Hono } from "hono"
import { cors } from "hono/cors"
import { defineWebSocketHelper, WSContext } from "hono/ws"
import { expect, test, vi } from "vitest"
import { createBus, type ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { createControlPlaneEventsHandler } from "./events"
import { eventStreamResponse, type UpgradeWebSocket } from "./event-stream-response"

function transport() {
  const connections: Array<{ frames: string[]; disconnect(): void }> = []
  const upgrade = defineWebSocketHelper((c, events) => {
    const frames: string[] = []
    const socket = new WSContext({
      readyState: 1,
      raw: { send(data: Uint8Array, done: (error?: Error) => void) { frames.push(new TextDecoder().decode(data)); done() } },
      send: (data) => frames.push(typeof data === "string" ? data : new TextDecoder().decode(data)),
      close() {},
    })
    const nativeSocket = socket as unknown as Parameters<NonNullable<typeof events.onOpen>>[1]
    connections.push({ frames, disconnect: () => events.onClose?.(new Event("close") as CloseEvent, nativeSocket) })
    events.onOpen?.(new Event("open"), nativeSocket)
    return c.newResponse(null)
  }) as UpgradeWebSocket
  return { connections, upgrade }
}

test("WebSocket uses the authorized central producer, retains cursors, and detaches on close", async () => {
  const bus = createBus<ControlPlaneEvent>()
  const wire = transport()
  let visible = true
  const app = new Hono().get("/events", createControlPlaneEventsHandler(bus, {
    upgradeWebSocket: wire.upgrade,
    resolveSubscription: () => ({ identity: { mode: "unmanaged-local", connectionId: "test" }, visible: () => visible }),
  }))
  await app.request("http://localhost/events", { headers: { upgrade: "websocket" } })
  const first = wire.connections[0]
  try {
    await expect.poll(() => first.frames.length).toBe(1)
    bus.publish({ type: "worktree.ready", directory: "/repo/.worktrees/owner", name: "owner", branch: "owner" })
    await expect.poll(() => first.frames.length).toBe(2)
    expect(first.frames[1]).toContain('"name":"owner"')
    const cursor = /\nid: ([^\n]+)/.exec(first.frames[1])![1]
    first.disconnect()
    const closedLength = first.frames.length
    bus.publish({ type: "worktree.ready", directory: "/repo/.worktrees/after-close", name: "after-close", branch: "after-close" })
    await app.request(`http://localhost/events?lastEventId=${cursor}`, { headers: { upgrade: "websocket" } })
    const resumed = wire.connections[1]
    await expect.poll(() => resumed.frames.some((frame) => frame.includes('"name":"after-close"'))).toBe(true)
    expect(first.frames).toHaveLength(closedLength)
    visible = false
    bus.publish({ type: "worktree.ready", directory: "/repo/.worktrees/hidden", name: "hidden", branch: "hidden" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(resumed.frames.join("")).not.toContain('"name":"hidden"')
  } finally {
    for (const connection of wire.connections) connection.disconnect()
  }
})

test("HTTP SSE and unsupported WebSocket requests do not bypass their transport contract", async () => {
  const write = vi.fn(async (stream: Parameters<Parameters<typeof eventStreamResponse>[1]>[0]) => {
    await stream.writeSSE({ id: "7", data: "first\nsecond" })
  })
  const app = new Hono().get("/events", (c) => eventStreamResponse(c, write))
  const crossOrigin = await app.request("http://localhost/events", { headers: { upgrade: "websocket", origin: "https://untrusted.example" } })
  expect(crossOrigin.status).toBe(403)
  expect(write).not.toHaveBeenCalled()
  const denied = await app.request("http://localhost/events", { headers: { upgrade: "websocket" } })
  expect(denied.status).toBe(501)
  expect(write).not.toHaveBeenCalled()
  const response = await app.request("http://localhost/events")
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  expect(await response.text()).toBe("data: first\ndata: second\nid: 7\n\n")
})

test("WebSocket upgrade honors the composition's explicit CORS origin decision", async () => {
  const wire = transport()
  const write = vi.fn(async () => {})
  const app = new Hono()
    .use(cors({ origin: "http://localhost:4470" }))
    .get("/events", (c) => eventStreamResponse(c, write, wire.upgrade))
  const denied = await app.request("http://localhost/events", {
    headers: { upgrade: "websocket", origin: "https://untrusted.example" },
  })
  expect(denied.status).toBe(403)
  expect(wire.connections).toHaveLength(0)
  const allowed = await app.request("http://localhost/events", {
    headers: { upgrade: "websocket", origin: "http://localhost:4470" },
  })
  expect(allowed.status).toBe(200)
  expect(wire.connections).toHaveLength(1)
  wire.connections[0].disconnect()
})

test("a same-host WebSocket origin is judged by the Host the client connected to", async () => {
  const write = vi.fn(async () => {})
  const wire = transport()
  const app = new Hono().get("/events", (c) => eventStreamResponse(c, write, wire.upgrade))
  // The node-ws upgrade path hands the app a `http://localhost/...` URL while
  // the client connected to, and names in `Origin`, the daemon's real host:port.
  const sameHost = await app.request("http://localhost/events", {
    headers: { upgrade: "websocket", host: "127.0.0.1:2593", origin: "http://127.0.0.1:2593" },
  })
  expect(sameHost.status).not.toBe(403)
  expect(wire.connections).toHaveLength(1)
  const otherPort = await app.request("http://localhost/events", {
    headers: { upgrade: "websocket", host: "127.0.0.1:2593", origin: "http://127.0.0.1:1" },
  })
  expect(otherPort.status).toBe(403)
  expect(wire.connections).toHaveLength(1)
  for (const connection of wire.connections) connection.disconnect()
})
