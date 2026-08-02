/**
 * Probe for the sequence reset observed in the two-browser drill's video: a
 * HELD subscriber's `Last-Event-ID` went BACKWARDS (3 → 1) after an idle gap,
 * with no `stream.replay-gap` notice.
 *
 * The hypothesis is Durable Object eviction: the replay ring is deliberately
 * in-memory (`live-sync-room.ts:415-434` argues the case), so eviction resets
 * the sequence. `cursorAhead` converts a stale cursor into a gap notice — but it
 * is only consulted on CONNECT (`replayFrames` is called from
 * `handleWebSocketConnect`), so a connection HELD across an eviction never
 * passes that check.
 *
 * This probe isolates that: one held subscriber, a nudge, a long idle, another
 * nudge. It asserts nothing — it reports the observed id sequence so the drill
 * report can state the behavior and its bound accurately rather than guess.
 *
 * Usage: node --import tsx scripts/drill/live-sync-eviction-probe.ts [idleMs]
 */

import { build } from "esbuild"
import { Miniflare } from "miniflare"

const IDLE_MS = Number(process.argv[2] ?? "12000")
const ORG = "org_probe"

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
    sourcefile: "live-sync-eviction-probe-entry.ts",
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

const observed: Array<{ id?: string; type: string; doc?: string }> = []
const response = await miniflare.dispatchFetch("http://probe.local/connect")
const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader()
const decoder = new TextDecoder()
let buffer = ""
void (async () => {
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
      observed.push({ ...(id ? { id } : {}), type: payload.type, ...(payload.documentId ? { doc: payload.documentId } : {}) })
    }
  }
})()

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
await settle(500)

await miniflare.dispatchFetch("http://probe.local/nudge?tag=before_idle")
await settle(500)
const beforeIdle = observed.at(-1)
console.log(`before idle: id=${beforeIdle?.id} doc=${beforeIdle?.doc}`)

console.log(`idling ${IDLE_MS}ms with the subscriber HELD…`)
await settle(IDLE_MS)

await miniflare.dispatchFetch("http://probe.local/nudge?tag=after_idle")
await settle(1_000)
const afterIdle = observed.at(-1)
console.log(`after idle:  id=${afterIdle?.id} doc=${afterIdle?.doc}`)

const regressed =
  !!beforeIdle?.id && !!afterIdle?.id && Number(afterIdle.id) <= Number(beforeIdle.id)
console.log(`\nframes seen by the held subscriber:`)
for (const frame of observed) console.log(`  id=${frame.id ?? "–"} ${frame.type}${frame.doc ? ` ${frame.doc}` : ""}`)
console.log(
  `\nsequence regressed across the idle: ${regressed ? "YES" : "no"}${
    regressed ? " — the held connection saw its cursor move backwards with no gap notice" : ""
  }`,
)
console.log(
  `gap notice delivered to the held connection: ${
    observed.some((f) => f.type === "stream.replay-gap") ? "yes" : "no"
  }`,
)

await reader.cancel().catch(() => {})
await miniflare.dispose()
