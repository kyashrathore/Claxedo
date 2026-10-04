import { expect, test } from "vitest"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { applyControlPlaneBaseline } from "../test-support/control-plane-migrations"
import { hostedWorkerCompatibility } from "../test-support/hosted-worker-bundle"

test("register, checkpoint and repair run on workerd with real D1 and no projection store, pulling a hosted session from its own host", async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../test-support/hosted-session-pull-worker.ts", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
    external: ["node:*"],
  })
  let ordinal = 7
  let updated = 200
  let title = "Checkpoint"
  let unavailable = false
  let runtimeCalls = 0
  const messages = [{ info: { id: "assistant", role: "assistant", time: { created: 100 } }, parts: [{ id: "text", type: "text", text: "Stored" }] }]
  const hostedPulls: Array<{ path: string; authorization: string | null }> = []
  const worker = new Miniflare({
    ...hostedWorkerCompatibility(),
    modules: [{ type: "ESModule", path: "worker.mjs", contents: bundle.outputFiles[0].text }],
    d1Databases: ["CONTROL_PLANE_DB"],
    outboundService: async (request: Request) => {
      if (request.headers.get("authorization")?.includes("session-do:")) {
        hostedPulls.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
        return Response.json({ id: "ses_hosted", title: "Hosted", time: { created: 1, updated: 50 } })
      }
      runtimeCalls++
      if (unavailable) return new Response("runtime unavailable", { status: 503 })
      const path = new URL(request.url).pathname
      const session = { id: "ses", title, time: { created: 1, updated } }
      if (path.endsWith("/global/health")) return Response.json({ workspaceId: "ws" })
      if (path.endsWith("/session/ses/message")) return Response.json({ session, messages, maxEventOrdinal: ordinal })
      if (path.endsWith("/session/ses")) return Response.json(session)
      return new Response("not found", { status: 404 })
    },
  })
  try {
    const database = await worker.getD1Database("CONTROL_PLANE_DB")
    await applyControlPlaneBaseline(database)
    const command = (operation: string, key: string, expectedEventOrdinal = ordinal) => worker.dispatchFetch(`https://control.test/workspaces/ws/sessions/ses/${operation}`, {
      method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key, expectedEventOrdinal }),
    })
    const stored = async () => (await (await worker.dispatchFetch("https://control.test/stored")).json()) as {
      session: { title: string }; snapshot: { maxEventOrdinal: number; messages: unknown[] }
    }
    for (const operation of ["register", "checkpoint", "repair"]) {
      const response = await command(operation, operation)
      expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { ok: true } })
    }
    expect(await stored()).toMatchObject({ session: { title }, snapshot: { maxEventOrdinal: 7, messages } })
    const calls = runtimeCalls
    expect((await command("repair", "repair")).status).toBe(200)
    expect(runtimeCalls).toBe(calls)

    ordinal = 8
    updated = 300
    title = "Repaired"
    unavailable = true
    expect((await command("checkpoint", "retry")).status).toBe(503)
    expect((await stored()).snapshot.maxEventOrdinal).toBe(7)
    unavailable = false
    expect((await command("checkpoint", "retry")).status).toBe(200)
    expect((await command("repair", "new-repair")).status).toBe(200)
    expect(await stored()).toMatchObject({ session: { title: "Repaired" }, snapshot: { maxEventOrdinal: 8 } })

    title = "Stale"
    updated = 100
    ordinal = 6
    expect((await command("register", "stale-meta")).status).toBe(200)
    const stale = await command("checkpoint", "stale-snapshot", 8)
    expect(await stale.json()).toMatchObject({ skipped: true, currentOrdinal: 8, snapshotOrdinal: 6 })
    expect(await stored()).toMatchObject({ session: { title: "Repaired" }, snapshot: { maxEventOrdinal: 8, messages } })

    const hosted = (operation: string) => worker.dispatchFetch(`https://control.test/workspaces/ws/sessions/ses_hosted/${operation}`, {
      method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: `hosted-${operation}` }),
    })
    const before = runtimeCalls
    for (const operation of ["register", "checkpoint", "repair"]) {
      const response = await hosted(operation)
      expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { ok: true } })
    }
    expect(runtimeCalls).toBe(before)
    expect(hostedPulls).toEqual([
      { path: "/workspaces/ws/session/ses_hosted", authorization: "Bearer runtime-token-for-session-do:ses_hosted" },
      { path: "/workspaces/ws/session/ses_hosted", authorization: "Bearer runtime-token-for-session-do:ses_hosted" },
    ])
  } finally {
    await worker.dispose()
  }
})
