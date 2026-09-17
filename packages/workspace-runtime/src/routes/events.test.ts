import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { isRetainedWorkspaceEventFrame, workspaceEventsHandler } from "./events"
import { messagePartUpdated, withDir, type CompatEnvelope } from "../compat-events"
import type { SessionAccessPolicy } from "../session-access-policy"
import { sessionEventDeliveryPolicy } from "../event-delivery"

const DIRECTORY = "/workspace"

function part(sessionID: string, id: string, state: { status: "running" } | { status: "completed" }): CompatEnvelope {
  const tool = {
    id,
    sessionID,
    messageID: `msg-${sessionID}`,
    type: "tool" as const,
    callID: `call-${id}`,
    tool: "bash",
    state: state.status === "completed"
      ? { status: "completed" as const, input: {}, output: "ok", title: "bash", metadata: {}, time: { start: 1, end: 2 } }
      : { status: "running" as const, input: {}, time: { start: 1 } },
  }
  return withDir(DIRECTORY, messagePartUpdated(tool))
}

function harness(input: {
  policy?: SessionAccessPolicy
  parents?: Record<string, string>
  relayAuth?: Record<string, unknown>
}) {
  const app = new Hono()
  const hub = createRuntimeEventHub()
  const bus = createBus<WorkspaceRuntimeEvent>()
  if (input.relayAuth) {
    app.use("*", async (c, next) => {
      ;(c as any).set("relayHostAuth", input.relayAuth)
      await next()
    })
  }
  app.get("/api/wr/events", workspaceEventsHandler({
    directory: DIRECTORY,
    eventHub: hub,
    bus,
    ...(input.policy ? { sessionAccessPolicy: input.policy, policy: sessionEventDeliveryPolicy(input.policy) } : {}),
    ...(input.parents ? { sessionParents: { parentSessionIdFor: (id) => input.parents?.[id] } } : {}),
  }))
  return { app, hub, bus }
}

const managedPolicy = (input: {
  workspace?: "allow" | "deny" | "unavailable"
  session?: (sessionId: string) => boolean
}): SessionAccessPolicy => {
  const allow = { allowed: true } as const
  const deny = { allowed: false, status: 403, code: "denied", message: "denied" } as const
  return {
    sessionAuthority: "managed-private",
    authorize: () => allow,
    authorizeStream: async ({ sessionId }) =>
      input.session?.(sessionId) === false ? deny : { allowed: true, lease: "lease_test", expiresAt: Date.now() + 60_000 },
    authorizePrefix: () => allow,
    filterSessions: (i) => i.sessionIds,
    registerSession: () => allow,
    ...(input.workspace === "unavailable" ? {} : { authorizeHost: () => (input.workspace === "deny" ? deny : allow) }),
  }
}

const relayAuth = { actor_id: "actor_1", actor_kind: "human", org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role: "owner" }
const viewerAuth = { ...relayAuth, actor_id: "actor_2", role: "viewer" }

const readers = new WeakMap<Response, ReadableStreamDefaultReader<Uint8Array>>()
async function readUntil(response: Response, value: string, reads = 20) {
  const reader = readers.get(response) ?? response.body!.getReader()
  readers.set(response, reader)
  const decoder = new TextDecoder()
  let text = ""
  for (let i = 0; i < reads && !text.includes(value); i += 1) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  return text
}

function dataFrames(text: string) {
  return text.split("\n\n").flatMap((frame) => {
    const line = frame.split("\n").find((l) => l.startsWith("data:"))
    if (!line) return []
    try {
      return [JSON.parse(line.slice(5))]
    } catch {
      return []
    }
  })
}

