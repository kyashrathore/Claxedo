import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"

let miniflare: Miniflare

beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        import { LiveSyncRoom, connectLiveSyncRoom, nudgeLiveSyncRoom } from ${JSON.stringify(new URL("./live-sync-room.ts", import.meta.url).pathname)}
        export { LiveSyncRoom }
        // orgId is the AUTHORITY-INTERNAL org id resolved at connect — the
        // namespace publishers stamp — not the Clerk claim on the auth.
        const subscriber = {
          auth: { mode: "signed", token: "test", user: { subject: "alice", tokenIdentifier: "alice", issuer: "test" } },
          orgId: "org_internal_acme",
        }
        export default {
          fetch(request, env) {
            const url = new URL(request.url)
            if (url.pathname === "/connect") return connectLiveSyncRoom(env.LIVE_SYNC_ROOM, subscriber, 60000)
            if (url.pathname === "/nudge") return nudgeLiveSyncRoom(env.LIVE_SYNC_ROOM, "org:org_internal_acme", {
              type: "workgraph.changed",
              ownerUserId: "alice",
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
  miniflare = new Miniflare({
    compatibilityDate: "2026-07-18",
    modules: [{ type: "ESModule", path: "index.mjs", contents: bundled.outputFiles[0]!.text }],
    durableObjects: { LIVE_SYNC_ROOM: "LiveSyncRoom" },
  })
})

afterAll(async () => {
  await miniflare?.dispose()
})

async function frame(reader: { read(): Promise<ReadableStreamReadResult<Uint8Array>> }) {
  const result = await reader.read()
  if (!result.value) throw new Error("live-sync stream ended")
  return JSON.parse(new TextDecoder().decode(result.value).replace(/^data:\s*/, "").trim()) as unknown
}

describe("LiveSyncRoom workerd integration", () => {
  test("bridges a real hibernatable Durable Object socket to SSE and fans a nudge", async () => {
    const response = await miniflare.dispatchFetch("http://test/connect")
    const reader = response.body!.getReader()
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(await frame(reader)).toEqual({ type: "heartbeat" })

    const nudge = await miniflare.dispatchFetch("http://test/nudge")
    expect(await nudge.json()).toEqual({ delivered: 1, held: 1 })
    expect(await frame(reader)).toMatchObject({ type: "workgraph.changed", ownerUserId: "alice" })
    await reader.cancel()
  })
})
