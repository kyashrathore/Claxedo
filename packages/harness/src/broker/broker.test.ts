import { MemoryPorts, authority, origin } from "../conformance/test-support/memory-ports"
import { registerBrokerBehaviorCases } from "./test-support/behavior-cases"
import { registerBrokerPortCases } from "./test-support/port-cases"
import { registerChildRequestCases } from "./test-support/child-request-cases"
import { expect, test, describe } from "bun:test"
import { createRequestBroker, createTurnBroker } from "./index"

registerBrokerPortCases("memory", () => {
  const ports = new MemoryPorts()
  return {
    ports, authority,
    prepareProviderTurn: () => {},
    abortProviderTurn: () => ports.cancelProviderTurn(),
    close: () => {},
  }
})

registerBrokerBehaviorCases("memory", () => new MemoryPorts())

registerChildRequestCases("memory", () => new MemoryPorts())

describe("request owner changes", () => {
  test("a late answer from an old turn is refused and reports the session owner", async () => {
    const ports = new MemoryPorts()
    const failures: { sessionId: string; error: unknown }[] = []
    ports.reportOwnerFailure = (sessionId, error) => { failures.push({ sessionId, error }) }
    const owner = createRequestBroker(ports)
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const waiting = turn.ask({ kind: "permission", requestId: "late", permission: {
      id: "late", sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {},
    } })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    ports.current.set("s1", { ...authority, turnId: "replacement" })
    expect(await owner.broker.answer("late", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" }))
      .toMatchObject({ ok: false, refusal: "foreign" })
    expect(await waiting).toEqual({ kind: "cancelled" })
    expect(failures).toHaveLength(1)
    expect(failures[0]?.sessionId).toBe("s1")
  })

  test("concurrent late answers from an old turn report the session owner once", async () => {
    const ports = new MemoryPorts()
    const failures: unknown[] = []
    ports.reportOwnerFailure = (_sessionId, error) => { failures.push(error) }
    const owner = createRequestBroker(ports)
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal })
    const waiting = turn.ask({ kind: "permission", requestId: "late", permission: {
      id: "late", sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {},
    } })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    ports.current.set("s1", { ...authority, turnId: "replacement" })
    const answers = await Promise.all([1, 2].map(() => owner.broker.answer("late", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })))
    expect(answers).toEqual([expect.objectContaining({ refusal: "foreign" }), expect.objectContaining({ refusal: "foreign" })])
    expect(await waiting).toEqual({ kind: "cancelled" })
    expect(failures).toHaveLength(1)
  })
})