describe("wr/events — one stream per workspace runtime", () => {
  test("carries projected turn frames, control frames and subagent revisions as {directory, payload}", async () => {
    const { app, hub, bus } = harness({})
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    hub.publishGlobal(part("ses-1", "prt-1", { status: "running" }))
    bus.publish({ type: "pty.exited", id: "pty-1", sessionId: "ses-1", exitCode: 0 })
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "ses-1", payload: { type: "subagent-updated", subagentKey: "child", revision: 1, status: "running" } })
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "ses-1", payload: { type: "text-delta", delta: "raw runtime frames stay off the wire" } })
    const text = await readUntil(response, "subagent.updated")
    controller.abort()

    const frames = dataFrames(text)
    const types = frames.map((f) => f.payload?.type ?? f.type)
    expect(types).toContain("message.part.updated")
    expect(types).toContain("pty.exited")
    expect(types).toContain("subagent.updated")
    expect(text).not.toContain("raw runtime frames stay off the wire")
    const pty = frames.find((f) => f.payload?.type === "pty.exited")
    expect(pty.directory).toBe(DIRECTORY)
  })

  test("a tool's settling part and a subagent's settlement are retained; starts and deltas are not", () => {
    expect(isRetainedWorkspaceEventFrame(part("s", "p", { status: "completed" }))).toBe(true)
    expect(isRetainedWorkspaceEventFrame(part("s", "p", { status: "running" }))).toBe(false)
    expect(isRetainedWorkspaceEventFrame({ directory: DIRECTORY, payload: { type: "pty.exited", id: "p", exitCode: 0 } })).toBe(true)
    expect(isRetainedWorkspaceEventFrame({ directory: DIRECTORY, payload: { type: "pty.created", info: { id: "p" } as never } })).toBe(false)
    expect(isRetainedWorkspaceEventFrame({
      directory: DIRECTORY,
      payload: { type: "subagent.updated", properties: { sessionID: "s", update: { subagentKey: "c", revision: 2, status: "completed" } } },
    })).toBe(true)
    expect(isRetainedWorkspaceEventFrame({
      type: "stream.replay-gap", code: "runtime.sse_replay_gap", message: "", severity: "warn",
    })).toBe(false)
  })

  test("a retained settlement survives a burst that rolls the ring", async () => {
    const { app, hub } = harness({})
    hub.publishGlobal(part("ses-1", "prt-done", { status: "completed" }))
    for (let i = 0; i < 300; i += 1) hub.publishGlobal(part("ses-1", `prt-${i}`, { status: "running" }))

    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": "0" }, signal: controller.signal })
    const text = await readUntil(response, "prt-done", 40)
    controller.abort()
    expect(text).toContain("prt-done")
  })

  test("the workspace's owner opens the stream unscoped on a managed runtime and sees every session", async () => {
    const { app, hub } = harness({ policy: managedPolicy({ workspace: "allow" }), relayAuth })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    expect(response.status).toBe(200)
    hub.publishGlobal(part("ses-a", "prt-a", { status: "running" }))
    hub.publishGlobal(part("ses-b", "prt-b", { status: "running" }))
    const text = await readUntil(response, "prt-b")
    controller.abort()
    expect(text).toContain("prt-a")
    expect(text).toContain("prt-b")
  })

  test("a workspace share reads the unscoped stream, but only the sessions the authority grants", async () => {
    const { app, hub, bus } = harness({
      policy: managedPolicy({ workspace: "allow", session: (id) => id === "shared" }),
      relayAuth: viewerAuth,
    })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    expect(response.status).toBe(200)
    hub.publishGlobal(part("private", "prt-private", { status: "running" }))
    bus.publish({ type: "pty.exited", id: "pty-x", exitCode: 0 })
    hub.publishGlobal(part("shared", "prt-shared", { status: "running" }))
    const text = await readUntil(response, "prt-shared")
    controller.abort()
    expect(text).toContain("pty-x")
    expect(text).toContain("prt-shared")
    expect(text).not.toContain("prt-private")
  })

  test("a principal without workspace access is refused the unscoped stream", async () => {
    const { app } = harness({ policy: managedPolicy({ workspace: "deny" }), relayAuth })
    const response = await app.request("http://localhost/api/wr/events")
    expect(response.status).toBe(403)
  })

  test("a runtime whose authority cannot answer for the workspace still requires a session", async () => {
    const { app } = harness({ policy: managedPolicy({ workspace: "unavailable" }), relayAuth })
    const response = await app.request("http://localhost/api/wr/events")
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("session_event_scope_required")
  })

  test("a share grantee's session-scoped stream carries that session and its subagent children only", async () => {
    const { app, hub, bus } = harness({
      policy: managedPolicy({ workspace: "deny", session: (id) => id === "shared" }),
      parents: { "child-of-shared": "shared" },
      relayAuth,
    })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events?sessionID=shared", { signal: controller.signal })
    expect(response.status).toBe(200)
    hub.publishGlobal(part("other", "prt-other", { status: "running" }))
    hub.publishGlobal(part("child-of-shared", "prt-child", { status: "running" }))
    bus.publish({ type: "pty.exited", id: "pty-x", exitCode: 0 })
    hub.publishGlobal(part("shared", "prt-shared", { status: "running" }))
    const text = await readUntil(response, "prt-shared")
    controller.abort()
    expect(text).toContain("prt-child")
    expect(text).toContain("prt-shared")
    expect(text).not.toContain("prt-other")
    expect(text).not.toContain("pty-x")
  })

  test("a grantee is refused a session the authority does not grant", async () => {
    const { app } = harness({ policy: managedPolicy({ workspace: "deny", session: () => false }), relayAuth })
    const response = await app.request("http://localhost/api/wr/events?sessionID=not-mine")
    expect(response.status).toBe(403)
  })

  test("a rolled cursor is answered with one gap notice and the stream stays live", async () => {
    const { app, hub } = harness({})
    for (let i = 0; i < 300; i += 1) hub.publishGlobal(part("ses-1", `prt-${i}`, { status: "running" }))
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": "1" }, signal: controller.signal })
    const gap = await readUntil(response, "stream.replay-gap")
    hub.publishGlobal(part("ses-1", "prt-after", { status: "running" }))
    const live = await readUntil(response, "prt-after")
    controller.abort()
    expect(gap).toContain("runtime.sse_replay_gap")
    expect(live).toContain("prt-after")
  })
})
