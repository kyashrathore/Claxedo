import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { runtimeBusEventsHandler } from "./runtime-events"
import type { SessionAccessPolicy } from "../session-access-policy"

function mount(bus: ReturnType<typeof createBus<WorkspaceRuntimeEvent>>, policy?: SessionAccessPolicy) {
  const app = new Hono()
  if (policy) {
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
  app.get("/api/wr/events", runtimeBusEventsHandler(bus, policy))
  return app
}

const managedPolicy = (): SessionAccessPolicy => ({
  sessionAuthority: "managed-private",
  authorize: (input) => input.sessionId === "session-a"
    ? { allowed: true }
    : { allowed: false, status: 403, code: "session_private", message: "private" },
  authorizePrefix: () => ({ allowed: true }),
  filterSessions: (input) => input.sessionIds,
  registerSession: () => ({ allowed: true }),
})

type Connection = {
  /** Everything decoded from the stream so far. */
  text: () => string
  /** Reads chunks until `match` is satisfied by the accumulated text, or fails. */
  until: (match: (text: string) => boolean, label: string) => Promise<string>
  close: () => void
}

async function connect(app: Hono, lastEventId?: string, sessionID?: string): Promise<Connection> {
  const ac = new AbortController()
  const url = new URL("http://localhost/api/wr/events")
  if (sessionID) url.searchParams.set("sessionID", sessionID)
  const res = await app.request(url, {
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": lastEventId } }),
    signal: ac.signal,
  })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  return {
    text: () => text,
    async until(match, label) {
      // Bounded by the test runner's own timeout via a read budget: each frame
      // this handler writes arrives as its own chunk, so a match that never
      // comes shows up as a small, deterministic number of reads.
      for (let reads = 0; reads < 40; reads += 1) {
        if (match(text)) return text
        const next = await reader.read()
        if (next.done) break
        text += decoder.decode(next.value, { stream: true })
      }
      if (match(text)) return text
      throw new Error(`${label}\n--- stream so far ---\n${text}`)
    },
    close: () => ac.abort(),
  }
}

const lifecycle = (tabId: string): WorkspaceRuntimeEvent => ({
  type: "agent.lifecycle",
  tabId,
  workspaceId: "ws_1",
  eventType: "Busy",
})

/**
 * Field-order-independent frame split. Hono writes `data:` before `id:`; SSE
 * readers (claxedo-app's inline loop, `sseJsonStream`) scan the frame's lines
 * for each field rather than relying on order, so the tests do too.
 */
function frames(text: string) {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n")
      return {
        id: lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim(),
        data: lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim(),
      }
    })
}

/** The cursor the connection resumed from — always carried by the first frame. */
function bootstrapId(text: string) {
  return frames(text)[0]?.id
}

