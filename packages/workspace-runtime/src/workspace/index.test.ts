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
  test("a managed session-scoped wr/events closes after renewal denial", async () => {
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

    const response = await app.request("http://localhost/api/wr/events?sessionID=session-a")
    const reader = response.body!.getReader()
    const connected = await reader.read()
    const ended = await Promise.race([
      reader.read().then((result) => result.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ])
    await host.dispose()

    expect(connected.done).toBe(false)
    expect(new TextDecoder().decode(connected.value)).toContain("heartbeat")
    expect(ended).toBe(true)
    expect(authorizations).toBe(2)
  })

  test("a managed runtime without workspace authority requires a session, and scopes replay by it", async () => {
    const eventHub = createRuntimeEventHub()
    const host = createWorkspaceHost({ eventHub, sessionAccessPolicy: managedPolicy() })
    const app = new Hono()
    verifiedRelay(app)
    host.mount(app, { exposure: loopbackExposure })

    expect((await app.request("http://localhost/api/wr/events")).status).toBe(400)
    expect((await app.request("http://localhost/api/wr/events?sessionID=session-b")).status).toBe(403)

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

    const abort = new AbortController()
    const scoped = await app.request("http://localhost/api/wr/events?sessionID=session-a", {
      headers: { "Last-Event-ID": "0" },
      signal: abort.signal,
    })
    const text = await readUntil(scoped, "allowed-a")
    abort.abort()
    await host.dispose()

    expect(text).toContain('"sessionID":"session-a"')
    expect(text).not.toContain('"sessionID":"session-b"')
    expect(text).toContain("allowed-a")
    expect(text).not.toContain("secret-b")
  })

  test("mountWorkspaceCore registers the workspace routes", async () => {
    const app = new Hono()
    mountWorkspaceCore(app, (() => () => ({})) as never, { directory: "/workspace", eventHub: createRuntimeEventHub(), exposure: loopbackExposure })

    const seen = paths(app)
    expect(has(seen, "/api/wr/pty")).toBe(true)
    expect(has(seen, "/api/wr/hook")).toBe(true)
    expect(has(seen, "/api/wr/events")).toBe(true)
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
    expect(seen).not.toContain("/api/wr/provider-config")
    expect(seen).toContain("/api/wr/events")
    expect(seen.filter((path) => /event/.test(path))).toEqual(["/api/wr/events"])
    expect(seen).toContain("/session/status")

    const res = await app.request("http://localhost/api/wr/harness-config-options")
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: { code: "workspace_harness_not_configured" },
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
    mountWorkspaceCore(app, (() => () => ({})) as never, { directory: "/workspace", eventHub: createRuntimeEventHub(), exposure: loopbackExposure })

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
    // `/api/wr/events` opens with a cursor-bootstrap heartbeat, so the bus
    // frame is not the first chunk. Per-frame delivery is covered in
    // `routes/events.test.ts`; this test only proves the route is wired to the bus.
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

  test("workspace core replays wr/events frames after Last-Event-ID", async () => {
    const app = new Hono()
    const eventHub = createRuntimeEventHub()
    mountWorkspaceCore(app, (() => () => ({})) as never, { directory: "/workspace", eventHub, exposure: loopbackExposure })

    const first = new AbortController()
    const opened = await app.request("http://localhost/api/wr/events", { signal: first.signal })
    eventHub.publishGlobal(withDir("/repo/main", sessionIdle("old-session")))
    const seen = await readUntil(opened, "old-session")
    first.abort()
    const cursor = seen.split("\n\n").find((block) => block.includes("old-session"))
      ?.split("\n").find((line) => line.startsWith("id:"))?.slice("id:".length).trim()
    expect(cursor).toBeTruthy()
    eventHub.publishGlobal(withDir("/repo/main", sessionIdle("new-session")))

    const ac = new AbortController()
    const res = await app.request("http://localhost/api/wr/events", {
      headers: { "Last-Event-ID": cursor! },
      signal: ac.signal,
    })
    const text = await readUntil(res, "new-session")
    ac.abort()

    expect(text).toContain("new-session")
    expect(text).not.toContain("old-session")
  })

  test("workspace core emits a replay gap when Last-Event-ID is stale", async () => {
    const app = new Hono()
    const eventHub = createRuntimeEventHub()
    mountWorkspaceCore(app, (() => () => ({})) as never, { directory: "/workspace", eventHub, exposure: loopbackExposure })

    for (let i = 1; i <= 258; i += 1) {
      eventHub.publishGlobal(withDir("/repo/main", sessionIdle(`session-${i}`)))
    }

    const ac = new AbortController()
    const res = await app.request("http://localhost/api/wr/events?directory=/repo/main", {
      headers: { "Last-Event-ID": "1" },
      signal: ac.signal,
    })
    const text = await readUntil(res, "runtime.sse_replay_gap")
    ac.abort()

    expect(text).toContain("runtime.sse_replay_gap")
    expect(text).toContain("lastEventId")
    expect(text).not.toContain("session-258")
  })
})
