import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { createBus, type ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { EventScopePrincipal } from "@claxedo/server-core/platform/http/event-visibility"
import { createControlPlaneEventsHandler, signedControlPlaneEventVisibleTo } from "./events"

type ReplayConnection = {
  until: (match: (text: string) => boolean, label: string) => Promise<string>
  ended: () => Promise<boolean>
  close: () => void
}

function mount(handler: ReturnType<typeof createControlPlaneEventsHandler>) {
  return new Hono().get("/api/cp/events", handler)
}

async function connect(app: Hono, lastEventId?: string, actor?: string): Promise<ReplayConnection> {
  const ac = new AbortController()
  const query = new URLSearchParams()
  if (actor) query.set("actor", actor)
  const res = await app.request(`http://127.0.0.1/api/cp/events${query.size > 0 ? `?${query}` : ""}`, {
    ...(lastEventId === undefined ? {} : { headers: { "Last-Event-ID": lastEventId } }),
    signal: ac.signal,
  })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ""
  return {
    async until(match, label) {
      for (let reads = 0; reads < 40; reads += 1) {
        if (match(text)) return text
        const next = await reader.read()
        if (next.done) break
        text += decoder.decode(next.value, { stream: true })
      }
      if (match(text)) return text
      throw new Error(`${label}\n--- stream so far ---\n${text}`)
    },
    async ended() {
      return await Promise.race([
        (async () => {
          for (let reads = 0; reads < 10; reads += 1) {
            if ((await reader.read()).done) return true
          }
          return false
        })(),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ])
    },
    close: () => ac.abort(),
  }
}

/** Field-order-independent frame split; Hono writes `data:` before `id:`. */
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

const bootstrapId = (text: string) => frames(text)[0]?.id
const opened = (seen: string) => seen.includes('"type":"heartbeat"')

function harness() {
  const bus = createBus<ControlPlaneEvent>()
  const app = mount(createControlPlaneEventsHandler(bus, { sequenceOrigin: () => 0 }))
  return { bus, app }
}

const worktree = (name: string): ControlPlaneEvent => ({ type: "worktree.ready", directory: `/tmp/central/${name}`, name, branch: name })
const provision = (workspaceId: string, step: "cloning" | "ready", orgId?: string): ControlPlaneEvent => ({
  type: "provision", workspaceId, step, ts: 1, ...(orgId ? { orgId } : {}),
})

describe("signed control-plane visibility", () => {
  const principal: EventScopePrincipal = { mode: "signed", subject: "user_1", orgId: "org_1" }

  test("scopes notices by subject and organization, and always passes the gap notice", async () => {
    expect(signedControlPlaneEventVisibleTo(provision("ws_1", "ready", "org_1"), principal)).toBe(true)
    expect(signedControlPlaneEventVisibleTo(provision("ws_2", "ready", "org_2"), principal)).toBe(false)
    expect(signedControlPlaneEventVisibleTo(worktree("a"), principal)).toBe(false)
    expect(signedControlPlaneEventVisibleTo(
      { type: "session.share.changed", phase: "granted", ownerUserId: "user_1", sessionId: "s", workspaceId: "w", ts: 1 },
      principal,
    )).toBe(true)
    expect(signedControlPlaneEventVisibleTo(
      { type: "stream.replay-gap", code: "cp.sse_replay_gap", message: "", severity: "warn" },
      principal,
    )).toBe(true)
  })

  test("a loopback subscriber sees everything its daemon publishes", () => {
    expect(signedControlPlaneEventVisibleTo(worktree("a"), { mode: "unsigned-local" })).toBe(true)
  })
})

describe("cp/events — the control plane's notice stream", () => {
  test("the bootstrap heartbeat carries the cursor the connection resumes from", async () => {
    const { bus, app } = harness()
    bus.publish(worktree("one"))
    bus.publish(worktree("two"))

    const stream = await connect(app)
    const text = await stream.until(opened, "no cursor bootstrap frame")
    stream.close()

    expect(bootstrapId(text)).toBe("2")
  })

  test("bootstraps at cursor 0 when nothing has been published yet", async () => {
    const { app } = harness()
    const stream = await connect(app)
    const text = await stream.until(opened, "no cursor bootstrap frame")
    stream.close()
    expect(bootstrapId(text)).toBe("0")
  })

  test("a cursor-less connection is served nothing from the ring; live frames carry ids", async () => {
    const { bus, app } = harness()
    bus.publish(worktree("before"))

    const stream = await connect(app)
    await stream.until(opened, "no cursor bootstrap frame")
    bus.publish(worktree("after"))
    const text = await stream.until((seen) => seen.includes('"name":"after"'), "live frame never arrived")
    stream.close()

    expect(text).not.toContain('"name":"before"')
    expect(frames(text).find((frame) => frame.data?.includes('"name":"after"'))?.id).toBe("2")
  })

  test("a frame published while disconnected is delivered on the next Last-Event-ID reconnect", async () => {
    const { bus, app } = harness()
    const first = await connect(app)
    const text = await first.until(opened, "no cursor bootstrap frame")
    first.close()
    const cursor = bootstrapId(text)!

    bus.publish(worktree("missed"))

    const second = await connect(app, cursor)
    const replayed = await second.until((seen) => seen.includes('"name":"missed"'), "missed frame was not replayed")
    second.close()
    expect(replayed).toContain('"name":"missed"')
  })

  test("emits a replay-gap notice when the cursor has fallen out of the retention window", async () => {
    const { bus, app } = harness()
    for (let i = 1; i <= 300; i += 1) bus.publish(provision("ws_1", "cloning"))

    const stream = await connect(app, "1")
    const text = await stream.until((seen) => seen.includes("stream.replay-gap"), "no gap notice")
    stream.close()
    expect(text).toContain("cp.sse_replay_gap")
  })

  test("a settling notice survives eviction by a provision's intermediate steps", async () => {
    const { bus, app } = harness()
    bus.publish(worktree("kept"))
    for (let i = 1; i <= 300; i += 1) bus.publish(provision("ws_1", "cloning"))

    const stream = await connect(app, "0")
    const text = await stream.until((seen) => seen.includes('"name":"kept"'), "settling notice was evicted")
    stream.close()
    expect(text).toContain('"name":"kept"')
  })

  test("a frame whose visibility is pending when a second connection attaches reaches both once, under one id", async () => {
    const bus = createBus<ControlPlaneEvent>()
    const release: Array<() => void> = []
    const handler = createControlPlaneEventsHandler(bus, {
      sequenceOrigin: () => 0,
      resolveSubscription: () => ({
        identity: { mode: "verified", connectionId: crypto.randomUUID(), actorId: "user_1", actorKind: "human", orgId: "org_1", workspaceId: "ws_1", role: "editor" },
        visible: () => new Promise<boolean>((resolve) => { release.push(() => resolve(true)) }),
      }),
    })
    const app = mount(handler)
    const a = await connect(app)
    await a.until(opened, "a did not open")
    bus.publish(worktree("pending"))
    const b = await connect(app)
    await b.until(opened, "b did not open")
    for (let round = 0; round < 8; round += 1) {
      while (release.length > 0) release.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    bus.publish(worktree("after"))
    while (release.length > 0) release.shift()!()
    const aText = await a.until((seen) => seen.includes('"name":"after"'), "a missed the later frame")
    const bText = await b.until((seen) => seen.includes('"name":"after"'), "b missed the later frame")
    a.close()
    b.close()

    const names = (text: string) => frames(text).flatMap((frame) => {
      const match = /"name":"([a-z]+)"/.exec(frame.data ?? "")
      return match ? [`${frame.id}:${match[1]}`] : []
    })
    expect(names(aText)).toEqual(["1:pending", "2:after"])
    expect(names(bText)).toEqual(["1:pending", "2:after"])
  })

  test("a client gone while its subscription was resolving is released, not kept as a subscriber", async () => {
    const bus = createBus<ControlPlaneEvent>()
    let visibilityChecks = 0
    const handler = createControlPlaneEventsHandler(bus, {
      sequenceOrigin: () => 0,
      resolveSubscription: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          identity: { mode: "verified", connectionId: crypto.randomUUID(), actorId: "user_1", actorKind: "human", orgId: "org_1", workspaceId: "ws_1", role: "editor" },
          visible: () => {
            visibilityChecks += 1
            return true
          },
        }
      },
    })
    const app = mount(handler)
    const ac = new AbortController()
    const pending = app.request("http://127.0.0.1/api/cp/events", { signal: ac.signal })
    ac.abort()
    const res = await pending
    expect(res.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 40))
    bus.publish(worktree("after-abort"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(visibilityChecks).toBe(0)
  })

  test("a signed subscriber is delivered only the frames visible to it", async () => {
    const bus = createBus<ControlPlaneEvent>()
    const handler = createControlPlaneEventsHandler(bus, {
      sequenceOrigin: () => 0,
      resolveSubscription: (c) => {
        const actorId = c.req.query("actor")!
        return {
          identity: { mode: "verified", connectionId: `connection_${actorId}`, actorId, actorKind: "human", orgId: actorId, workspaceId: "ws_1", role: "editor" },
          visible: (frame) => frame.type !== "provision" || frame.orgId === actorId,
        }
      },
    })
    const app = mount(handler)
    const a = await connect(app, undefined, "org_a")
    const b = await connect(app, undefined, "org_b")
    await a.until(opened, "a did not open")
    await b.until(opened, "b did not open")

    bus.publish(provision("ws_a", "ready", "org_a"))
    bus.publish(provision("ws_b", "ready", "org_b"))
    const aText = await a.until((seen) => seen.includes('"workspaceId":"ws_a"'), "a missed its own notice")
    const bText = await b.until((seen) => seen.includes('"workspaceId":"ws_b"'), "b missed its own notice")
    a.close()
    b.close()

    expect(aText).not.toContain('"workspaceId":"ws_b"')
    expect(bText).not.toContain('"workspaceId":"ws_a"')

  })
})
