import { describe, expect, test } from "bun:test"
import type { TurnRequest } from "../../contract/broker"
import { createRequestBroker, createTurnBroker } from "../index"
import { type MemoryPorts, authority, origin } from "../../conformance/test-support/memory-ports"
import { byChild, filedSession, once, permission, question, spawn, tick } from "./child-request-fixtures"

export function registerChildRequestCases(name: string, make: () => MemoryPorts): void {
  async function setup(options: { started: boolean } = { started: true }) {
    const ports = make()
    const owner = createRequestBroker(ports)
    const controller = new AbortController()
    const turn = createTurnBroker(owner, { authority, origin, signal: controller.signal })
    const bind = async (toolCallId: string) => {
      const child = await turn.observeSubagent(spawn(toolCallId))
      if (!child) throw new Error(`No child session for ${toolCallId}`)
      turn.associateChild(toolCallId, child)
      if (options.started) ports.startChildTurn("s1", toolCallId)
      return child.sessionId
    }
    return { ports, owner, controller, turn, child: await bind("toolu_agent"), sibling: await bind("toolu_sibling") }
  }

  describe(`${name} child requests`, () => {
    test.each([["permission", permission], ["question", question]] as const)("a child's %s is filed and published on the child and answered only there", async (_kind, request) => {
      const { ports, owner, turn, child, sibling } = await setup()
      const waiting = turn.ask(byChild(request("child-ask"), "toolu_agent"))
      await tick()
      const listed = owner.broker.list({ sessionId: child })
      expect(listed.map((row) => [row.sessionId, filedSession(row.request)])).toEqual([[child, child]])
      expect(owner.broker.list({ sessionId: "s1" })).toEqual([])
      expect(ports.readPending({ sessionId: child }).map((row) => row.request.requestId)).toEqual(["child-ask"])
      const asked = ports.published.find((event) => event.type === "permission.asked" || event.type === "question.asked")
      expect((asked as { properties?: { sessionID?: string } } | undefined)?.properties?.sessionID).toBe(child)
      const reply = _kind === "permission" ? once : { kind: "answers" as const, answers: [["yes"]] }
      expect(await owner.broker.answer("child-ask", reply, { sessionId: "s1" })).toMatchObject({ ok: false, refusal: "foreign" })
      expect(await owner.broker.answer("child-ask", reply, { sessionId: sibling })).toMatchObject({ ok: false, refusal: "foreign" })
      expect(await owner.broker.answer("child-ask", reply, { sessionId: "unrelated" })).toMatchObject({ ok: false, refusal: "foreign" })
      expect(await createRequestBroker(make()).broker.answer("child-ask", reply, { sessionId: child })).toMatchObject({ ok: false, refusal: "stale" })
      expect(owner.broker.list({ sessionId: child })).toHaveLength(1)
      expect(await owner.broker.answer("child-ask", reply, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual(reply)
      expect(ports.readAnswer(child, "child-ask")).toEqual(reply)
      expect(ports.readAnswer("s1", "child-ask")).toBeUndefined()
    })

    test("a child's request cannot name a session other than the parent that asked it", async () => {
      const { turn } = await setup()
      const foreign: TurnRequest = { kind: "permission", requestId: "redirected",
        permission: { id: "redirected", sessionID: "s2", permission: "execute", patterns: [], always: [], metadata: {} } }
      await expect(turn.ask(byChild(foreign, "toolu_agent"))).rejects.toThrow("Permission belongs to another session")
    })

    test("always allow on a child's request is saved on the parent and answers the parent's and a sibling's later asks", async () => {
      const { ports, owner, turn, child, sibling } = await setup()
      const waiting = turn.ask(byChild(permission("child-grant", "run"), "toolu_agent"))
      await tick()
      expect(await owner.broker.answer("child-grant", { kind: "permission", decision: "allow_always" }, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual({ kind: "permission", decision: "allow_always" })
      expect(ports.readPermissionState("s1")?.brokerGrants).toEqual(['["c1","run"]'])
      expect(ports.readPermissionState(child)?.brokerGrants).toBeUndefined()
      expect(await turn.ask(permission("parent-again", "run"))).toEqual({ kind: "permission", decision: "allow_always" })
      expect(await turn.ask(byChild(permission("sibling-again", "run"), "toolu_sibling"))).toEqual({ kind: "permission", decision: "allow_always" })
      expect(ports.readAnswer("s1", "parent-again")).toEqual({ kind: "permission", decision: "allow_always" })
      expect(ports.readAnswer(sibling, "sibling-again")).toEqual({ kind: "permission", decision: "allow_always" })
      const other = turn.ask(byChild(permission("other-key", "other"), "toolu_agent"))
      await tick()
      expect(owner.broker.list({ sessionId: child }).map((row) => row.request.requestId)).toEqual(["other-key"])
      expect(await owner.broker.answer("other-key", { kind: "rejected" }, { sessionId: child })).toMatchObject({ ok: true })
      expect(await other).toEqual({ kind: "rejected" })
    })

    test("ending the parent turn, its signal or its owner leaves an open child turn's request answerable on the child", async () => {
      const { ports, owner, controller, turn, child } = await setup()
      const waiting = turn.ask(byChild(permission("child-survives"), "toolu_agent"))
      await tick()
      controller.abort()
      await owner.endTurn(authority)
      ports.current.set("s1", { ...authority, turnId: "replacement" })
      await tick()
      expect(owner.broker.list({ sessionId: child }).map((row) => row.request.requestId)).toEqual(["child-survives"])
      expect(await owner.broker.answer("child-survives", once, { sessionId: "s1" })).toMatchObject({ ok: false, refusal: "foreign" })
      expect(await owner.broker.answer("child-survives", once, { sessionId: child })).toMatchObject({ ok: true })
      expect(await waiting).toEqual(once)
    })

    test("ending the child's own turn cancels its request and refuses a late answer", async () => {
      const { ports, owner, turn, child } = await setup()
      const waiting = turn.ask(byChild(question("child-ends"), "toolu_agent"))
      await tick()
      ports.finishChildTurn("s1", "toolu_agent")
      const route = ports.childRoute("s1", "toolu_agent")
      if (route.kind === "unbound") throw new Error("child unbound")
      await owner.endChildTurn(route.childSessionId, route.assistantMessageId)
      expect(await waiting).toEqual({ kind: "cancelled" })
      expect(ports.readAnswer(child, "child-ends")).toEqual({ kind: "cancelled" })
      expect(await owner.broker.answer("child-ends", { kind: "rejected" }, { sessionId: child })).toMatchObject({ ok: false, refusal: "stale" })
    })

    test("a child whose turn has not started files on the child under the parent turn, which cancels it when it ends", async () => {
      const { ports, owner, controller, turn, child } = await setup({ started: false })
      const ending = turn.ask(byChild(permission("unstarted-end"), "toolu_agent"))
      const aborting = turn.ask(byChild(question("unstarted-abort"), "toolu_agent"))
      await tick()
      expect(owner.broker.list({ sessionId: child }).map((row) => row.request.requestId)).toEqual(["unstarted-end", "unstarted-abort"])
      controller.abort()
      expect(await aborting).toEqual({ kind: "cancelled" })
      await owner.endTurn(authority)
      expect(await ending).toEqual({ kind: "cancelled" })
      expect(ports.readAnswer(child, "unstarted-end")).toEqual({ kind: "cancelled" })
      expect(await owner.broker.answer("unstarted-end", once, { sessionId: child })).toMatchObject({ ok: false, refusal: "stale" })
    })

    test("a child's answer is saved before the harness is released, and a failed save releases nothing", async () => {
      const { ports, owner, turn, child } = await setup()
      const waiting = turn.ask(byChild(permission("child-save"), "toolu_agent"))
      let savedAtRelease: unknown = "not released"
      void waiting.then(() => { savedAtRelease = ports.readAnswer(child, "child-save") })
      await tick()
      ports.failPersist = true
      expect(await owner.broker.answer("child-save", once, { sessionId: child })).toMatchObject({ ok: false, refusal: "persistence", retryable: true })
      await tick()
      expect(savedAtRelease).toBe("not released")
      ports.failPersist = false
      expect(await owner.broker.answer("child-save", once, { sessionId: child })).toMatchObject({ ok: true })
      await waiting
      expect(savedAtRelease).toEqual(once)
    })

    test("a request from an unbound child is filed on the parent with a diagnostic", async () => {
      const { ports, owner, turn } = await setup()
      const waiting = turn.ask(byChild(permission("unbound-ask"), "toolu_unknown"))
      await tick()
      expect(owner.broker.list({ sessionId: "s1" }).map((row) => filedSession(row.request))).toEqual(["s1"])
      expect(ports.sessionEvents).toContainEqual({ sessionId: "s1", event: expect.objectContaining({ type: "diagnostic",
        diagnostic: expect.objectContaining({ code: "child_request_route_unbound",
          details: { requestId: "unbound-ask", requestKind: "permission", correlationKey: "toolu_unknown" } }) }) })
      expect(await owner.broker.answer("unbound-ask", once, { sessionId: "s1" })).toMatchObject({ ok: true })
      expect(await waiting).toEqual(once)
    })

    test("a request from a child whose turn finished is filed on the parent with a diagnostic", async () => {
      const { ports, owner, turn, child } = await setup()
      ports.finishChildTurn("s1", "toolu_agent")
      const waiting = turn.ask(byChild(question("finished-ask"), "toolu_agent"))
      await tick()
      expect(owner.broker.list({ sessionId: "s1" }).map((row) => filedSession(row.request))).toEqual(["s1"])
      expect(owner.broker.list({ sessionId: child })).toEqual([])
      expect(ports.sessionEvents).toContainEqual({ sessionId: "s1", event: expect.objectContaining({ type: "diagnostic",
        diagnostic: expect.objectContaining({ code: "child_request_route_finished",
          details: expect.objectContaining({ requestId: "finished-ask", correlationKey: "toolu_agent", childSessionId: child }) }) }) })
      expect(await owner.broker.answer("finished-ask", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
      expect(await waiting).toEqual({ kind: "rejected" })
    })
  })
}
