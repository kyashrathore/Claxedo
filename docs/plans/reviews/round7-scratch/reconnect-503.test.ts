import { expect, test } from "bun:test"
import { Hono } from "hono"
import { pump } from "./pump"
const pumps = new WeakMap<Response, ReturnType<typeof pump>>()
const readAll = (r: Response, ms: number) => { const p = pumps.get(r) ?? pump(r); pumps.set(r, p); return p.wait(ms) }
const WR = "/Users/yashvardhansingh/test/opencode-streams/packages/workspace-runtime/src"
const { createBus } = await import(`${WR}/bus`)
const { createRuntimeEventHub } = await import(`${WR}/runtime-event-hub`)
const { workspaceEventsHandler } = await import(`${WR}/routes/events`)
const { messagePartUpdated, sessionDeleted, withDir } = await import(`${WR}/compat-events`)
const { sessionEventDeliveryPolicy } = await import(`${WR}/event-delivery`)

const DIRECTORY = "/workspace"
function part(sessionID: string, id: string) {
  return withDir(DIRECTORY, messagePartUpdated({
    id, sessionID, messageID: `msg-${sessionID}`, type: "tool", callID: `call-${id}`, tool: "bash",
    state: { status: "running", input: {}, time: { start: 1 } },
  } as any))
}
const relayAuth = { actor_id: "actor_1", actor_kind: "human", org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role: "owner", parent_jti: "rat_1" }

function harness(policy: any, renewalIntervalMs = 5_000) {
  const app = new Hono()
  const hub = createRuntimeEventHub()
  const bus = createBus<any>()
  app.use("*", async (c, next) => { (c as any).set("relayHostAuth", relayAuth); await next() })
  app.get("/api/wr/events", workspaceEventsHandler({
    directory: DIRECTORY, workspaceId: "ws_1", eventHub: hub, bus, sequenceOrigin: () => 0,
    sessionAccessPolicy: policy, policy: sessionEventDeliveryPolicy(policy), renewalIntervalMs,
  }))
  return { app, hub, bus }
}

const ids = (text: string) => text.split("\n\n").map((f) => f.split("\n").find((l) => l.startsWith("id:"))?.slice(3).trim()).filter(Boolean)

test("SCENARIO A: reconnect during a transient 503 on a session already in the ring disconnects the reader and drops the frame with no hole", async () => {
  let mode: "ok" | "503" = "ok"
  const asked: string[] = []
  const policy = {
    sessionAuthority: "managed-private",
    authorize: () => ({ allowed: true }),
    authorizePrefix: () => ({ allowed: true }),
    filterSessions: (i: any) => i.sessionIds,
    registerSession: () => ({ allowed: true }),
    authorizeHost: () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 }),
    authorizeStream: async ({ sessionId }: any) => {
      asked.push(sessionId)
      return mode === "ok"
        ? { allowed: true, lease: "l", expiresAt: Date.now() + 60_000 }
        : { allowed: false, status: 503, code: "session_authority_unavailable", message: "away" }
    },
  }
  const { app, hub } = harness(policy)
  const c1 = new AbortController()
  const r1 = await app.request("http://localhost/api/wr/events", { signal: c1.signal })
  hub.publishGlobal(part("ses_a", "prt-1"))
  const first = await readAll(r1, 60)
  expect(first.text).toContain("prt-1")
  const cursor = ids(first.text).at(-1)!
  c1.abort()
  await new Promise((r) => setTimeout(r, 10))

  // Reconnect by cursor while the authority is away for one frame.
  mode = "503"
  const c2 = new AbortController()
  const r2 = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor }, signal: c2.signal })
  expect(r2.status).toBe(200)
  hub.publishGlobal(part("ses_a", "prt-2"))
  const second = await readAll(r2, 80)
  console.log("reconnect: done=%s text=%j", second.done, second.text)
  // Round-6 claim: a refusal of a never-granted session is an omit, never a terminate.
  const disconnected = second.done
  mode = "ok"
  // Third open with the same cursor: is prt-2 recovered or a gap reported?
  const c3 = new AbortController()
  const r3 = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor }, signal: c3.signal })
  hub.publishGlobal(part("ses_a", "prt-3"))
  const third = await readAll(r3, 60)
  console.log("third: %j", third.text)
  c2.abort(); c3.abort()
  expect(disconnected).toBe(false)
})

test("SCENARIO B: a session.deleted frame queued behind a pending decision, after the plane deleted the row, ends the reader and is never rung", async () => {
  const alive = new Set(["ses_mine"])
  let block: (() => void) | undefined
  const policy = {
    sessionAuthority: "managed-private",
    authorize: () => ({ allowed: true }),
    authorizePrefix: () => ({ allowed: true }),
    filterSessions: (i: any) => i.sessionIds,
    registerSession: () => ({ allowed: true }),
    authorizeHost: () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 }),
    authorizeStream: async ({ sessionId }: any) => {
      if (sessionId === "ses_slow") await new Promise<void>((r) => { block = r })
      return alive.has(sessionId) || sessionId === "ses_slow"
        ? { allowed: true, lease: "l", expiresAt: Date.now() + 60_000 }
        : { allowed: false, status: 403, code: "session_private", message: "deleted" }
    },
  }
  const { app, hub } = harness(policy)
  const c1 = new AbortController()
  const r1 = await app.request("http://localhost/api/wr/events", { signal: c1.signal })
  hub.publishGlobal(part("ses_mine", "prt-mine"))
  const first = await readAll(r1, 40)
  expect(first.text).toContain("prt-mine")
  // Another session's first frame holds the scope pending on its authority round trip.
  hub.publishGlobal(part("ses_slow", "prt-slow"))
  await new Promise((r) => setTimeout(r, 5))
  // The plane has deleted the row; the runtime publishes the deletion (queued behind the pending frame).
  alive.delete("ses_mine")
  hub.publishGlobal(withDir(DIRECTORY, sessionDeleted("ses_mine", DIRECTORY)))
  await new Promise((r) => setTimeout(r, 5))
  block!()
  const rest = await readAll(r1, 80)
  console.log("B: done=%s text=%j", rest.done, rest.text)
  c1.abort()
  const cursor = ids(first.text).at(-1)!
  const c2 = new AbortController()
  const r2 = await app.request("http://localhost/api/wr/events", { headers: { "Last-Event-ID": cursor }, signal: c2.signal })
  hub.publishGlobal(part("ses_slow", "prt-slow-2"))
  const again = await readAll(r2, 60)
  console.log("B reconnect from %s: done=%s text=%j", cursor, again.done, again.text)
  c2.abort()
  expect(rest.done).toBe(false)
  expect(rest.text).toContain("session.deleted")
})
