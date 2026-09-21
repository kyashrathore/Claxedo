import { describe, expect, test } from "bun:test"
import { Hono, type Context } from "hono"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { createRuntimeEventHub } from "../runtime-event-hub"
import { isRetainedWorkspaceEventFrame, workspaceEventsHandler, type WorkspaceEventStreamFrame } from "./events"
import { registerWorkspaceDirectory, unregisterWorkspaceDirectory } from "../target"
import { messagePartUpdated, sessionDeleted, withDir, type CompatEnvelope } from "../compat-events"
import type { SessionAccessPolicy } from "../session-access-policy"
import { sessionEventDeliveryPolicy } from "../event-delivery"

const DIRECTORY = "/workspace"
const WORKSPACE_ID = "ws-events-test"

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
  renewalIntervalMs?: number
}) {
  const app = new Hono()
  const hub = createRuntimeEventHub()
  const bus = createBus<WorkspaceRuntimeEvent>()
  // The ptys the runtime's pty service knows, by cwd; a test registers the
  // ones it exits or streams, the way a real pty exists before it exits.
  const ptys = new Map<string, string>()
  if (input.relayAuth) {
    app.use("*", async (c, next) => {
      ;(c as any).set("relayHostAuth", input.relayAuth)
      await next()
    })
  }
  const handler = workspaceEventsHandler({
    directory: DIRECTORY,
    workspaceId: WORKSPACE_ID,
    eventHub: hub,
    bus,
    sequenceOrigin: () => 0,
    ptyDirectory: (id) => ptys.get(id),
    ...(input.policy ? { sessionAccessPolicy: input.policy, policy: sessionEventDeliveryPolicy(input.policy) } : {}),
    ...(input.renewalIntervalMs !== undefined ? { renewalIntervalMs: input.renewalIntervalMs } : {}),
    ...(input.parents ? { sessionParents: { parentSessionIdFor: (id) => input.parents?.[id] } } : {}),
  })
  app.get("/api/wr/events", handler)
  return { app, hub, bus, ptys, frames: handler.frames }
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

/** Field-order-independent: Hono writes `data:` before `id:`. */
function frameId(text: string, marker: string) {
  const frame = text.split("\n\n").find((block) => block.includes(marker))
  return frame?.split("\n").find((line) => line.startsWith("id:"))?.slice(3).trim()
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
    const { app, hub, bus, ptys } = harness({})
    ptys.set("pty-1", DIRECTORY)
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

  test("the frame tap and the runtime's own stream are fed by one subscription: each of the three sources' frames reaches both once, verbatim", async () => {
    const { app, hub, bus, ptys, frames } = harness({})
    ptys.set("pty-tap", DIRECTORY)
    const tapped: WorkspaceEventStreamFrame[] = []
    const detach = frames.subscribe((frame) => tapped.push(frame))

    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    // One publish per source the handler subscribes: the compat hub, the
    // runtime hub whose envelopes it projects, and the process-global bus.
    hub.publishGlobal(part("ses-1", "prt-tap", { status: "completed" }))
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "ses-1", payload: { type: "subagent-updated", subagentKey: "child", revision: 1, status: "running" } })
    bus.publish({ type: "pty.exited", id: "pty-tap", sessionId: "ses-1", exitCode: 0 })
    const text = await readUntil(response, "pty.exited")
    controller.abort()

    const onStream = dataFrames(text).filter((frame) => frame.payload)
    expect(onStream.map((frame) => frame.payload.type)).toEqual(["message.part.updated", "subagent.updated", "pty.exited"])
    expect(tapped).toEqual(onStream)

    // The tap is the handler's, not a connection's: a runtime nobody is
    // reading directly still feeds the host that aggregates it.
    bus.publish({ type: "pty.exited", id: "pty-tap", sessionId: "ses-1", exitCode: 1 })
    expect(tapped).toHaveLength(4)
    detach()
    bus.publish({ type: "pty.exited", id: "pty-tap", sessionId: "ses-1", exitCode: 2 })
    expect(tapped).toHaveLength(4)
  })

  test("the process-global bus reaches a workspace's stream only with that workspace's frames", async () => {
    const { app, hub, bus, ptys } = harness({})
    ptys.set("pty-here", `${DIRECTORY}/sub`)
    ptys.set("pty-elsewhere", "/elsewhere")
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    bus.publish({ type: "process.started", directory: "/elsewhere", configId: "cfg-elsewhere", ptyId: "pty-elsewhere" })
    bus.publish({ type: "pty.created", info: { id: "pty-new-elsewhere", title: "t", command: "sh", args: [], cwd: "/elsewhere", status: "running", pid: 1 } })
    bus.publish({ type: "pty.exited", id: "pty-elsewhere", exitCode: 0 })
    bus.publish({ type: "session.lifecycle", phase: "created", directory: "/elsewhere", sessionID: "ses-elsewhere", ts: 1 })
    bus.publish({ type: "agent.lifecycle", tabId: "tab", terminalId: "pty-elsewhere", eventType: "Busy" })
    bus.publish({ type: "pty.created", info: { id: "pty-new-here", title: "t", command: "sh", args: [], cwd: `${DIRECTORY}/sub`, status: "running", pid: 2 } })
    bus.publish({ type: "pty.exited", id: "pty-here", exitCode: 0 })
    bus.publish({ type: "agent.lifecycle", tabId: "tab", terminalId: "pty-here", eventType: "Idle" })
    ptys.delete("pty-here")
    bus.publish({ type: "pty.deleted", id: "pty-here" })
    bus.publish({ type: "process.started", directory: DIRECTORY, configId: "cfg-here", ptyId: "pty-new-here" })
    // A per-session worktree lives under the storage root, not the workspace
    // directory; it is this runtime's because the workspace registered it.
    registerWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses-wt", directory: "/storage/worktrees/ses-wt" })
    bus.publish({ type: "session.lifecycle", phase: "created", directory: "/storage/worktrees/ses-wt", sessionID: "ses-wt", ts: 2 })
    bus.publish({ type: "pty.created", info: { id: "pty-wt", title: "t", command: "sh", args: [], cwd: "/storage/worktrees/ses-wt/sub", status: "running", pid: 3 } })
    bus.publish({ type: "agent.lifecycle", tabId: "tab", workspaceId: WORKSPACE_ID, eventType: "Busy" })
    hub.publishGlobal(part("ses-1", "prt-last", { status: "running" }))
    const text = await readUntil(response, "prt-last")
    controller.abort()
    unregisterWorkspaceDirectory({ workspaceId: WORKSPACE_ID, sessionId: "ses-wt" })

    const frames = dataFrames(text)
    const payloads = frames.map((f) => f.payload).filter(Boolean)
    expect(payloads.map((p) => p.type)).toEqual([
      "pty.created", "pty.exited", "agent.lifecycle", "pty.deleted", "process.started",
      "session.lifecycle", "pty.created", "agent.lifecycle", "message.part.updated",
    ])
    expect(frames.find((f) => f.payload?.type === "session.lifecycle")?.directory).toBe("/storage/worktrees/ses-wt")
    expect(payloads.find((p) => p.type === "pty.created")?.info?.id).toBe("pty-new-here")
    expect(frames.find((f) => f.payload?.type === "pty.exited")?.directory).toBe(DIRECTORY)
    expect(text).not.toContain("elsewhere")
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

  test("a principal admitted to the workspace opens the stream unscoped and sees every session the authority grants", async () => {
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

  test.each([relayAuth, viewerAuth])("the unscoped stream carries a session's frames — parts, subagents, goals, its pty — only to a principal the authority grants it (role %#)", async (auth) => {
    const { app, hub, bus, ptys } = harness({
      policy: managedPolicy({ workspace: "allow", session: (id) => id === "shared" }),
      relayAuth: auth,
    })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    expect(response.status).toBe(200)
    hub.publishGlobal(part("private", "prt-private", { status: "running" }))
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "private", payload: { type: "subagent-updated", subagentKey: "private-child", revision: 1, status: "running" } })
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "private", payload: { type: "goal-updated", sessionId: "private", goal: { id: "g", status: "active", text: "private-goal" } as never } })
    ptys.set("pty-private", DIRECTORY)
    ptys.set("pty-workspace", DIRECTORY)
    bus.publish({ type: "pty.exited", id: "pty-private", sessionId: "private", exitCode: 0, tail: "private-terminal-bytes" })
    bus.publish({ type: "pty.exited", id: "pty-workspace", exitCode: 0 })
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "shared", payload: { type: "subagent-updated", subagentKey: "shared-child", revision: 1, status: "running" } })
    hub.publishGlobal(part("shared", "prt-shared", { status: "running" }))
    const text = await readUntil(response, "prt-shared")
    controller.abort()
    expect(text).toContain("pty-workspace")
    expect(text).toContain("shared-child")
    expect(text).toContain("prt-shared")
    expect(text).not.toContain("prt-private")
    expect(text).not.toContain("private-child")
    expect(text).not.toContain("private-goal")
    expect(text).not.toContain("private-terminal-bytes")
  })

  test("a principal without workspace access is refused the unscoped stream, by a code only that refusal carries", async () => {
    const { app } = harness({ policy: managedPolicy({ workspace: "deny" }), relayAuth })
    const response = await app.request("http://localhost/api/wr/events")
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: "workspace_event_stream_denied", message: "denied", cause: "denied" } })
  })

  test("a runtime whose authority cannot answer for the workspace still requires a session", async () => {
    const { app } = harness({ policy: managedPolicy({ workspace: "unavailable" }), relayAuth })
    const response = await app.request("http://localhost/api/wr/events")
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("session_event_scope_required")
  })

  test("a share grantee's session-scoped stream carries that session and its subagent children only", async () => {
    const parents: Record<string, string> = { "child-of-shared": "shared" }
    const { app, hub, bus, ptys } = harness({
      policy: managedPolicy({ workspace: "deny", session: (id) => id === "shared" }),
      parents,
      relayAuth,
      renewalIntervalMs: 20,
    })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events?sessionID=shared", { signal: controller.signal })
    expect(response.status).toBe(200)
    hub.publishGlobal(part("other", "prt-other", { status: "running" }))
    hub.publishGlobal(part("child-of-shared", "prt-child", { status: "running" }))
    ptys.set("pty-x", DIRECTORY)
    ptys.set("pty-shared", DIRECTORY)
    bus.publish({ type: "pty.exited", id: "pty-x", exitCode: 0 })
    bus.publish({ type: "pty.exited", id: "pty-shared", sessionId: "shared", exitCode: 0 })
    hub.publishRuntime({ directory: DIRECTORY, sessionId: "shared", payload: { type: "subagent-updated", subagentKey: "shared-child", revision: 1, status: "running" } })
    hub.publishGlobal(part("shared", "prt-shared", { status: "running" }))
    const text = await readUntil(response, "prt-shared")
    expect(text).toContain("prt-child")
    expect(text).toContain("pty-shared")
    expect(text).toContain("shared-child")
    expect(text).toContain("prt-shared")
    expect(text).not.toContain("prt-other")
    expect(text).not.toContain("pty-x")
    // The child's deletion is published after its row is gone, so the frame
    // names its parent itself; it reaches the parent's grantee, and the
    // parent's grant survives it — the next parent frame still arrives.
    delete parents["child-of-shared"]
    hub.publishGlobal(withDir(DIRECTORY, sessionDeleted("child-of-shared", DIRECTORY, "shared")))
    expect(await readUntil(response, "session.deleted")).toContain("child-of-shared")
    await new Promise((resolve) => setTimeout(resolve, 60))
    hub.publishGlobal(part("shared", "prt-shared-2", { status: "running" }))
    expect(await readUntil(response, "prt-shared-2")).toContain("prt-shared-2")
    controller.abort()
  })

  test("a session-scoped reader's cursor is contiguous: its ring numbers only that session's frames, and a workspace frame in between is not a hole", async () => {
    // The same actor holds the unscoped arm in another tab, whose ring
    // numbers every workspace frame; the session-scoped tab's ring is its own.
    const policy = managedPolicy({ workspace: "allow", session: (id) => id === "shared" || id === "other" })
    policy.authorizeHost = () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 })
    const { app, hub, bus } = harness({ policy, relayAuth })
    const wide = new AbortController()
    const unscoped = await app.request("http://localhost/api/wr/events", { signal: wide.signal })
    const first = new AbortController()
    const response = await app.request("http://localhost/api/wr/events?sessionID=shared", { signal: first.signal })
    hub.publishGlobal(part("shared", "prt-1", { status: "running" }))
    const cursor = frameId(await readUntil(response, "prt-1"), "prt-1")
    first.abort()
    // Frames the session arm never carries, numbered by the workspace ring only.
    bus.publish({ type: "process.status", directory: DIRECTORY, configId: "svc", status: "running" })
    hub.publishGlobal(part("other", "prt-other", { status: "running" }))
    hub.publishGlobal(part("shared", "prt-2", { status: "completed" }))
    const second = new AbortController()
    const reconnect = await app.request("http://localhost/api/wr/events?sessionID=shared", { headers: { "Last-Event-ID": cursor! }, signal: second.signal })
    const replayed = await readUntil(reconnect, "prt-2")
    second.abort()
    expect(replayed).toContain("prt-2")
    expect(replayed).not.toContain("runtime.sse_replay_gap")
    expect(replayed).not.toContain("prt-other")
    expect(Number(frameId(replayed, "prt-2"))).toBe(Number(cursor) + 1)
    expect(await readUntil(unscoped, "prt-other")).toContain("prt-other")
    wide.abort()
  })

  test("a grantee is refused a session the authority does not grant, by the runtime's own named refusal", async () => {
    const { app } = harness({ policy: managedPolicy({ workspace: "deny", session: () => false }), relayAuth })
    const response = await app.request("http://localhost/api/wr/events?sessionID=not-mine")
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "session_event_stream_denied", cause: "denied" } })
  })

  test("opens with a heartbeat carrying the cursor the connection resumes from; a cursor-less connection is served nothing from the ring", async () => {
    // The regression this guards: the reader unwraps `{directory, payload}`
    // frames and applies them, so a full re-read on every fresh connection
    // re-upserts already-answered permission and question requests.
    const { app, hub } = harness({})
    hub.publishGlobal(part("ses-1", "prt-before", { status: "running" }))
    hub.publishGlobal(part("ses-1", "prt-before-2", { status: "running" }))
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    const opened = await readUntil(response, "heartbeat", 1)
    expect(frameId(opened, "heartbeat")).toBe("2")
    hub.publishGlobal(part("ses-1", "prt-after", { status: "running" }))
    const text = await readUntil(response, "prt-after")
    controller.abort()
    expect(text).not.toContain("prt-before")
    expect(frameId(text, "prt-after")).toBe("3")
  })

  test("a frame published while disconnected is delivered on the next Last-Event-ID reconnect", async () => {
    const { app, hub } = harness({})
    const first = new AbortController()
    const opened = await readUntil(await app.request("http://localhost/api/wr/events", { signal: first.signal }), "heartbeat", 1)
    expect(frameId(opened, "heartbeat")).toBe("0")
    first.abort()
    hub.publishGlobal(part("ses-1", "prt-during-gap", { status: "running" }))
    const second = new AbortController()
    const text = await readUntil(await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": "0" }, signal: second.signal }), "prt-during-gap")
    second.abort()
    expect(frameId(text, "prt-during-gap")).toBe("1")
  })

  test("an actor stamped in process (cookie auth, no bearer) resumes its own scope by cursor across reconnects", async () => {
    const embeddedAuth = { principal_kind: "user", actor_id: "actor_embedded", actor_kind: "human", actor_public_id: "p", actor_name: "n", org_id: "org_1", workspace_id: "ws_1", role: "owner" }
    const { app, hub } = harness({ policy: managedPolicy({ workspace: "allow" }), relayAuth: embeddedAuth })
    const first = new AbortController()
    const firstResponse = await app.request("http://localhost/api/wr/events", { signal: first.signal })
    hub.publishGlobal(part("ses-1", "prt-seen", { status: "completed" }))
    const seen = await readUntil(firstResponse, "prt-seen")
    first.abort()
    const cursor = frameId(seen, "prt-seen")
    hub.publishGlobal(part("ses-1", "prt-missed", { status: "completed" }))
    const second = new AbortController()
    const text = await readUntil(await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor! }, signal: second.signal }), "prt-missed")
    second.abort()
    expect(text).not.toContain("stream.replay-gap")
    expect(text).not.toContain("prt-seen")
  })

  test("resuming from a mid-log cursor replays only what follows it", async () => {
    const { app, hub } = harness({})
    hub.publishGlobal(part("ses-1", "prt-old", { status: "running" }))
    hub.publishGlobal(part("ses-1", "prt-new", { status: "running" }))
    const controller = new AbortController()
    const text = await readUntil(await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": "1" }, signal: controller.signal }), "prt-new")
    controller.abort()
    expect(text).not.toContain("prt-old")
  })

  test.each(["abc", "1 data: injected", "-1", "1.5", "0x10"])(
    "a Last-Event-ID outside the stream's cursor grammar is refused 400, not opened as a stream (%j)",
    async (cursor) => {
      const { app } = harness({})
      const response = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor } })
      expect(response.status).toBe(400)
      expect(response.headers.get("content-type")).not.toContain("text/event-stream")
      expect(await response.json()).toEqual({
        error: { code: "event_stream_cursor_invalid", message: "Last-Event-ID is not a cursor this stream issues" },
      })
    },
  )

  test("a Last-Event-ID carrying CR/LF is refused before admission touches anything else", async () => {
    // Fetch Headers cannot transmit CR/LF in a value; drive the handler with
    // the cursor a less strict adapter would surface. The context offers only
    // what a rejection needs, so any admission work attempted first throws.
    const handler = workspaceEventsHandler({
      directory: DIRECTORY,
      workspaceId: WORKSPACE_ID,
      eventHub: createRuntimeEventHub(),
      bus: createBus<WorkspaceRuntimeEvent>(),
    })
    const cursor = "1\r\nevent: injected\ndata: {}\n\nid: 9"
    const c = {
      req: { header: (name: string) => (name === "last-event-id" ? cursor : undefined) },
      json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
    } as unknown as Context
    const response = await handler(c)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: { code: "event_stream_cursor_invalid", message: "Last-Event-ID is not a cursor this stream issues" },
    })
  })

  test("a session-scoped reader's first frame rides the lease it was admitted with, not the request's token", async () => {
    const asked: Array<string | undefined> = []
    const policy = managedPolicy({ workspace: "deny" })
    policy.authorizeStream = async (_input, lease) => {
      asked.push(lease)
      return { allowed: true, lease: "lease_session", expiresAt: Date.now() + 60_000 }
    }
    const { app, hub } = harness({ policy, relayAuth })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events?sessionID=shared", { signal: controller.signal })
    expect(response.status).toBe(200)
    hub.publishGlobal(part("shared", "prt-first", { status: "running" }))
    expect(await readUntil(response, "prt-first")).toContain("prt-first")
    controller.abort()
    // One authority call: the scope's. The frame was granted on its lease.
    // (`toEqual` reads `[undefined, undefined]` as `[undefined]`.)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toBeUndefined()
  })

  test("a client gone during the open is released, not kept as a subscriber the authority is asked for", async () => {
    const asked: string[] = []
    const policy = managedPolicy({ workspace: "allow" })
    policy.authorizeHost = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 }
    }
    policy.authorizeStream = async ({ sessionId }) => {
      asked.push(sessionId ?? "")
      return { allowed: true, lease: "l", expiresAt: Date.now() + 60_000 }
    }
    const { app, hub } = harness({ policy, relayAuth })
    const controller = new AbortController()
    const pending = app.request("http://localhost/api/wr/events", { signal: controller.signal })
    controller.abort()
    const response = await pending
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 20))
    hub.publishGlobal(part("ses_b", "prt-b", { status: "running" }))
    hub.publishGlobal(part("ses_c", "prt-c", { status: "running" }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(asked).toEqual([])
  })

  test("a create's own protocol before the session exists reaches its creator and no other admitted reader", async () => {
    const policy = managedPolicy({ workspace: "allow" })
    const { app, bus } = harness({ policy, relayAuth })
    const creator = new AbortController()
    const other = new AbortController()
    const mine = await app.request("http://localhost/api/wr/events", { signal: creator.signal })
    // The harness binds one relay identity per app, so the viewer reads a
    // second runtime that publishes the same frames.
    const app2 = harness({ policy, relayAuth: viewerAuth })
    const theirs = await app2.app.request("http://localhost/api/wr/events", { signal: other.signal })
    const creating = { type: "session.lifecycle" as const, phase: "creating" as const, directory: DIRECTORY, draftId: "draft_1", actorId: "actor_1", ts: 1 }
    bus.publish(creating)
    app2.bus.publish(creating)
    const unscoped = { type: "session.lifecycle" as const, phase: "failed" as const, directory: DIRECTORY, message: "nobody's", ts: 2 }
    bus.publish(unscoped)
    app2.bus.publish(unscoped)
    expect(await readUntil(mine, "draft_1")).toContain("draft_1")
    // The actor-less frame arrives; the creator's does not.
    const seen = await readUntil(theirs, "nobody's")
    expect(seen).toContain("nobody's")
    expect(seen).not.toContain("draft_1")
    creator.abort()
    other.abort()
  })

  test("a reconnect while the authority is still away reads a gap, never a contiguous ring over the frame it could not decide", async () => {
    let away = false
    const policy = managedPolicy({ workspace: "allow" })
    policy.authorizeHost = () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 })
    policy.authorizeStream = async ({ sessionId }) =>
      away && sessionId === "ses_b"
        ? { allowed: false, status: 503, code: "authority_unavailable", message: "away" }
        : { allowed: true, lease: `lease_${sessionId}`, expiresAt: Date.now() + 60_000 }
    const { app, hub } = harness({ policy, relayAuth })
    const first = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: first.signal })
    hub.publishGlobal(part("ses_a", "prt-a", { status: "running" }))
    const seen = await readUntil(response, "prt-a")
    const cursor = frameId(seen, "prt-a")
    expect(cursor).toBeTruthy()
    // The plane goes away; a session first seen now cannot be decided, and
    // its frame settles a state (a retained kind), so the stream ends.
    away = true
    hub.publishGlobal(part("ses_b", "prt-b", { status: "completed" }))
    expect((await readers.get(response)!.read()).done).toBe(true)
    first.abort()
    // Still away: the reconnect's rebuilt ring cannot hold the frame either.
    const second = new AbortController()
    const reconnect = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor! }, signal: second.signal })
    const replayed = await readUntil(reconnect, "runtime.sse_replay_gap")
    expect(replayed).toContain("runtime.sse_replay_gap")
    expect(replayed).not.toContain("prt-b")
    // A second tab of the same actor, same cursor, while the first stays
    // attached: the hole is the ring's, not the first reconnect's to consume.
    const third = new AbortController()
    const other = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor! }, signal: third.signal })
    expect(await readUntil(other, "runtime.sse_replay_gap")).toContain("runtime.sse_replay_gap")
    second.abort()
    third.abort()
  })

  test("deleting a session the reader held does not end the workspace arm at the next renewal", async () => {
    const alive = new Set(["ses_mine"])
    const policy = managedPolicy({ workspace: "allow", session: (id) => alive.has(id) })
    policy.authorizeHost = () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 })
    const { app, hub } = harness({ policy, relayAuth, renewalIntervalMs: 20 })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events", { signal: controller.signal })
    hub.publishGlobal(part("ses_mine", "prt-mine", { status: "running" }))
    expect(await readUntil(response, "prt-mine")).toContain("prt-mine")
    alive.delete("ses_mine")
    hub.publishGlobal(withDir(DIRECTORY, sessionDeleted("ses_mine", DIRECTORY)))
    expect(await readUntil(response, "session.deleted")).toContain("session.deleted")
    await new Promise((resolve) => setTimeout(resolve, 80))
    // The stream is still live: a later frame of another granted session arrives.
    alive.add("ses_other")
    hub.publishGlobal(part("ses_other", "prt-other", { status: "running" }))
    expect(await readUntil(response, "prt-other")).toContain("prt-other")
    controller.abort()
  })

  test("a revoked session lease ends the reader and no later frame of that session reaches it", async () => {
    let authorityCalls = 0
    const policy = managedPolicy({ workspace: "deny" })
    policy.authorizeStream = async () => {
      authorityCalls += 1
      return authorityCalls === 1
        ? { allowed: true, lease: "lease_short", expiresAt: Date.now() + 30 }
        : { allowed: false, status: 403, code: "session_revoked", message: "revoked" }
    }
    const { app, hub } = harness({ policy, relayAuth, renewalIntervalMs: 20 })
    const controller = new AbortController()
    const response = await app.request("http://localhost/api/wr/events?sessionID=shared", { signal: controller.signal })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    readers.set(response, reader)
    expect((await reader.read()).done).toBe(false)
    const ended = await Promise.race([
      reader.read().then((item) => item.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])
    hub.publishGlobal(part("shared", "prt-after-revoke", { status: "running" }))
    expect(ended).toBe(true)
    expect((await reader.read()).done).toBe(true)
    controller.abort()
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
