/**
 * Follow-up to `live-sync-eviction-probe.ts`. That probe established that a HELD
 * subscriber's cursor regresses when the Durable Object hibernates and the
 * in-memory replay ring resets, with no gap notice — because `replayFrames`
 * (and therefore `cursorAhead`) is only consulted on CONNECT.
 *
 * The open question that actually matters: does the regressed cursor still FAIL
 * SAFE? Two ways it could not:
 *
 *   A. Post-reset resync then offline publish. Client's cursor is re-synced to
 *      the new sequence by a live frame, then it drops and misses a frame. On
 *      reconnect the cursor is valid for the new sequence, so the missed frame
 *      must REPLAY.
 *   B. Stale-cursor reconnect. Client's cursor is from the LOST sequence and is
 *      numerically ahead of the reset room, so it must get a gap notice rather
 *      than silence.
 *
 * Reasoning says both are safe. This measures it, because the review's whole
 * point is that reasoning about this code is what produced a wrong claim.
 *
 * Usage: node --import tsx scripts/drill/live-sync-post-reset-resume-probe.ts
 */

import { build } from "esbuild"
import { Miniflare } from "miniflare"

/** Long enough for miniflare to evict an idle Durable Object. */
const HIBERNATE_MS = 12_000
const ORG = "org_resume_probe"

const bundled = await build({
  stdin: {
    contents: `
      import { LiveSyncRoom, connectLiveSyncRoom, nudgeLiveSyncRoom, liveSyncRoomNameForPrincipal } from ${JSON.stringify(new URL("../../src/live-sync-room.ts", import.meta.url).pathname)}
      export { LiveSyncRoom }
      export default {
        fetch(request, env) {
          const url = new URL(request.url)
          if (url.pathname === "/connect") {
            const lastEventId = request.headers.get("last-event-id") ?? undefined
            return connectLiveSyncRoom(
              env.LIVE_SYNC_ROOM,
              {
                auth: { mode: "signed", token: "probe", user: { subject: "alice", tokenIdentifier: "alice", issuer: "probe" } },
                orgId: ${JSON.stringify(ORG)},
              },
              3600000,
              undefined,
              lastEventId,
            )
          }
          if (url.pathname === "/nudge") {
            return nudgeLiveSyncRoom(
              env.LIVE_SYNC_ROOM,
              liveSyncRoomNameForPrincipal({ orgId: ${JSON.stringify(ORG)} }),
              {
                type: "document.changed",
                documentId: url.searchParams.get("tag") ?? "doc",
                orgId: ${JSON.stringify(ORG)},
                projectId: "proj",
                ts: Date.now(),
              },
            ).then((r) => Response.json(r))
          }
          return new Response("not found", { status: 404 })
        },
      }
    `,
    loader: "ts",
    resolveDir: new URL("../../src/", import.meta.url).pathname,
    sourcefile: "live-sync-resume-probe-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
})

const miniflare = new Miniflare({
  compatibilityDate: "2025-05-01",
  compatibilityFlags: ["nodejs_compat"],
  modules: [{ type: "ESModule", path: "index.mjs", contents: bundled.outputFiles[0]!.text }],
  durableObjects: { LIVE_SYNC_ROOM: "LiveSyncRoom" },
})
await miniflare.ready

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Frame = { id?: string; type: string; doc?: string }

/** Opens a stream and accumulates frames until cancelled. */
async function open(lastEventId?: string) {
  const response = await miniflare.dispatchFetch("http://probe.local/connect", {
    headers: lastEventId ? { "last-event-id": lastEventId } : {},
  })
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader()
  const frames: Frame[] = []
  const decoder = new TextDecoder()
  let buffer = ""
  const pump = (async () => {
    while (true) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (next.done) break
      buffer += decoder.decode(next.value!, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        const lines = chunk.split("\n").map((l) => l.trim())
        const id = lines.find((l) => l.startsWith("id:"))?.slice(3).trim()
        const data = lines.find((l) => l.startsWith("data:"))?.slice(5).trim()
        if (!data) continue
        const payload = JSON.parse(data) as { type: string; documentId?: string }
        frames.push({
          ...(id ? { id } : {}),
          type: payload.type,
          ...(payload.documentId ? { doc: payload.documentId } : {}),
        })
      }
    }
  })()
  return {
    frames,
    /** The cursor a real client would hold: last `id:` seen. */
    cursor: () => frames.filter((f) => f.id).at(-1)?.id,
    async close() {
      await reader.cancel().catch(() => {})
      await pump.catch(() => {})
    },
  }
}

const nudge = (tag: string) => miniflare.dispatchFetch(`http://probe.local/nudge?tag=${tag}`)

console.log("case A — post-reset resync, then a nudge missed while offline\n")

let stream = await open()
await settle(300)
await nudge("pre_hibernate")
await settle(300)
console.log(`  cursor before hibernation: ${stream.cursor()}`)

console.log(`  idling ${HIBERNATE_MS}ms to hibernate the room…`)
await settle(HIBERNATE_MS)

// A live frame after the reset re-synchronizes the held client onto the new
// sequence. This is the state case A depends on.
await nudge("post_reset_live")
await settle(600)
const resyncCursor = stream.cursor()
console.log(`  cursor after one post-reset live frame: ${resyncCursor}`)

await stream.close()
// Published with NO connection held.
await nudge("missed_while_offline")
await settle(300)

const resumed = await open(resyncCursor)
await settle(1_000)
const replayed = resumed.frames.some((f) => f.doc === "missed_while_offline")
const gapA = resumed.frames.some((f) => f.type === "stream.replay-gap")
console.log(`  frames on resume: ${resumed.frames.map((f) => `${f.id ?? "–"}:${f.doc ?? f.type}`).join(", ")}`)
console.log(
  `  RESULT A: missed frame ${replayed ? "REPLAYED (safe)" : gapA ? "not replayed but gap notice raised (safe)" : "SILENTLY LOST (UNSAFE)"}`,
)
await resumed.close()

console.log("\ncase B — reconnect carrying a cursor from the LOST sequence\n")

// Build a room with a tall sequence, hibernate it, then present the tall cursor.
let tall = await open()
await settle(300)
for (let i = 0; i < 8; i += 1) await nudge(`tall_${i + 1}`)
await settle(800)
const tallCursor = tall.cursor()
console.log(`  cursor before hibernation: ${tallCursor}`)
await tall.close()

console.log(`  idling ${HIBERNATE_MS}ms to hibernate the room…`)
await settle(HIBERNATE_MS)
// One frame so the reset room has a short sequence the tall cursor is ahead of.
await nudge("after_reset")
await settle(300)

const stale = await open(tallCursor)
await settle(1_000)
const gapB = stale.frames.find((f) => f.type === "stream.replay-gap")
console.log(`  frames on resume: ${stale.frames.map((f) => `${f.id ?? "–"}:${f.doc ?? f.type}`).join(", ")}`)
console.log(
  `  RESULT B: ${gapB ? "gap notice raised (safe — client refetches)" : "NO gap notice (UNSAFE — stale cursor served as if valid)"}`,
)
await stale.close()

await miniflare.dispose()
