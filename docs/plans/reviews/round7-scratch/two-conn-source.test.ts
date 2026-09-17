import { expect, test } from "bun:test"
const WR = "/Users/yashvardhansingh/test/opencode-streams/packages/workspace-runtime/src"
const { createIdentityAwareEventSource, sessionEventDeliveryPolicy } = await import(`${WR}/event-delivery`)
type Ev = { sessionId?: string; value: string }
test("source-level: second connection omitted+disconnected while first keeps delivering?", async () => {
  let mode: "ok" | "503" = "ok"
  const policy = {
    sessionAuthority: "managed-private", authorize: () => ({ allowed: true }), authorizePrefix: () => ({ allowed: true }),
    filterSessions: (i: any) => i.sessionIds, registerSession: () => ({ allowed: true }),
    authorizeHost: () => ({ allowed: true, lease: "ws", expiresAt: Date.now() + 60_000 }),
    authorizeStream: async () => mode === "ok" ? { allowed: true, lease: "l", expiresAt: Date.now() + 60_000 } : { allowed: false, status: 503, code: "x", message: "away" },
  }
  const listeners = new Set<(e: Ev) => void>()
  const source = createIdentityAwareEventSource<Ev>({
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    policy: sessionEventDeliveryPolicy(policy as any),
    sessionId: (e) => e.sessionId,
    sequenceOrigin: () => 0,
  })
  const publish = (e: Ev) => { for (const l of listeners) l(e) }
  const principal = (connectionId: string) => ({ mode: "verified" as const, connectionId, actorId: "a", actorKind: "human" as const, orgId: "o", workspaceId: "w", role: "owner" as const, credential: "Bearer t", replayKey: "rat:1" })
  const got: Record<string, string[]> = { A: [], B: [] }
  const ended: string[] = []
  const a = source.open(principal("A")); await a.ready
  const unsubA = a.subscribe((e) => got.A.push(e.value), () => ended.push("A"))
  publish({ sessionId: "s", value: "1" })
  await new Promise((r) => setTimeout(r, 10))
  mode = "503"
  const b = source.open(principal("B")); await b.ready
  b.subscribe((e) => got.B.push(e.value), () => ended.push("B"))
  publish({ sessionId: "s", value: "2" })
  await new Promise((r) => setTimeout(r, 20))
  mode = "ok"
  publish({ sessionId: "s", value: "3" })
  await new Promise((r) => setTimeout(r, 20))
  console.log("got=%j ended=%j", got, ended)
  unsubA()
  expect(got.A).toEqual(["1", "2", "3"])
})
