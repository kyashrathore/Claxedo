import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { BrokerPorts, TurnAuthority } from "../ports"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../index"

type Fixture = {
  ports: BrokerPorts
  authority: TurnAuthority
  prepareProviderTurn(): void
  abortProviderTurn(): void
  close(): void
}

const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const question = (id: string) => ({
  kind: "question" as const, requestId: id,
  question: { id, sessionID: "s1", questions: [{ header: "Question", question: "Continue?", options: [], custom: true }] },
})
const permission = (id: string) => ({
  kind: "permission" as const, requestId: id, grantKey: "run",
  permission: { id, sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {} },
})
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

export function registerBrokerPortCases(name: string, make: () => Fixture): void {
  describe(`${name} broker port contract`, () => {
    let fixture: Fixture
    beforeEach(() => { fixture = make() })
    afterEach(() => { fixture.close() })

    test("asked rows are directory scoped and the first saved answer is final", async () => {
      const { ports, authority } = fixture
      const owner = createRequestBroker(ports)
      const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
      const waiting = turn.ask(question("first"))
      await tick()
      expect(ports.readPending({ directory: "/work" }).map((row) => row.request.requestId)).toEqual(["first"])
      expect(ports.readPending({ directory: "/elsewhere" })).toEqual([])
      await owner.broker.answer("first", { kind: "rejected" }, { sessionId: "s1" })
      expect(await waiting).toEqual({ kind: "rejected" })
      expect(ports.readAnswer("s1", "first")).toEqual({ kind: "rejected" })
      expect(ports.readPending({ directory: "/work" })).toEqual([])
    })

    test("abort before save records cancelled and rejects a late answer", async () => {
      const { ports, authority } = fixture
      const owner = createRequestBroker(ports)
      const controller = new AbortController()
      const turn = createTurnBroker(owner, { authority, origin, signal: controller.signal })
      const waiting = turn.ask(question("abort"))
      await tick()
      controller.abort()
      expect(await waiting).toEqual({ kind: "cancelled" })
      expect(ports.readAnswer("s1", "abort")).toEqual({ kind: "cancelled" })
      expect(await owner.broker.answer("abort", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
    })

    test("answer and grant are saved before an automatic answer", async () => {
      const { ports, authority } = fixture
      const owner = createRequestBroker(ports)
      const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
      const waiting = turn.ask(permission("grant"))
      await tick()
      expect(await owner.broker.answer("grant", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ ok: true })
      expect(await waiting).toEqual({ kind: "permission", decision: "allow_always" })
      expect(ports.readPermissionState("s1")?.brokerGrants).toEqual(['["c1","run"]'])
      expect(await turn.ask(permission("automatic"))).toEqual({ kind: "permission", decision: "allow_always" })
      expect(ports.readAnswer("s1", "automatic")).toEqual({ kind: "permission", decision: "allow_always" })
    })

    test("rebind changes later requests without disowning earlier requests", async () => {
      const { ports, authority } = fixture
      const owner = createRequestBroker(ports)
      const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
      const before = turn.ask(question("before"))
      await tick()
      const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
      await session.rebind("up2")
      const after = turn.ask(question("after"))
      await tick()
      expect(owner.broker.list({ sessionId: "s1" }).map((row) => row.upstreamSessionId)).toEqual(["up1", "up2"])
      await owner.broker.answer("before", { kind: "rejected" }, { sessionId: "s1" })
      await owner.broker.answer("after", { kind: "rejected" }, { sessionId: "s1" })
      expect(await Promise.all([before, after])).toEqual([{ kind: "rejected" }, { kind: "rejected" }])
    })

    test("provider admission is immediate and runtime cancellation settles cancelled", async () => {
      const { ports } = fixture
      fixture.prepareProviderTurn()
      const owner = createRequestBroker(ports)
      const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
      let release!: () => void
      const held = new Promise<void>((resolve) => { release = resolve })
      const admitted = await session.admitProviderTurn({ reason: "goal" }, async function* (turn) {
        yield { event: { type: "text-delta", delta: "started" } }
        await held
        if (turn.signal.aborted) throw new Error("runtime cancelled")
      })
      expect(admitted.admitted).toBe(true)
      fixture.abortProviderTurn()
      release()
      if (admitted.admitted) expect(await admitted.settled).toEqual({ state: "cancelled" })
    })
  })
}
