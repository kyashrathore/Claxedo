import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"

let miniflare: Miniflare
/** Kept so the cap test can stand up a second instance with a different cap. */
let workerModule: string

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import { LiveSyncRoom, connectLiveSyncRoom, nudgeLiveSyncRoom } from ${JSON.stringify(new URL("./live-sync-room.ts", import.meta.url).pathname)}
        export { LiveSyncRoom }
        // Subjects are parameterised, the org is the room key. Two subjects in
        // ONE org share a room and therefore ONE retention ring — the
        // multi-tenancy hazard. Each test passes its own org so it gets a fresh
        // room: rooms are durable for the lifetime of the miniflare instance,
        // so a shared one would carry the previous test's held sockets and id
        // sequence into the next.
        // orgId is the AUTHORITY-INTERNAL org id resolved at connect — the
        // namespace publishers stamp — not the Clerk claim on the auth.
        const subscriber = (subject, orgId) => ({
          auth: {
            mode: "signed",
            token: "test",
            user: { subject, tokenIdentifier: subject, issuer: "test" },
          },
          orgId,
        })
        export default {
          fetch(request, env) {
            const url = new URL(request.url)
            const org = url.searchParams.get("org") ?? "acme"
            if (url.pathname === "/connect") {
              const subject = url.searchParams.get("as") ?? "alice"
              const lastEventId = request.headers.get("last-event-id") ?? undefined
              return connectLiveSyncRoom(env.LIVE_SYNC_ROOM, subscriber(subject, org), 60000, undefined, lastEventId)
            }
            if (url.pathname === "/nudge") return nudgeLiveSyncRoom(env.LIVE_SYNC_ROOM, "org:" + org, {
              type: "workgraph.changed",
              ownerUserId: url.searchParams.get("owner") ?? "alice",
              ts: Date.now(),
            }).then((result) => Response.json(result))
            return new Response("not found", { status: 404 })
          },
        }
      `,
      loader: "ts",
      resolveDir: import.meta.dirname,
      sourcefile: "live-sync-workerd-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  })
  workerModule = bundled.outputFiles[0]!.text
  miniflare = new Miniflare({
    compatibilityDate: "2026-07-18",
    modules: [{ type: "ESModule", path: "index.mjs", contents: workerModule }],
    durableObjects: { LIVE_SYNC_ROOM: "LiveSyncRoom" },
  })
})

afterAll(async () => {
  await miniflare?.dispose()
})

type SseFrame = { id?: string; data: unknown }

/**
 * Accumulating SSE reader. One `read()` is NOT one frame here: the room queues
 * a connection's replayed frames onto the socket before the bridge accepts it,
 * so the bootstrap and everything replayed behind it can surface in a single
 * chunk. Splitting on the blank-line delimiter is the only correct framing, and
 * fields are located by scanning lines rather than by position (Hono and this
 * bridge disagree about whether `id:` or `data:` comes first).
 */
// Structural, not `ReadableStreamDefaultReader`: this package compiles against
// @cloudflare/workers-types, whose reader carries an extra `readMany`, while
// miniflare's `dispatchFetch` hands back the standard one.
type ChunkReader = {
  read(): Promise<{ value?: Uint8Array; done: boolean }>
  cancel(): Promise<unknown>
}

function sseReader(reader: ChunkReader) {
  const decoder = new TextDecoder()
  let text = ""
  const parse = (): SseFrame[] =>
    text
      .split("\n\n")
      .filter((block) => block.trim().length > 0)
      .map((block) => {
        const lines = block.split("\n")
        const data = lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim()
        return {
          id: lines.find((line) => line.startsWith("id:"))?.slice("id:".length).trim(),
          data: data ? JSON.parse(data) : undefined,
        }
      })
  return {
    frames: parse,
    /**
     * Read until `count` complete frames have arrived.
     *
     * Bounded by an IDLE timeout rather than a read budget, because the failure
     * this suite is guarding against is a frame that never comes — and the next
     * thing on an idle stream is a heartbeat 60 seconds out, so a plain read
     * loop would turn every such regression into a test-timeout hang instead of
     * a legible assertion.
     */
    async until(count: number, label: string) {
      const idle = Symbol("idle")
      while (parse().length < count) {
        const next = await Promise.race([
          reader.read(),
          new Promise<typeof idle>((resolve) => setTimeout(() => resolve(idle), 1_000)),
        ])
        if (next === idle || next.done) break
        text += decoder.decode(next.value, { stream: true })
      }
      const frames = parse()
      if (frames.length < count) throw new Error(`${label}\n--- stream so far ---\n${text}`)
      return frames
    },
    cancel: () => reader.cancel(),
  }
}

/** One room per test, so ids and delivery counts are deterministic. */
function room(org: string) {
  return {
    async connect(subject = "alice", lastEventId?: string) {
      const response = await miniflare.dispatchFetch(`http://test/connect?org=${org}&as=${subject}`, {
        headers: lastEventId === undefined ? {} : { "Last-Event-ID": lastEventId },
      })
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      return sseReader(response.body!.getReader())
    },
    nudge: (owner = "alice") =>
      miniflare
        .dispatchFetch(`http://test/nudge?org=${org}&owner=${owner}`)
        .then((res) => res.json() as Promise<{ delivered: number; held: number }>),
  }
}

