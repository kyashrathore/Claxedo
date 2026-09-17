import { expect, test } from "bun:test"
import { Hono } from "hono"
import { pump } from "./pump"
const pumps = new WeakMap<Response, ReturnType<typeof pump>>()
const readAll = (r: Response, ms: number) => { const p = pumps.get(r) ?? pump(r); pumps.set(r, p); return p.wait(ms) }
const WR = "/Users/yashvardhansingh/test/opencode-streams/packages/workspace-runtime/src"
const { createBus } = await import(`${WR}/bus`)
const { createRuntimeEventHub } = await import(`${WR}/runtime-event-hub`)
const { workspaceEventsHandler } = await import(`${WR}/routes/events`)
const { messagePartUpdated, withDir } = await import(`${WR}/compat-events`)
const { sessionEventDeliveryPolicy } = await import(`${WR}/event-delivery`)
const DIRECTORY = "/workspace"
const part = (sessionID: string, id: string) => withDir(DIRECTORY, messagePartUpdated({ id, sessionID, messageID: `msg-${sessionID}`, type: "tool", callID: `call-${id}`, tool: "bash", state: { status: "running", input: {}, time: { start: 1 } } } as any))
const relayAuth = { actor_id: "actor_1", actor_kind: "human", org_id: "org_1", workspace_id: "ws_1", host_id: "host_1", role: "owner", parent_jti: "rat_1" }
test("a second tab (same actor, same RAT) reconnecting into a live scope during a transient 503 is DISCONNECTED, not held", async () => {
  let mode: "ok" | "503" = "ok"
  const policy = {
    sessionAuthority: "managed-private", authorize: () => ({ allowed: true }), authorizePrefix: () => ({ allowed: true }),
    filterSessions: (i: any) => i.sessionIds, registerSession: () => ({ allowed: true }),
    authorizeHost: () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 }),
    authorizeStream: async () => mode === "ok" ? { allowed: true, lease: "l", expiresAt: Date.now() + 60_000 } : { allowed: false, status: 503, code: "session_authority_unavailable", message: "away" },
  }
  const app = new Hono(); const hub = createRuntimeEventHub(); const bus = createBus<any>()
  app.use("*", async (c, next) => { (c as any).set("relayHostAuth", relayAuth); await next() })
  app.get("/api/wr/events", workspaceEventsHandler({ directory: DIRECTORY, workspaceId: "ws_1", eventHub: hub, bus, sequenceOrigin: () => 0, sessionAccessPolicy: policy, policy: sessionEventDeliveryPolicy(policy) }))
  const tabA = new AbortController()
  const a = await app.request("http://localhost/api/wr/events", { signal: tabA.signal })
  hub.publishGlobal(part("ses_a", "prt-1"))
  expect((await readAll(a, 40)).text).toContain("prt-1")
  mode = "503"
  const tabB = new AbortController()
  const b = await app.request("http://localhost/api/wr/events", { signal: tabB.signal })
  hub.publishGlobal(part("ses_a", "prt-2"))
  const bRead = await readAll(b, 80)
  const aRead = await readAll(a, 40)
  console.log("tab B: done=%s text=%j | tab A text=%j", bRead.done, bRead.text, aRead.text)
  mode = "ok"
  hub.publishGlobal(part("ses_a", "prt-3"))
  const aMore = await readAll(a, 60)
  console.log("tab A later: done=%s text=%j", aMore.done, aMore.text)
  tabA.abort(); tabB.abort()
  expect(bRead.done).toBe(false)
})