describe("runtimeBusEventsHandler — /api/wr/events replay", () => {
  test("managed stream requires an authorized session scope", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus, managedPolicy())

    expect((await app.request("http://localhost/api/wr/events")).status).toBe(400)
    expect((await app.request("http://localhost/api/wr/events?sessionID=session-b")).status).toBe(403)
  })

  test("managed stream filters replay and live lifecycle frames to the authorized session", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus, managedPolicy())
    bus.publish({ type: "agent.lifecycle", tabId: "b-before", sessionId: "session-b", eventType: "UserActionRequired", prompt: "secret-b" })
    bus.publish({ type: "agent.lifecycle", tabId: "a-before", sessionId: "session-a", eventType: "UserActionRequired", prompt: "allowed-a" })

    const stream = await connect(app, "0", "session-a")
    let text = await stream.until((seen) => seen.includes("allowed-a"), "authorized replay missing")
    bus.publish({ type: "agent.lifecycle", tabId: "b-live", sessionId: "session-b", eventType: "Busy", lastAssistantMessage: "secret-live-b" })
    bus.publish({ type: "session.lifecycle", phase: "created", sessionID: "session-a", message: "allowed-live-a", ts: 1 })
    text = await stream.until((seen) => seen.includes("allowed-live-a"), "authorized live frame missing")
    stream.close()

    expect(text).not.toContain("secret-b")
    expect(text).not.toContain("secret-live-b")
  })

  test("opens with a heartbeat carrying the cursor the connection resumes from", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)
    bus.publish(lifecycle("tab_1"))
    bus.publish(lifecycle("tab_2"))

    const stream = await connect(app)
    const text = await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    stream.close()

    expect(frames(text)[0]).toEqual({ id: "2", data: "{\"type\":\"heartbeat\"}" })
  })

  test("bootstraps at cursor 0 when nothing has been published yet", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const stream = await connect(mount(bus))
    const text = await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    stream.close()

    expect(bootstrapId(text)).toBe("0")
  })

  test("a cursor-less connection is NOT served the retained log", async () => {
    // The regression this guards: claxedo-app's reader unwraps `{directory,
    // payload}` frames and applies them, so a full re-read on every fresh
    // connection re-upserts already-answered permission/question requests.
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)
    bus.publish(lifecycle("tab_before"))

    const stream = await connect(app)
    await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    bus.publish(lifecycle("tab_after"))
    const text = await stream.until((seen) => seen.includes("tab_after"), "live frame never arrived")
    stream.close()

    expect(text).not.toContain("tab_before")
  })

  test("live frames carry an `id:` line so the reader builds a cursor", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)

    const stream = await connect(app)
    await stream.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    bus.publish(lifecycle("tab_live"))
    const text = await stream.until((seen) => seen.includes("tab_live"), "live frame never arrived")
    stream.close()

    const live = frames(text).find((frame) => frame.data?.includes("tab_live"))
    expect(live?.id).toBe("1")
  })

  test("a frame published while disconnected is delivered on the next Last-Event-ID reconnect", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)

    // A reader that has never seen a frame still leaves with a cursor.
    const first = await connect(app)
    const opened = await first.until((seen) => seen.includes("heartbeat"), "no cursor bootstrap frame")
    const cursor = bootstrapId(opened)
    expect(cursor).toBe("0")
    first.close()

    // The frame-loss window: published with no connection attached.
    bus.publish(lifecycle("tab_during_gap"))

    const second = await connect(app, cursor)
    const text = await second.until((seen) => seen.includes("tab_during_gap"), "gap frame was lost")
    second.close()

    const recovered = frames(text).find((frame) => frame.data?.includes("tab_during_gap"))
    expect(recovered?.id).toBe("1")
    expect(recovered?.data).toContain("\"type\":\"agent.lifecycle\"")
  })

  test("resuming from a mid-log cursor replays only what follows it", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)
    bus.publish(lifecycle("tab_old"))
    bus.publish(lifecycle("tab_new"))

    const stream = await connect(app, "1")
    const text = await stream.until((seen) => seen.includes("tab_new"), "cursor resume delivered nothing")
    stream.close()

    expect(text).toContain("id: 2")
    expect(text).not.toContain("tab_old")
  })

  test("emits a replay-gap notice when the cursor has fallen out of the retention window", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)
    // Retention is 256 frames; 258 pushes the cursor at 1 out of the window.
    for (let i = 1; i <= 258; i += 1) bus.publish(lifecycle(`tab_${i}`))

    const stream = await connect(app, "1")
    const text = await stream.until((seen) => seen.includes("stream.replay-gap"), "no replay-gap notice")
    stream.close()

    expect(text).toContain("runtime.sse_replay_gap")
    expect(text).toContain("\"lastEventId\":\"1\"")
    expect(text).toContain("\"throughId\":\"258\"")
    // The gap notice REPLACES the partial replay — a reader must refetch, not
    // stitch a hole-ridden log into its incremental view.
    expect(text).not.toContain("tab_258")
  })

  test("terminal frames survive eviction by the chatty ones", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const app = mount(bus)
    bus.publish({ type: "pty.exited", id: "pty_1", exitCode: 0 })
    for (let i = 1; i <= 300; i += 1) bus.publish(lifecycle(`tab_${i}`))

    // Cursor 0 == "serve the whole retained log": the terminal ring must still
    // hold the exit that the 256-frame main ring evicted.
    const stream = await connect(app, "0")
    const text = await stream.until((seen) => seen.includes("pty.exited"), "terminal frame was evicted")
    stream.close()

    expect(text).toContain("\"id\":\"pty_1\"")
  })
})