describe("LiveSyncRoom workerd integration", () => {
  test("bridges a real hibernatable Durable Object socket to SSE and fans a nudge", async () => {
    const acme = room("acme")
    const stream = await acme.connect()
    expect(await stream.until(1, "no bootstrap frame")).toEqual([{ id: "0", data: { type: "heartbeat" } }])

    expect(await acme.nudge()).toEqual({ delivered: 1, held: 1 })
    const frames = await stream.until(2, "nudge never arrived")
    expect(frames[1]).toMatchObject({ id: "1", data: { type: "workgraph.changed", ownerUserId: "alice" } })
    await stream.cancel()
  })

  /**
   * The end-to-end proof, on the real Workers runtime rather than a fake: the
   * frame is published with NO connection attached (`delivered: 0`), and the
   * next connection recovers it by cursor. This also exercises the two things a
   * fake namespace cannot vouch for — that the room's resume-cursor response
   * header survives the internal 101 upgrade, and that frames the room pushes
   * onto the socket before the bridge calls `accept()` are queued rather than
   * dropped.
   */
  test("a frame published while disconnected is replayed on the next Last-Event-ID connect", async () => {
    const gapped = room("gapped")
    const first = await gapped.connect()
    const opened = await first.until(1, "no bootstrap frame")
    const cursor = opened[0]!.id!
    expect(cursor).toBe("0")
    await first.cancel()

    // The frame-loss window. `delivered` is deliberately NOT asserted here: a
    // cancelled client's socket is not reaped from the room synchronously, so
    // the room may still count it and "deliver" into a stream nobody is
    // reading. That is the failure mode replay exists for — delivery to a dead
    // socket is indistinguishable from loss, and only the ring makes the frame
    // recoverable afterwards.
    await gapped.nudge("alice")

    const second = await gapped.connect("alice", cursor)
    const frames = await second.until(2, "frame published while disconnected was lost")
    expect(frames[0]).toEqual({ id: cursor, data: { type: "heartbeat" } })
    expect(frames[1]).toMatchObject({ id: "1", data: { type: "workgraph.changed", ownerUserId: "alice" } })
    await second.cancel()
  })

  /**
   * The cursor-less half of the same contract: a fresh page must resume at
   * "everything from now on", not re-read the retained log. `provision` frames
   * are progress steps, so a re-read would walk a settled workspace back
   * through `cloning` behind a spinner nothing will settle again.
   */
  test("a cursor-less connection is served nothing from the ring and bootstraps at the room's tip", async () => {
    const fresh = room("fresh")
    expect(await fresh.nudge("alice")).toMatchObject({ delivered: 0 })
    expect(await fresh.nudge("alice")).toMatchObject({ delivered: 0 })

    const stream = await fresh.connect()
    const frames = await stream.until(1, "no bootstrap frame")
    expect(frames).toEqual([{ id: "2", data: { type: "heartbeat" } }])
    await stream.cancel()
  })

  /**
   * THE hosted-stream hazard. `liveSyncRoomName` keys every member of an org to
   * ONE room, so the ring alice's frames land in is the same ring carol resumes
   * from. The only thing between them is that replayed frames traverse
   * `eventVisibleTo` exactly like live ones.
   */
  test("replay re-applies the identity filter: an org peer never receives another subject's frame", async () => {
    const shared = room("shared")
    // Both published with nothing attached, so only the ring can deliver them
    // — and the ring is the room's, shared by every member of the org.
    expect(await shared.nudge("alice")).toMatchObject({ delivered: 0 })
    expect(await shared.nudge("carol")).toMatchObject({ delivered: 0 })

    // Cursor 0 means "serve the whole retained log". Carol must still receive
    // only her own frame, and it must keep the SHARED id — a cursor has to mean
    // the same thing on every connection to this room, so ids are never
    // renumbered per identity.
    const carol = await shared.connect("carol", "0")
    const frames = await carol.until(2, "carol's own frame was not replayed")
    expect(frames[0]).toEqual({ id: "0", data: { type: "heartbeat" } })
    expect(frames[1]).toMatchObject({ id: "2", data: { ownerUserId: "carol" } })
    expect(frames.some((frame) => JSON.stringify(frame.data).includes("alice"))).toBe(false)
    await carol.cancel()
  })

  /**
   * A Durable Object holds its ring in memory, so eviction resets the sequence
   * — far more often than the Node process restart the local streams tolerate.
   * The shared buffer cannot see this (`hasGap` short-circuits when the cursor
   * is at or past the tip), so a stale-high cursor would be served silence.
   * `cursorAhead` converts it into the explicit refetch signal instead.
   */
  test("a cursor from a sequence this room no longer has produces a replay-gap notice", async () => {
    const reset = room("reset")
    const stream = await reset.connect("alice", "57")
    const frames = await stream.until(2, "no replay-gap notice for a stale cursor")
    expect(frames[0]).toEqual({ id: "57", data: { type: "heartbeat" } })
    expect(frames[1]).toMatchObject({
      data: { type: "stream.replay-gap", code: "claxedo.sse_replay_gap", lastEventId: "57" },
    })
    // The notice is per-connection: it carries only cursor ids, so it never
    // takes an id of its own and cannot advance a reader past real frames.
    expect(frames[1]!.id).toBeUndefined()
    await stream.cancel()
  })

  /**
   * The cap on the REAL runtime, where the connections it counts are genuine
   * hibernatable sockets held by `state.acceptWebSocket` rather than fakes
   * pushed into an array. The unit tests cover the same 503 against doubles;
   * this one proves `state.getWebSockets()` actually reports what the cap is
   * counting under workerd — the counter the production path uses.
   *
   * Its own miniflare instance with a tiny cap: the default is 2,000 (measured,
   * see `scripts/bench/live-sync-capacity.ts`) and the tests above must run
   * against the real default, not a lowered one.
   */
  test("the room answers 503 once its connection cap is reached", async () => {
    const capped = new Miniflare({
      compatibilityDate: "2026-07-18",
      modules: [{ type: "ESModule", path: "index.mjs", contents: workerModule }],
      durableObjects: { LIVE_SYNC_ROOM: "LiveSyncRoom" },
      bindings: { LIVE_SYNC_MAX_CONNECTIONS: "2" },
    })
    try {
      const connect = (subject: string) =>
        capped.dispatchFetch(`http://test/connect?org=capped&as=${subject}`)

      const held = []
      for (const subject of ["first", "second"]) {
        const response = await connect(subject)
        expect(response.status).toBe(200)
        const reader = response.body!.getReader()
        // The socket is only held once the bridge's stream starts, which is on
        // first read — an unread response is not yet a held connection.
        await reader.read()
        held.push(reader)
      }

      const rejected = await connect("third")
      expect(rejected.status).toBe(503)
      expect(await rejected.json()).toEqual({ error: "live-sync room connection limit reached" })

      for (const reader of held) await reader.cancel()
    } finally {
      await capped.dispose()
    }
  })
})
