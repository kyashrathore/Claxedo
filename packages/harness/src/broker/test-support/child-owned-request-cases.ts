import { describe, expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { TurnRequest } from "../../contract/broker"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../index"
import { type MemoryPorts, authority, origin } from "../../conformance/test-support/memory-ports"

const permission = (id: string, grantKey?: string, sessionID = "s1"): TurnRequest => ({
  kind: "permission", requestId: id, ...(grantKey ? { grantKey } : {}),
  permission: { id, sessionID, permission: "execute", patterns: [], always: [], metadata: {} },
})
const question = (id: string): TurnRequest => ({
  kind: "question", requestId: id,
  question: { id, sessionID: "s1", questions: [{ header: "Question", question: "Continue?", options: [], custom: true }] },
})
const byChild = (request: TurnRequest, correlationKey: string): TurnRequest => ({ ...request, child: { correlationKey } })
const spawn = (toolCallId: string): SubagentObservation => ({
  observationId: `spawn:${toolCallId}`, providerKind: "claude-agent", toolCallId, toolCallRole: "spawn",
  status: "running", mode: "background", transcript: { kind: "live" },
})
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
const once = { kind: "permission", decision: "allow_once" } as const

function filedSession(request: TurnRequest | undefined): string | undefined {
  if (request?.kind === "permission") return request.permission.sessionID
  if (request?.kind === "question") return request.question.sessionID
  return undefined
}

export function registerChildOwnedRequestCases(name: string, make: () => MemoryPorts): void {
  async function idleParent() {
    const ports = make()
    const owner = createRequestBroker(ports)
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const bind = async (toolCallId: string) => {
      const child = await turn.observeSubagent(spawn(toolCallId))
      if (!child) throw new Error(`No child session for ${toolCallId}`)
      turn.associateChild(toolCallId, child)
      ports.startChildTurn("s1", toolCallId)
      return child.sessionId
    }
    const child = await bind("toolu_agent")
    const sibling = await bind("toolu_sibling")
    ports.current.delete("s1")
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    return { ports, owner, session, child, sibling }
  }

  describe(`${name} child-owned requests while the parent is idle`, () => {
    test.each([["permission", permission], ["question", question]] as const)("a child's %s is filed on the child and answered only there", async (kind, request) => {
      const { ports, owner, session, child, sibling } = await idleParent()
      const waiting = session.ask(byChild(request("idle-ask"), "toolu_agent"))
      await tick()
      expect(owner.broker.list({ sessionId: child }).map((row) => [row.sessionId, filedSession(row.request)])).toEqual([[child, child]])
      expect(owner.broker.list({ sessionId: "s1" })).toEqual([])
      expect(owner.broker.list({ directory: "/work" }).map((row) => row.request.requestId)).toEqual(["idle-ask"])
      const reply = kind === "permission" ? once : { kind: "answers" as const, answers: [["yes"]] }
      for (const other of ["s1", sibling, "unrelated"]) {
        expect(await owner.broker.answer("idle-ask", reply, { sessionId: other })).toMatchObject({ ok: false, refusal: "foreign" })
      }
      expect(await createRequestBroker(make()).broker.answer("idle-ask", reply, { sessionId: child })).toMatchObject({ ok: false, refusal: "stale" })
      let savedAtRelease: unknown = "not released"
      void waiting.then(() => { savedAtRelease = ports.readAnswer(child, "idle-ask") })
      expect(await owner.broker.answer("idle-ask", reply, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual(reply)
      expect(savedAtRelease).toEqual(reply)
    })

    test("a failed save releases nothing and the answer can be given again", async () => {
      const { ports, owner, session, child } = await idleParent()
      const waiting = session.ask(byChild(permission("idle-save"), "toolu_agent"))
      let released = false
      void waiting.then(() => { released = true })
      await tick()
      ports.failPersist = true
      expect(await owner.broker.answer("idle-save", once, { sessionId: child })).toMatchObject({ ok: false, refusal: "persistence", retryable: true })
      await tick()
      expect(released).toBe(false)
      ports.failPersist = false
      expect(await owner.broker.answer("idle-save", once, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual(once)
    })

    test.each([
      ["the child's turn finished", (ports: MemoryPorts) => ports.finishChildTurn("s1", "toolu_agent")],
      ["the child's route moved to a later turn", (ports: MemoryPorts) => ports.reopenChildTurn("s1", "toolu_agent")],
      ["the parent's binding changed", (ports: MemoryPorts) => ports.rebindConnection("s1", "c2")],
    ] as const)("an answer is refused and the request cancelled once %s", async (_case, change) => {
      const { ports, owner, session, child } = await idleParent()
      const waiting = session.ask(byChild(permission("idle-current"), "toolu_agent"))
      await tick()
      change(ports)
      expect(await owner.broker.answer("idle-current", once, { sessionId: child })).toMatchObject({ ok: false, refusal: "foreign" })
      expect(await waiting).toEqual({ kind: "cancelled" })
      expect(ports.readAnswer(child, "idle-current")).toEqual({ kind: "cancelled" })
    })

    test("always allow on a child-owned request is saved on the parent alone and answers the parent's children as a parent grant does", async () => {
      const { ports, owner, session, child, sibling } = await idleParent()
      const waiting = session.ask(byChild(permission("idle-grant", "run"), "toolu_agent"))
      await tick()
      expect(await owner.broker.answer("idle-grant", { kind: "permission", decision: "allow_always" }, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual({ kind: "permission", decision: "allow_always" })
      expect(ports.readPermissionState("s1")?.brokerGrants).toEqual(['["c1","run"]'])
      expect(ports.readPermissionState(child)?.brokerGrants).toBeUndefined()
      expect(ports.readPermissionState(sibling)?.brokerGrants).toBeUndefined()
      expect(await session.ask(byChild(permission("sibling-grant", "run"), "toolu_sibling"))).toEqual({ kind: "permission", decision: "allow_always" })
      ports.current.set("s2", { ...authority, sessionId: "s2", upstreamSessionId: "up2", turnId: "t2" })
      const other = createTurnBroker(owner, { authority: ports.current.get("s2")!, origin, signal: new AbortController().signal })
      const foreign = other.ask(permission("other-session", "run", "s2"))
      await tick()
      expect(owner.broker.list({ sessionId: "s2" }).map((row) => row.request.requestId)).toEqual(["other-session"])
      expect(ports.readAnswer("s2", "other-session")).toBeUndefined()
      await owner.broker.answer("other-session", { kind: "rejected" }, { sessionId: "s2" })
      expect(await foreign).toEqual({ kind: "rejected" })
    })

    test.each([
      ["the child's turn settles", async (fixture: Awaited<ReturnType<typeof idleParent>>) => {
        fixture.ports.finishChildTurn("s1", "toolu_agent")
        const route = fixture.ports.childRoute("s1", "toolu_agent")
        if (route.kind === "unbound") throw new Error("child unbound")
        await fixture.owner.endChildTurn(route.childSessionId, route.assistantMessageId)
      }],
      ["the parent session closes", async (fixture: Awaited<ReturnType<typeof idleParent>>) => { fixture.owner.broker.closeSession("s1") }],
      ["the child session closes", async (fixture: Awaited<ReturnType<typeof idleParent>>) => { fixture.owner.broker.closeSession(fixture.child) }],
    ] as const)("the request is cancelled when %s", async (_case, end) => {
      const fixture = await idleParent()
      const waiting = fixture.session.ask(byChild(question("idle-end"), "toolu_agent"))
      await tick()
      await end(fixture)
      expect(await waiting).toEqual({ kind: "cancelled" })
      expect(fixture.ports.readAnswer(fixture.child, "idle-end")).toEqual({ kind: "cancelled" })
      expect(await fixture.owner.broker.answer("idle-end", { kind: "answers", answers: [["yes"]] }, { sessionId: fixture.child }))
        .toMatchObject({ ok: false, refusal: "stale" })
    })

    test("the ask's own signal cancels the request", async () => {
      const { ports, session, child } = await idleParent()
      const controller = new AbortController()
      const waiting = session.ask(byChild(permission("idle-abort"), "toolu_agent"), { signal: controller.signal })
      await tick()
      controller.abort()
      expect(await waiting).toEqual({ kind: "cancelled" })
      expect(ports.readAnswer(child, "idle-abort")).toEqual({ kind: "cancelled" })
    })

    test("a parent turn that starts and ends meanwhile leaves the request answerable on the child", async () => {
      const { ports, owner, session, child } = await idleParent()
      const waiting = session.ask(byChild(permission("idle-through-turn"), "toolu_agent"))
      await tick()
      const next = { ...authority, turnId: "t2" }
      ports.current.set("s1", next)
      expect(owner.broker.list({ sessionId: child }).map((row) => row.request.requestId)).toEqual(["idle-through-turn"])
      expect(owner.broker.list({ sessionId: "s1" })).toEqual([])
      await owner.endTurn(next)
      expect(owner.broker.list({ sessionId: child })).toHaveLength(1)
      expect(await owner.broker.answer("idle-through-turn", once, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual(once)
    })

    test.each([
      ["unbound", "toolu_unknown", (_ports: MemoryPorts) => {}],
      ["finished", "toolu_agent", (ports: MemoryPorts) => ports.finishChildTurn("s1", "toolu_agent")],
    ] as const)("a request from an %s child while the parent is idle is refused with a diagnostic", async (kind, key, change) => {
      const { ports, owner, session } = await idleParent()
      change(ports)
      await expect(session.ask(byChild(permission("idle-refused"), key))).rejects.toThrow("needs a running child")
      await tick()
      expect(owner.broker.list({ directory: "/work" })).toEqual([])
      expect(ports.sessionEvents).toContainEqual({ sessionId: "s1", event: expect.objectContaining({ type: "diagnostic",
        diagnostic: expect.objectContaining({ code: kind === "unbound" ? "child_request_route_unbound" : "child_request_route_finished",
          details: expect.objectContaining({ requestId: "idle-refused", correlationKey: key }) }) }) })
    })

    test("a request naming another session through a child route is refused", async () => {
      const { session } = await idleParent()
      await expect(session.ask(byChild(permission("redirected", undefined, "s2"), "toolu_agent"))).rejects.toThrow("Permission belongs to another session")
    })
  })
}
