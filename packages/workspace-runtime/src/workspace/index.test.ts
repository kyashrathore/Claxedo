import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { workspaceRuntimeBus } from "../bus"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { sessionIdle, withDir } from "../compat-events"
import type { SessionAccessPolicy } from "../session-access-policy"
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

const managedPolicy = (): SessionAccessPolicy => ({
  sessionAuthority: "managed-private",
  authorize: (input) => input.sessionId === "session-a"
    ? { allowed: true }
    : { allowed: false, status: 403, code: "session_private", message: "private" },
  authorizeStream: (input) => input.sessionId === "session-a"
    ? { allowed: true, lease: "lease_test", expiresAt: Date.now() + 60_000 }
    : { allowed: false, status: 403, code: "session_private", message: "private" },
  authorizePrefix: () => ({ allowed: true }),
  filterSessions: (input) => input.sessionIds,
  registerSession: () => ({ allowed: true }),
})

function verifiedRelay(app: Hono) {
  app.use("*", async (c, next) => {
    ;(c as any).set("relayHostAuth", {
      actor_id: "actor_1",
      actor_kind: "human",
      org_id: "org_1",
      workspace_id: "ws_1",
      host_id: "host_1",
      role: "editor",
    })
    await next()
  })
}

async function readUntil(response: Response, expected: string) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (let reads = 0; reads < 20 && !text.includes(expected); reads += 1) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  return text
}

describe("workspace module wiring", () => {
  test("managed /global/event closes after renewal denial", async () => {
    const eventHub = createRuntimeEventHub()
    const accessPolicy = managedPolicy()
    let authorizations = 0
    accessPolicy.authorizeStream = () => {
      authorizations += 1
      return authorizations === 1
        ? { allowed: true, lease: "lease_initial", expiresAt: Date.now() + 40 }
        : { allowed: false, status: 403, code: "session_revoked", message: "revoked" }
    }
    const host = createWorkspaceHost({ eventHub, sessionAccessPolicy: accessPolicy })
    const app = new Hono()
    verifiedRelay(app)
    host.mount(app, { exposure: loopbackExposure })

    const response = await app.request("http://localhost/global/event?sessionID=session-a")
    const reader = response.body!.getReader()
    const connected = await reader.read()
    const ended = await Promise.race([
      reader.read().then((result) => result.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    host.dispose()

    expect(connected.done).toBe(false)
    expect(new TextDecoder().decode(connected.value)).toContain("server.connected")
    expect(ended).toBe(true)
    expect(authorizations).toBe(2)
  })

  test("managed /global/event and /event reject unscoped access and isolate replay by session", async () => {
    const eventHub = createRuntimeEventHub()
    const host = createWorkspaceHost({ eventHub, sessionAccessPolicy: managedPolicy() })
    const app = new Hono()
    verifiedRelay(app)
    host.mount(app, { exposure: loopbackExposure })

    expect((await app.request("http://localhost/global/event")).status).toBe(400)
    expect((await app.request("http://localhost/event")).status).toBe(400)
    expect((await app.request("http://localhost/global/event?sessionID=session-b")).status).toBe(403)

    eventHub.publishGlobal(withDir("/workspace", sessionIdle("session-b")))
    eventHub.publishGlobal(withDir("/workspace", sessionIdle("session-a")))
    workspaceRuntimeBus.publish({
      type: "agent.lifecycle",
      tabId: "private-b",
      sessionId: "session-b",
      prompt: "secret-b",
      eventType: "UserActionRequired",
    })
    workspaceRuntimeBus.publish({
      type: "agent.lifecycle",
      tabId: "private-a",
      sessionId: "session-a",
      prompt: "allowed-a",
      eventType: "UserActionRequired",
    })

    const globalAbort = new AbortController()
    const global = await app.request("http://localhost/global/event?sessionID=session-a", {
      headers: { "Last-Event-ID": "0" },
      signal: globalAbort.signal,
    })
    const globalText = await readUntil(global, '"sessionID":"session-a"')
    globalAbort.abort()

    const eventAbort = new AbortController()
    const session = await app.request("http://localhost/event?sessionID=session-a", {
      headers: { "Last-Event-ID": "0" },
      signal: eventAbort.signal,
    })
    const sessionText = await readUntil(session, "allowed-a")
    eventAbort.abort()
    host.dispose()

    expect(globalText).toContain('"sessionID":"session-a"')
    expect(globalText).not.toContain('"sessionID":"session-b"')
    expect(sessionText).toContain("allowed-a")
    expect(sessionText).not.toContain("secret-b")
  })

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
    expect(seen).toContain("/api/wr/provider-config")
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
    // `/api/wr/events` opens with a cursor-bootstrap heartbeat (see
    // `routes/runtime-events.ts`), so the bus frame is not the first chunk.
    // Per-frame delivery is covered in `routes/runtime-events.test.ts`; this
    // test only proves the route is wired to the bus.
    const decoder = new TextDecoder()
    let seen = ""
    for (let reads = 0; reads < 8 && !seen.includes("agent.lifecycle"); reads += 1) {
      const next = await reader.read()
      if (next.done) break
      seen += decoder.decode(next.value, { stream: true })
    }
    ac.abort()

    expect(seen).toContain("\"type\":\"agent.lifecycle\"")
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
