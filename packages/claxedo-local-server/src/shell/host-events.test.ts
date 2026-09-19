import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import type { WorkspaceEventStreamFrame } from "@claxedo/workspace-runtime"
import {
  createHostAggregateEventsHandler,
  type HostAggregateRuntime,
} from "./host-events"

type Phase = "mounted" | "retired" | "disposed"
type Listener = (runtime: HostAggregateRuntime, phase: Phase) => void

/** A runtime's `wr/events` tap, with the publisher the real handler keeps private. */
function fakeRuntime(id: string, directory: string) {
  const listeners = new Set<(frame: WorkspaceEventStreamFrame) => void>()
  const runtime: HostAggregateRuntime = {
    workspace: { id, directory },
    frames: {
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
  return {
    runtime,
    directory,
    attachments: () => listeners.size,
    publish(frame: WorkspaceEventStreamFrame) {
      for (const listener of Array.from(listeners)) listener(frame)
    },
  }
}

function registry(...initial: HostAggregateRuntime[]) {
  const observers = new Set<Listener>()
  const mounted = new Set<HostAggregateRuntime>(initial)
  return {
    observe: (listener: Listener) => {
      observers.add(listener)
      for (const runtime of mounted) listener(runtime, "mounted")
      return () => {
        observers.delete(listener)
      }
    },
    mount: (runtime: HostAggregateRuntime) => {
      mounted.add(runtime)
      for (const listener of Array.from(observers)) listener(runtime, "mounted")
    },
    retire: (runtime: HostAggregateRuntime) => {
      mounted.delete(runtime)
      for (const listener of Array.from(observers)) listener(runtime, "retired")
    },
    dispose: (runtime: HostAggregateRuntime) => {
      for (const listener of Array.from(observers)) listener(runtime, "disposed")
    },
  }
}

/** A workspace control frame the retention predicate does not reserve, so a long run rolls the ring. */
const output = (directory: string, message: string): WorkspaceEventStreamFrame => ({
  directory,
  payload: { type: "pty.stream", id: `pty-${directory}`, kind: "error", message },
})

function mount(handler: ReturnType<typeof createHostAggregateEventsHandler>) {
  return new Hono().get("/api/wr/events", handler)
}

async function connect(app: Hono, lastEventId?: string) {
  const abort = new AbortController()
  const response = await app.request("http://127.0.0.1/api/wr/events", {
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": lastEventId } }),
    signal: abort.signal,
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  const read = async () => {
    const next = await reader.read()
    if (next.done) return false
    text += decoder.decode(next.value, { stream: true })
    return true
  }
  // The bootstrap heartbeat is written before the fanout attaches; reading it
  // is what proves the connection is attached before a test publishes.
  await read()
  return {
    async until(marker: string, reads = 60) {
      for (let i = 0; i < reads && !text.includes(marker); i += 1) {
        if (!await read()) break
      }
      return text
    },
    seen: () => text,
    close: () => abort.abort(),
  }
}

function blocks(text: string) {
  return text.split("\n\n").flatMap((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data:"))
    if (!data) return []
    const id = block.split("\n").find((line) => line.startsWith("id:"))?.slice(3).trim()
    return [{ id, frame: JSON.parse(data.slice(5)) as Record<string, any> }]
  })
}

const payloads = (text: string) =>
  blocks(text).flatMap((block) => (block.frame.payload ? [block.frame.payload.message] : []))

describe("the host aggregate wr/events", () => {
  test("carries every mounted runtime's frames on one stream, verbatim and in publish order", async () => {
    const one = fakeRuntime("ws-one", "/repo/one")
    const two = fakeRuntime("ws-two", "/repo/two")
    const runtimes = registry(one.runtime, two.runtime)
    const handler = createHostAggregateEventsHandler({ observe: runtimes.observe, sequenceOrigin: () => 0 })
    const connection = await connect(mount(handler))

    const published = [
      output("/repo/one", "one-a"),
      output("/repo/two", "two-a"),
      output("/repo/one", "one-b"),
      output("/repo/two", "two-b"),
    ]
    one.publish(published[0])
    two.publish(published[1])
    one.publish(published[2])
    two.publish(published[3])
    const text = await connection.until("two-b")
    connection.close()
    handler.close()

    expect(payloads(text)).toEqual(["one-a", "two-a", "one-b", "two-b"])
    expect(blocks(text).slice(1).map((block) => block.frame)).toEqual(published)
  })

  test("a runtime mounted after the connection opened joins it; one that leaves the registry rides until its disposal settles", async () => {
    const early = fakeRuntime("ws-early", "/repo/early")
    const late = fakeRuntime("ws-late", "/repo/late")
    const runtimes = registry(early.runtime)
    const handler = createHostAggregateEventsHandler({ observe: runtimes.observe, sequenceOrigin: () => 0 })
    const connection = await connect(mount(handler))

    runtimes.mount(late.runtime)
    expect(late.attachments()).toBe(1)
    late.publish(output("/repo/late", "late-joined"))
    await connection.until("late-joined")

    // Leaving the registry routes nothing new to the runtime; disposal is
    // what ends its frames, and the terminal ones an aborted turn settles
    // are published in between.
    runtimes.retire(early.runtime)
    expect(early.attachments()).toBe(1)
    early.publish(output("/repo/early", "aborted-turn"))
    await connection.until("aborted-turn")

    runtimes.dispose(early.runtime)
    expect(early.attachments()).toBe(0)
    early.publish(output("/repo/early", "after-disposal"))
    late.publish(output("/repo/late", "still-live"))
    const text = await connection.until("still-live")
    connection.close()
    handler.close()

    expect(payloads(text)).toEqual(["late-joined", "aborted-turn", "still-live"])
    expect(text).not.toContain("after-disposal")
  })

  test("the bootstrap heartbeat carries the cursor, and a cursor-less connection is served nothing behind it", async () => {
    const one = fakeRuntime("ws-one", "/repo/one")
    const runtimes = registry(one.runtime)
    const handler = createHostAggregateEventsHandler({ observe: runtimes.observe, sequenceOrigin: () => 0 })
    const app = mount(handler)
    // A first reader, so the two publishes below are known to have been
    // numbered before it drops and the next connection asks for a cursor.
    const first = await connect(app)
    one.publish(output("/repo/one", "before-a"))
    one.publish(output("/repo/one", "before-b"))
    await first.until("before-b")
    first.close()

    const connection = await connect(app)
    const bootstrap = blocks(connection.seen())[0]
    expect(bootstrap.frame).toEqual({ type: "heartbeat" })
    expect(bootstrap.id).toBe("2")

    one.publish(output("/repo/one", "after"))
    const text = await connection.until("after")
    connection.close()
    handler.close()
    expect(payloads(text)).toEqual(["after"])
  })

  test("the ring fills with no connection ever opened, and a later reader resumes through it", async () => {
    const one = fakeRuntime("ws-one", "/repo/one")
    const runtimes = registry(one.runtime)
    const handler = createHostAggregateEventsHandler({ observe: runtimes.observe, sequenceOrigin: () => 0 })
    const app = mount(handler)

    // No HTTP connection has ever been opened: what the reader below resumes
    // through is what the source ringed while nobody was reading.
    one.publish(output("/repo/one", "unread-a"))
    one.publish(output("/repo/one", "unread-b"))

    const fresh = await connect(app)
    expect(blocks(fresh.seen())[0].id).toBe("2")
    fresh.close()

    const resumed = await connect(app, "0")
    const text = await resumed.until("unread-b")
    resumed.close()
    handler.close()

    expect(payloads(text)).toEqual(["unread-a", "unread-b"])
  })

  test("a resuming cursor replays only what came after it", async () => {
    const one = fakeRuntime("ws-one", "/repo/one")
    const two = fakeRuntime("ws-two", "/repo/two")
    const runtimes = registry(one.runtime, two.runtime)
    const handler = createHostAggregateEventsHandler({ observe: runtimes.observe, sequenceOrigin: () => 0 })
    const app = mount(handler)
    const first = await connect(app)
    one.publish(output("/repo/one", "frame-1"))
    two.publish(output("/repo/two", "frame-2"))
    one.publish(output("/repo/one", "frame-3"))
    await first.until("frame-3")
    first.close()

    const resumed = await connect(app, "1")
    const text = await resumed.until("frame-3")
    resumed.close()
    handler.close()

    expect(payloads(text)).toEqual(["frame-2", "frame-3"])
  })

  test("a cursor the ring has rolled past is answered with a replay-gap frame", async () => {
    const one = fakeRuntime("ws-one", "/repo/one")
    const runtimes = registry(one.runtime)
    const handler = createHostAggregateEventsHandler({ observe: runtimes.observe, sequenceOrigin: () => 0 })
    const app = mount(handler)
    const filling = await connect(app)
    for (let i = 0; i < 300; i += 1) one.publish(output("/repo/one", `roll-${i}`))
    await filling.until("roll-299", 400)
    filling.close()

    const resumed = await connect(app, "1")
    const text = await resumed.until("stream.replay-gap", 400)
    resumed.close()
    handler.close()

    const gap = blocks(text).map((block) => block.frame).find((frame) => frame.type === "stream.replay-gap")
    expect(gap).toMatchObject({
      type: "stream.replay-gap",
      code: "runtime.sse_replay_gap",
      severity: "warn",
      lastEventId: "1",
    })
  })
})
