import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createBus, type WorkspaceRuntimeEvent } from "../bus"
import { runtimeBusEventsHandler } from "./runtime-events"
import { sessionEventDeliveryPolicy, type EventDeliveryPrincipal } from "../event-delivery"
import { remoteWorkspaceSessionAccessPolicy } from "../remote-session-authority"
import type { SessionAccessPolicy } from "../session-access-policy"

function mount(
  bus: ReturnType<typeof createBus<WorkspaceRuntimeEvent>>,
  options?: Parameters<typeof runtimeBusEventsHandler>[1],
) {
  const app = new Hono()
  app.get("/api/wr/events", runtimeBusEventsHandler(bus, options))
  return app
}

type Connection = {
  /** Everything decoded from the stream so far. */
  text: () => string
  /** Reads chunks until `match` is satisfied by the accumulated text, or fails. */
  until: (match: (text: string) => boolean, label: string) => Promise<string>
  ended: () => Promise<boolean>
  close: () => void
}

async function connect(app: Hono, lastEventId?: string, actor?: string): Promise<Connection> {
  const ac = new AbortController()
  const res = await app.request(`http://localhost/api/wr/events${actor ? `?actor=${actor}` : ""}`, {
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
  test("isolates PTY transcript events between private-session editors", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const policy: SessionAccessPolicy = {
      sessionAuthority: "managed-private",
      authorize: async (input) => input.sessionId === "session_a" && input.actor?.actorId === "editor_a"
        ? { allowed: true }
        : { allowed: false, status: 403, code: "private_session", message: "Session is private" },
      filterSessions: async () => [],
      authorizePrefix: async () => ({ allowed: true }),
    }
    const principal = (actorId: string): EventDeliveryPrincipal => ({
      mode: "verified",
      connectionId: actorId,
      actorId,
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      role: "editor",
    })
    const app = mount(bus, {
      principal: (c) => principal(c.req.query("actor")!),
      policy: sessionEventDeliveryPolicy(policy),
    })
    const owner = await connect(app, undefined, "editor_a")
    const other = await connect(app, undefined, "editor_b")
    await owner.until((seen) => seen.includes("heartbeat"), "owner did not connect")
    await other.until((seen) => seen.includes("heartbeat"), "other editor did not connect")

    bus.publish({
      type: "pty.stream",
      id: "pty_a",
      sessionId: "session_a",
      kind: "data",
      tail: "private terminal transcript",
    })
    bus.publish({ type: "process.status", directory: "/repo", configId: "public_process", status: "running" })
    const ownerText = await owner.until((seen) => seen.includes("private terminal transcript"), "owner missed PTY transcript")
    const otherText = await other.until((seen) => seen.includes("public_process"), "other editor missed public event")
    owner.close()
    other.close()

    expect(ownerText).toContain("private terminal transcript")
    expect(otherText).not.toContain("private terminal transcript")
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

  test("the remote authority proof isolates live/replay and tears down a revoked participant", async () => {
    const bus = createBus<WorkspaceRuntimeEvent>()
    const participants = new Set(["actor_participant"])
    const expiredProofs = new Set<string>()
    const authorityCalls: Array<{ actorId: string; authorization: string; action: string }> = []
    const remotePolicy = remoteWorkspaceSessionAccessPolicy({
      url: "https://control.test/api/runtime-authority/session-authorize",
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization") ?? ""
        const actorId = authorization.replace(/^Bearer rht-/, "")
        const body = JSON.parse(String(init?.body)) as { action: string; stream?: boolean }
        authorityCalls.push({ actorId, authorization, action: body.action })
        if (expiredProofs.has(actorId)) {
          return Response.json({ error: { code: "relay_host_token_invalid" } }, { status: 401 })
        }
        return participants.has(actorId)
          ? Response.json({
              allowed: true,
              // Keep this test's lease inside the policy's renewal window so
              // the next private frame exercises live revocation rather than
              // the cached-grant fast path.
              ...(body.stream ? { lease: `lease-${actorId}`, expiresAt: Date.now() + 500 } : {}),
            })
          : Response.json({ error: { code: "session_private" } }, { status: 403 })
      },
    })
    const identity = (actorId: string, connectionId: string): EventDeliveryPrincipal => ({
      mode: "verified",
      connectionId,
      actorId,
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      role: "editor",
      credential: `Bearer rht-${actorId}`,
    })
    let connection = 0
    const app = mount(bus, {
      principal: (c) => identity(c.req.query("actor")!, `connection_${++connection}`),
      policy: sessionEventDeliveryPolicy(remotePolicy),
    })
    const allowed = await connect(app, undefined, "actor_participant")
    const denied = await connect(app, undefined, "actor_workspace_only")
    await allowed.until((seen) => seen.includes("heartbeat"), "participant did not connect")
    await denied.until((seen) => seen.includes("heartbeat"), "workspace member did not connect")

    bus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/repo",
      sessionID: "ses_private",
      ts: 1,
    })
    bus.publish({ type: "process.status", directory: "/repo", configId: "proc_1", status: "running" })
    const allowedLive = await allowed.until((seen) => seen.includes("ses_private"), "participant missed live session event")
    const deniedLive = await denied.until((seen) => seen.includes("proc_1"), "workspace event did not arrive")
    allowed.close()
    denied.close()

    expect(allowedLive).toContain("ses_private")
    expect(deniedLive).not.toContain("ses_private")

    const allowedReplay = await connect(app, "0", "actor_participant")
    const deniedReplay = await connect(app, "0", "actor_workspace_only")
    const allowedText = await allowedReplay.until((seen) => seen.includes("ses_private"), "participant missed replay")
    const deniedText = await deniedReplay.until((seen) => seen.includes("proc_1"), "workspace replay did not arrive")

    expect(allowedText).toContain("ses_private")
    expect(deniedText).not.toContain("ses_private")
    expect(deniedText).not.toContain("stream.replay-gap")
    expect(authorityCalls).toContainEqual({
      actorId: "actor_participant",
      authorization: "Bearer rht-actor_participant",
      action: "read",
    })

    participants.delete("actor_participant")
    bus.publish({
      type: "session.lifecycle",
      phase: "creating",
      directory: "/repo",
      sessionID: "ses_private",
      ts: 2,
    })
    expect(await allowedReplay.ended()).toBe(true)
    allowedReplay.close()
    deniedReplay.close()

    const expired = await connect(app, undefined, "actor_expired")
    await expired.until((seen) => seen.includes("heartbeat"), "expiring proof did not connect")
    expiredProofs.add("actor_expired")
    bus.publish({
      type: "session.lifecycle",
      phase: "created",
      directory: "/repo",
      sessionID: "ses_other_private",
      ts: 3,
    })
    expect(await expired.ended()).toBe(true)
    expired.close()
  })
})
