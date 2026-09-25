import type { PendingRequest } from "../../contract/broker"
import { describe, expect, test } from "bun:test"
import { ElicitationValidationError, type AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { createRequestBroker, createSessionBroker, createTurnBroker } from "../index"
import { type MemoryPorts, authority, origin } from "../../conformance/test-support/memory-ports"
import { chooseBrokerPermissionOption } from "../options"

const permission = (id: string, grantKey?: string, options?: { optionId: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"; name: string }[]) => ({
  kind: "permission" as const, requestId: id, grantKey, options,
  permission: { id, sessionID: "s1", permission: "execute", patterns: [], always: [], metadata: {},
    ...(options === undefined ? {} : { options: options.map((option) => ({ id: option.optionId, label: option.name })) }) },
})
const question = (id: string) => ({
  kind: "question" as const, requestId: id,
  question: { id, sessionID: "s1", questions: [{ header: "Question", question: "Continue?", options: [], custom: true }] },
})
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

export function registerBrokerBehaviorCases(name: string, make: () => MemoryPorts): void {
  function setup() {
    const ports = make()
    const owner = createRequestBroker(ports)
    const controller = new AbortController()
    const turn = createTurnBroker(owner, { authority, origin, signal: controller.signal })
    return { ports, owner, controller, turn }
  }
describe(`${name} request broker`, () => {
  test("save before release and retry after persistence failure", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("p1"))
    await tick()
    ports.failPersist = true
    expect(await owner.broker.answer("p1", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: false, refusal: "persistence", retryable: true })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    let released = false
    void waiting.then(() => { released = true })
    await tick()
    expect(released).toBe(false)
    ports.failPersist = false
    expect(await owner.broker.answer("p1", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "permission", decision: "allow_once" })
  })

  test("stale, duplicate, foreign and unoffered do not mutate", async () => {
    const { ports, owner, turn } = setup()
    expect(await owner.broker.answer("missing", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
    const waiting = turn.ask(permission("p2", undefined, [{ optionId: "once", kind: "allow_once", name: "Once" }]))
    await tick()
    expect(await owner.broker.answer("p2", { kind: "permission", decision: "allow_once" }, { sessionId: "s2" })).toMatchObject({ refusal: "foreign" })
    ports.current.set("s1", { ...authority, workspaceId: "w2" })
    expect(await owner.broker.answer("p2", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ refusal: "foreign" })
    expect(await waiting).toEqual({ kind: "cancelled" })
    ports.current.set("s1", authority)
    const replacement = turn.ask(permission("p2-replacement", undefined, [{ optionId: "once", kind: "allow_once", name: "Once" }]))
    await tick()
    expect(await owner.broker.answer("p2-replacement", { kind: "permission", decision: "allow_once", optionId: "wrong" }, { sessionId: "s1" })).toMatchObject({ refusal: "unoffered" })
    expect(ports.saved).toHaveLength(1)
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    expect(await owner.broker.answer("p2-replacement", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await replacement).toEqual({ kind: "permission", decision: "allow_once", optionId: "once" })
    expect(await owner.broker.answer("p2-replacement", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "duplicate" })
  })

  test("abort answers every turn request cancelled", async () => {
    const { ports, owner, controller, turn } = setup()
    const first = turn.ask(permission("p3"))
    const second = turn.ask(question("q3"))
    await tick()
    controller.abort()
    expect(await first).toEqual({ kind: "cancelled" })
    expect(await second).toEqual({ kind: "cancelled" })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    expect(ports.saved.map((item) => item.answer)).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }])
  })

  test("grants are silent for an identical request and scoped to one session", async () => {
    const { ports, owner, turn } = setup()
    const first = turn.ask(permission("p4", "command:a"))
    await tick()
    await owner.broker.answer("p4", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })
    await first
    const asked = ports.published.length
    expect(await turn.ask(permission("p5", "command:a"))).toEqual({ kind: "permission", decision: "allow_always" })
    expect(ports.published.slice(asked).map((event) => event.type)).toEqual(["permission.auto-answered"])
    const different = turn.ask(permission("p6", "command:b"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    await owner.broker.answer("p6", { kind: "rejected" }, { sessionId: "s1" })
    await different
    const other = { ...authority, sessionId: "s2", turnId: "t2" }
    ports.current.set("s2", other)
    const otherTurn = createTurnBroker(owner, { authority: other, origin, signal: new AbortController().signal })
    const otherPermission = permission("p7", "command:a")
    otherPermission.permission.sessionID = "s2"
    const foreign = otherTurn.ask(otherPermission)
    await tick()
    expect(owner.broker.list({ sessionId: "s2" })).toHaveLength(1)
    await owner.broker.answer("p7", { kind: "rejected" }, { sessionId: "s2" })
    await foreign
  })

  test("failed grant write keeps the permission pending and unreleased", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("grant-failure", "command:a"))
    await tick()
    ports.failGrant = true
    expect(await owner.broker.answer("grant-failure", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ refusal: "persistence", retryable: true })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    let released = false
    void waiting.then(() => { released = true })
    await tick()
    expect(released).toBe(false)
    ports.failGrant = false
    expect(await owner.broker.answer("grant-failure", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "permission", decision: "allow_always" })
  })

  test("option substitution never widens allow once", () => {
    const option = (kind: "allow_once" | "allow_always" | "reject_once" | "reject_always") => ({ optionId: kind, kind, name: kind })
    expect(chooseBrokerPermissionOption("allow_once", [option("allow_always")])).toBeUndefined()
    expect(chooseBrokerPermissionOption("allow_always", [option("allow_once")])?.kind).toBe("allow_once")
    expect(chooseBrokerPermissionOption("deny", [option("reject_always")])?.kind).toBe("reject_always")
    expect(chooseBrokerPermissionOption("reject_always", [option("reject_once")])?.kind).toBe("reject_once")
    expect(chooseBrokerPermissionOption("allow_once", [])).toBeUndefined()
  })

  test("start request has operation, workspace, connection and directory authority", async () => {
    const { ports, owner } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op1", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    ports.startBinding = start
    const context = { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op1", start, origin }
    const session = createSessionBroker(owner, context)
    const waiting = session.ask(question("start1"))
    await tick()
    expect(owner.broker.list({ directory: "/work" })[0]?.start).toEqual(start)
    for (const field of ["operationId", "workspaceId", "connectionId", "directory"] as const) {
      expect(await owner.broker.answer("start1", { kind: "rejected" }, { start: { ...start, [field]: "wrong" } })).toMatchObject({ refusal: "foreign" })
    }
    expect(await owner.broker.answer("start1", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "foreign" })
    expect(ports.saved).toHaveLength(0)
    await owner.broker.answer("start1", { kind: "rejected" }, { start })
    expect(await waiting).toEqual({ kind: "rejected" })
  })

  test("expiry settles with expired", async () => {
    const { ports, owner } = setup()
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal, expiresAt: 20 })
    const waiting = turn.ask(question("expiry"))
    await tick()
    for (const callback of ports.timers.values()) callback()
    expect(await waiting).toEqual({ kind: "expired" })
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
  })

  test("form validation rejects invalid, busy and cancelled replies", async () => {
    const { ports, owner, controller, turn } = setup()
    const request = { kind: "elicitation" as const, requestId: "form", mode: "form" as const, message: "Name",
      schema: { type: "object", properties: { name: { type: "string", pattern: "^[A-Z]+$" } }, required: ["name"] } }
    const waiting = turn.ask(request)
    await tick()
    await expect(owner.broker.answer("form", { kind: "form", values: { name: 3 } }, { sessionId: "s1" })).rejects.toMatchObject({ code: "invalid_answer" })
    let release!: () => void
    ports.evaluated = new Promise<void>((resolve) => { release = resolve })
    const validating = owner.broker.answer("form", { kind: "form", values: { name: "VALID" } }, { sessionId: "s1" })
    await tick()
    await expect(owner.broker.answer("form", { kind: "form", values: { name: "OTHER" } }, { sessionId: "s1" })).rejects.toMatchObject({ code: "validation_busy" })
    controller.abort()
    release()
    expect(await waiting).toEqual({ kind: "cancelled" })
    expect(await validating).toMatchObject({ refusal: "duplicate" })
    expect(ports.evaluatorSignal?.aborted).toBe(true)
    expect(ports.saved.at(-1)?.answer).toEqual({ kind: "cancelled" })
    expect(ElicitationValidationError).toBeDefined()
  })

  test("provider turns drain each event and subagents reuse a child", async () => {
    const { ports, owner, turn } = setup()
    const child = { sessionId: "child", assistantMessageId: "assistant", created: 10 }
    ports.children.set(child.sessionId, child)
    turn.associateChild("agent", child)
    expect(await turn.observeSubagent({ observationId: "o1", subagentKey: "agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toEqual(child)
    expect(await turn.observeSubagent({ observationId: "o1", subagentKey: "agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toEqual(child)
    expect(ports.subagents).toHaveLength(1)
    await expect(turn.observeSubagent({ observationId: "o1", subagentKey: "agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "interaction" })).rejects.toThrow("conflicting content")
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    const admission = await session.admitProviderTurn({ reason: "goal" }, async function* () {
      yield { event: { type: "text-delta", delta: "hello" } }
    })
    expect(admission).toMatchObject({ admitted: true, turnId: expect.any(String) })
    if (admission.admitted) expect(await admission.settled).toEqual({ state: "completed" })
    expect(ports.drained).toHaveLength(1)
  })

  test("a provider turn the runtime cancels before its run ends settles cancelled", async () => {
    const { ports, owner } = setup()
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const result = await session.admitProviderTurn({ reason: "goal" }, async function* (turn) {
      yield { event: { type: "text-delta", delta: "started" } }
      await held
      if (turn.signal.aborted) throw new Error("interrupted by the runtime")
    })
    expect(result.admitted).toBe(true)
    ports.cancelProviderTurn()
    release()
    if (result.admitted) expect(await result.settled).toEqual({ state: "cancelled" })
  })

  test("provider settlement captures failure without rejecting and session events keep their id", async () => {
    const { ports, owner } = setup()
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    const result = await session.admitProviderTurn({ reason: "goal" }, async function* () {
      throw new Error("goal failed")
      yield { event: { type: "text-delta", delta: "unreachable" } }
    })
    expect(result.admitted).toBe(true)
    if (result.admitted) expect(await result.settled).toEqual({ state: "failed", error: "goal failed" })
    await session.publish({ type: "harness-notice", code: "session.ready", message: "Ready", severity: "info" })
    expect(ports.sessionEvents).toEqual([{ sessionId: "s1", event: {
      type: "harness-notice", code: "session.ready", message: "Ready", severity: "info",
    } }])
  })

  test("request abort persists cancellation before resolving and refuses a late answer", async () => {
    const { ports, owner, turn } = setup()
    const controller = new AbortController()
    const waiting = turn.ask(question("signal-abort"), { signal: controller.signal })
    await tick()
    controller.abort()
    expect(await waiting).toEqual({ kind: "cancelled" })
    expect(ports.saved.at(-1)?.answer).toEqual({ kind: "cancelled" })
    expect(await owner.broker.answer("signal-abort", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
  })

  test("rebind changes later ask identity while an earlier ask stays answerable", async () => {
    const { ports, owner, turn } = setup()
    const first = turn.ask(question("before-rebind"))
    await tick()
    const session = createSessionBroker(owner, { sessionId: "s1", workspaceId: "w1", directory: "/work", origin })
    await session.rebind("up2")
    const second = turn.ask(question("after-rebind"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" }).map((row) => row.upstreamSessionId)).toEqual(["up1", "up2"])
    expect(await owner.broker.answer("before-rebind", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await owner.broker.answer("after-rebind", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await Promise.all([first, second])).toEqual([{ kind: "rejected" }, { kind: "rejected" }])
    expect(ports.current.get("s1")?.upstreamSessionId).toBe("up2")
  })

  test("memory ports filter directory rows and keep the first answer", async () => {
    const { ports } = setup()
    const row: PendingRequest = { sessionId: "s1", request: question("first-write"), askedAt: 10, upstreamSessionId: "up1" }
    ports.pendingRows.set(JSON.stringify(["s1", "first-write"]), row)
    expect(ports.readPending({ directory: "/work" })).toEqual([row])
    expect(ports.readPending({ directory: "/elsewhere" })).toEqual([])
    await ports.persistAnswer(row, { kind: "cancelled" }, false)
    await ports.persistAnswer(row, { kind: "rejected" }, false)
    expect(ports.readAnswer("s1", "first-write")).toEqual({ kind: "cancelled" })
    expect(ports.saved).toHaveLength(1)
  })

  test("subagent admission survives broker restart without resetting revisions or republishing", async () => {
    const { ports, turn } = setup()
    await turn.observeSubagent({ observationId: "durable-1", providerKind: "claude", providerId: "agent-1", status: "running" })
    const restarted = createRequestBroker(ports)
    const later = createTurnBroker(restarted, { authority, origin, signal: new AbortController().signal })
    await later.observeSubagent({ observationId: "durable-1", providerKind: "claude", providerId: "agent-1", status: "running" })
    await later.observeSubagent({ observationId: "durable-2", providerKind: "claude", providerId: "agent-1", status: "completed" })
    expect(ports.subagents.map((event) => event.revision)).toEqual([1, 2])
    expect(ports.subagents[0]?.subagentKey).toBe(ports.subagents[1]?.subagentKey)
  })

  test("an unknown claxedo host binding publishes a diagnostic and continues", async () => {
    const { ports, turn } = setup()
    expect(await turn.observeSubagent({ observationId: "unknown-host", subagentKey: "missing", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toBeUndefined()
    expect(ports.diagnostics).toContainEqual(expect.objectContaining({ code: "subagent-binding-unknown" }))
    expect(ports.subagents).toHaveLength(0)
  })

  test("a host child binding survives broker restart", async () => {
    const { ports, turn } = setup()
    const child = { sessionId: "durable-child", assistantMessageId: "assistant", created: 10 }
    ports.children.set(child.sessionId, child)
    turn.associateChild("host-agent", child)
    const restarted = createRequestBroker(ports)
    const later = createTurnBroker(restarted, { authority, origin, signal: new AbortController().signal })
    expect(await later.observeSubagent({ observationId: "host-after-restart", subagentKey: "host-agent", providerKind: "claxedo", toolCallId: "tool", toolCallRole: "spawn" })).toEqual(child)
    expect(ports.subagents).toHaveLength(1)
    expect(ports.subagents[0]?.revision).toBe(2)
  })

  test("a new request broker reads completed answers without retaining process-lifetime state", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("completed-after-restart"))
    await tick()
    await owner.broker.answer("completed-after-restart", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })
    await waiting
    const restarted = createRequestBroker(ports)
    expect(await restarted.broker.answer("completed-after-restart", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "duplicate" })
    expect(await restarted.broker.answer("never-asked", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
  })
})

describe(`${name} broker review regressions`, () => {
  test("F16 completion releases URL identity without answering the person", async () => {
    const { ports, owner, controller, turn } = setup()
    const request = { kind: "elicitation" as const, mode: "url" as const, message: "Connect", url: "https://example.com", elicitationId: "oauth" }
    const waiting = turn.ask({ ...request, requestId: "consent-one" })
    await tick()
    await turn.completeElicitation("oauth")
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    expect(ports.saved).toHaveLength(0)
    expect(await owner.broker.answer("consent-one", { kind: "consent", accepted: true }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "consent", accepted: true })
    const accepted = turn.ask({ ...request, requestId: "consent-two" })
    await tick()
    await owner.broker.answer("consent-two", { kind: "consent", accepted: true }, { sessionId: "s1" })
    expect(await accepted).toEqual({ kind: "consent", accepted: true })
    await expect(turn.ask({ ...request, requestId: "consent-three" })).rejects.toThrow("Duplicate outstanding elicitationId")
    await turn.completeElicitation("oauth")
    const after = turn.ask({ ...request, requestId: "consent-four" })
    await tick()
    controller.abort()
    expect(await after).toEqual({ kind: "cancelled" })
  })

  test("F2 a saved answer replays across a crash before release, including cancellation", async () => {
    const { ports } = setup()
    ports.answers.set(JSON.stringify(["s1", "saved"]), { kind: "rejected" })
    ports.answers.set(JSON.stringify(["s1", "retired"]), { kind: "cancelled" })
    const restarted = createRequestBroker(ports)
    const turn = createTurnBroker(restarted, { authority, origin, signal: new AbortController().signal })
    expect(await turn.ask(question("saved"))).toEqual({ kind: "rejected" })
    expect(await turn.ask(question("retired"))).toEqual({ kind: "cancelled" })
    expect(ports.published).toHaveLength(0)
    expect(restarted.broker.list({ sessionId: "s1" })).toHaveLength(0)
  })

  test("F17 list and answer cancel requests after their start or turn authority ends", async () => {
    const { ports, owner, turn } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    ports.startBinding = start
    const session = createSessionBroker(owner, { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin })
    const starting = session.ask(question("dead-start"))
    const turning = turn.ask(question("dead-turn"))
    await tick()
    ports.startStatus = "created"
    ports.current.delete("s1")
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(0)
    await tick()
    expect(await starting).toEqual({ kind: "cancelled" })
    expect(await turning).toEqual({ kind: "cancelled" })
    const startAgain = createSessionBroker(owner, { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin })
    ports.startStatus = "starting"
    const answered = startAgain.ask(question("answer-dead"))
    await tick()
    ports.startStatus = "failed"
    expect(await owner.broker.answer("answer-dead", { kind: "rejected" }, { start })).toMatchObject({ refusal: "foreign" })
    expect(await answered).toEqual({ kind: "cancelled" })
  })

  test("F18 a re-ask during an orphan retirement write replays the retirement", async () => {
    const { ports, owner, turn } = setup()
    const pending: PendingRequest = { sessionId: "s1", request: question("orphan-race"), askedAt: 1, upstreamSessionId: "up1" }
    ports.pendingRows.set(JSON.stringify(["s1", "orphan-race"]), pending)
    let release!: () => void
    const gate = new Promise<void>((done) => { release = done })
    const persist = ports.persistAnswer.bind(ports)
    ports.persistAnswer = async (...args) => { await gate; return persist(...args) }
    owner.broker.list({ sessionId: "s1" })
    const reask = turn.ask(question("orphan-race"))
    await tick()
    release()
    expect(await reask).toEqual({ kind: "cancelled" })
    expect(ports.saved).toHaveLength(1)
    expect(ports.published).toHaveLength(0)
  })

  test("F18 a re-ask that claims its request first is never retired underneath", async () => {
    const { ports, owner, turn } = setup()
    ports.pendingRows.set(JSON.stringify(["s1", "claimed"]), { sessionId: "s1", request: question("claimed"), askedAt: 1, upstreamSessionId: "up1" })
    const reask = turn.ask(question("claimed"))
    owner.broker.list({ sessionId: "s1" })
    await tick()
    expect(ports.saved).toHaveLength(0)
    expect(owner.broker.list({ sessionId: "s1" }).map((row) => row.request.requestId)).toEqual(["claimed"])
    expect(await owner.broker.answer("claimed", { kind: "answers", answers: [["yes"]] }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await reask).toEqual({ kind: "answers", answers: [["yes"]] })
    expect(ports.saved).toHaveLength(1)
  })

  test("F2 a re-ask of a pending request nobody retired reopens it after a restart", async () => {
    const { ports } = setup()
    ports.pendingRows.set(JSON.stringify(["s1", "reopened"]), { sessionId: "s1", request: question("reopened"), askedAt: 1, upstreamSessionId: "up1" })
    const restarted = createRequestBroker(ports)
    const reask = createTurnBroker(restarted, { authority, origin, signal: new AbortController().signal }).ask(question("reopened"))
    await tick()
    expect(ports.published.map((event) => event.type)).toEqual(["question.asked"])
    expect(await restarted.broker.answer("reopened", { kind: "answers", answers: [["ok"]] }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await reask).toEqual({ kind: "answers", answers: [["ok"]] })
  })

  test("F19 a saved grant answer stands when the turn aborts after the save", async () => {
    for (const race of ["persist", "publish"] as const) {
      const { ports, controller, turn } = setup()
      ports.states.set("s1", { brokerGrants: [JSON.stringify(["c1", "same"])] })
      if (race === "persist") {
        const persist = ports.persistAnswer.bind(ports)
        ports.persistAnswer = async (...args) => {
          const result = await persist(...args)
          controller.abort()
          return result
        }
      } else {
        const publish = ports.publish.bind(ports)
        ports.publish = async (event) => { await publish(event); controller.abort() }
      }
      const answer = await turn.ask(permission(`grant-${race}-race`, "same"))
      expect(answer).toMatchObject({ kind: "permission", decision: "allow_always" })
      expect(ports.saved.map((row) => row.answer)).toEqual([answer])
    }
  })

  test("a person's answer stands when the turn aborts during its save", async () => {
    const { ports, owner, controller, turn } = setup()
    const waiting = turn.ask(permission("commit-race"))
    await tick()
    const persist = ports.persistAnswer.bind(ports)
    ports.persistAnswer = async (...args) => {
      const result = await persist(...args)
      controller.abort()
      return result
    }
    expect(await owner.broker.answer("commit-race", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await waiting).toMatchObject({ kind: "permission", decision: "allow_once" })
    expect(ports.saved.map((row) => row.answer)).toEqual([expect.objectContaining({ kind: "permission", decision: "allow_once" })])
  })

  test("F20 admission preserves evaluator codes, skips empty checks and honours prior abort", async () => {
    const { ports, controller, turn } = setup()
    const patterned = { kind: "elicitation" as const, mode: "form" as const, message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "." } } } }
    for (const code of ["validation_timeout", "validation_cancelled"] as const) {
      ports.services.patternEvaluator = async () => { throw new ElicitationValidationError(code, code) }
      await expect(turn.ask({ ...patterned, requestId: code })).rejects.toMatchObject({ code })
    }
    ports.evaluatedChecks.length = 0
    ports.services.patternEvaluator = async (checks) => { ports.evaluatedChecks.push(checks) }
    const plain = turn.ask({ ...patterned, requestId: "plain", schema: { type: "object", properties: { value: { type: "string" } } } })
    await tick()
    expect(ports.evaluatedChecks).toHaveLength(0)
    controller.abort()
    expect(await plain).toEqual({ kind: "cancelled" })
    expect(await turn.ask({ ...patterned, requestId: "already-aborted" })).toEqual({ kind: "cancelled" })
    expect(await turn.ask(permission("aborted-permission"))).toEqual({ kind: "cancelled" })
    expect(await turn.ask(question("aborted-question"))).toEqual({ kind: "cancelled" })
    expect(await turn.ask({ kind: "elicitation", mode: "url", requestId: "aborted-url", elicitationId: "aborted-url", message: "Connect", url: "https://example.com" })).toEqual({ kind: "cancelled" })
    expect(ports.published.some((event) => event.type === "question.asked" && event.id.includes("already-aborted"))).toBe(false)
  })

  test("F21 reply-only expiry and grant abort are readable and replayed", async () => {
    const { ports, controller, turn } = setup()
    expect(await turn.ask({ ...question("past"), expiresAt: 1 })).toEqual({ kind: "expired" })
    expect(ports.readAnswer("s1", "past")).toEqual({ kind: "expired" })
    expect(await turn.ask({ ...question("past"), expiresAt: 1 })).toEqual({ kind: "expired" })
    ports.states.set("s1", { brokerGrants: [JSON.stringify(["c1", "same"])] })
    ports.onReadPermissionState = () => controller.abort()
    expect(await turn.ask(permission("aborted-grant", "same"))).toEqual({ kind: "cancelled" })
    expect(ports.readAnswer("s1", "aborted-grant")).toEqual({ kind: "cancelled" })
    expect(await turn.ask(permission("aborted-grant", "same"))).toEqual({ kind: "cancelled" })
    expect(ports.published).toHaveLength(0)
  })

  test("F3 identical native ids coexist in separate sessions", async () => {
    const { ports, owner, turn } = setup()
    const other = { ...authority, sessionId: "s2", turnId: "t2" }
    ports.current.set("s2", other)
    const secondTurn = createTurnBroker(owner, { authority: other, origin, signal: new AbortController().signal })
    const first = turn.ask(question("native"))
    const secondRequest = question("native")
    secondRequest.question.sessionID = "s2"
    const second = secondTurn.ask(secondRequest)
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    expect(owner.broker.list({ sessionId: "s2" })).toHaveLength(1)
    expect(await owner.broker.answer("native", { kind: "answers", answers: [[]] }, { sessionId: "s2" })).toMatchObject({ ok: true })
    expect(await second).toEqual({ kind: "answers", answers: [[]] })
    expect(await owner.broker.answer("native", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ ok: true })
    expect(await first).toEqual({ kind: "rejected" })
  })

  test("F5 failed grant write records neither answer nor grant", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask(permission("atomic", "run"))
    await tick()
    ports.failGrant = true
    expect(await owner.broker.answer("atomic", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })).toMatchObject({ refusal: "persistence" })
    expect(ports.saved).toHaveLength(0)
    expect(ports.states.get("s1")?.brokerGrants).toBeUndefined()
    ports.failGrant = false
    await owner.broker.answer("atomic", { kind: "rejected" }, { sessionId: "s1" })
    expect(await waiting).toEqual({ kind: "rejected" })
  })

  test("F6 grant does not cross a harness switch", async () => {
    const { ports, owner, turn } = setup()
    const first = turn.ask(permission("grant-one", "same"))
    await tick()
    await owner.broker.answer("grant-one", { kind: "permission", decision: "allow_always" }, { sessionId: "s1" })
    await first
    expect(ports.readPermissionState("s1")?.brokerGrants).toEqual([JSON.stringify(["c1", "same"])])
    const switched = { ...authority, connectionId: "c2", turnId: "t2" }
    ports.current.set("s1", switched)
    const next = createTurnBroker(owner, { authority: switched, origin, signal: new AbortController().signal })
    const waiting = next.ask(permission("grant-two", "same"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    await owner.broker.answer("grant-two", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("F8 start must remain starting and elicitation carries connection", async () => {
    const { ports, owner } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    ports.startBinding = start
    const session = createSessionBroker(owner, { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin })
    const waiting = session.ask({ kind: "elicitation", requestId: "start-form", mode: "url", message: "Connect", url: "https://example.com" })
    await tick()
    expect(ports.published[0]).toMatchObject({ properties: { harnessPayload: { connectionId: "c1" } } })
    ports.startStatus = "created"
    expect(await owner.broker.answer("start-form", { kind: "consent", accepted: true }, { start })).toMatchObject({ refusal: "foreign" })
    expect(() => session.ask(question("late-start"))).toThrow("no longer running")
    await owner.requests.cancelStart({ sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin })
    await waiting
  })

  test("F9 malformed form is refused before publication", async () => {
    const { ports, turn } = setup()
    const asked = turn.ask({ kind: "elicitation", requestId: "bad-schema", mode: "form", message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "x".repeat(4097) } } } })
    await tick()
    expect(ports.published).toHaveLength(0)
    await expect(asked).rejects.toMatchObject({ code: "invalid_schema" })
  })

  test("F9 form patterns reach evaluator before asked publication", async () => {
    const { ports, owner, turn } = setup()
    const waiting = turn.ask({ kind: "elicitation", requestId: "pattern-admission", mode: "form", message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } } })
    await tick()
    expect(ports.evaluatedChecks[0]).toEqual([{ field: "value", pattern: "^ok$" }])
    expect(ports.published).toHaveLength(1)
    await owner.broker.answer("pattern-admission", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("F10 pending turn keeps upstream identity", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(question("upstream"))
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })[0]?.upstreamSessionId).toBe("up1")
    await owner.broker.answer("upstream", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("F12 explicit option must match decision", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(permission("exact", "grant", [{ optionId: "once", kind: "allow_once", name: "Once" }]))
    await tick()
    expect(await owner.broker.answer("exact", { kind: "permission", decision: "allow_always", optionId: "once" }, { sessionId: "s1" }))
      .toMatchObject({ refusal: "unoffered" })
    await owner.broker.answer("exact", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("caller cannot submit terminal answers", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(question("terminal"))
    await tick()
    expect(await owner.broker.answer("terminal", { kind: "cancelled" }, { sessionId: "s1" })).toMatchObject({ refusal: "unoffered" })
    expect(await owner.broker.answer("terminal", { kind: "expired" }, { sessionId: "s1" })).toMatchObject({ refusal: "unoffered" })
    await owner.broker.answer("terminal", { kind: "rejected" }, { sessionId: "s1" })
    await waiting
  })

  test("per-request deadlines expire independently", async () => {
    const { ports, owner } = setup()
    const turn = createTurnBroker(owner, { authority, origin, signal: new AbortController().signal, expiresAt: 100 })
    const early = turn.ask({ ...question("early"), expiresAt: 20 })
    const later = turn.ask({ ...question("later"), expiresAt: 80 })
    await tick()
    expect([...ports.timerDelays.values()]).toEqual([10, 70])
    const firstTimer = [...ports.timers.values()][0]
    firstTimer?.()
    expect(await early).toEqual({ kind: "expired" })
    expect(owner.broker.list({ sessionId: "s1" }).map((row) => row.request.requestId)).toEqual(["later"])
    const secondTimer = [...ports.timers.values()][0]
    secondTimer?.()
    expect(await later).toEqual({ kind: "expired" })
  })

  test("F2 list retires durable requests after restart", async () => {
    const { ports } = setup()
    const pending: PendingRequest = { sessionId: "s1", request: question("orphan"), askedAt: 1, upstreamSessionId: "up1" }
    ports.pendingRows.set(JSON.stringify(["s1", "orphan"]), pending)
    const restarted = createRequestBroker(ports)
    expect(restarted.broker.list({ sessionId: "s1" })).toEqual([])
    await tick()
    expect(ports.saved.at(-1)?.answer).toEqual({ kind: "cancelled" })
    expect(await restarted.broker.answer("orphan", { kind: "rejected" }, { sessionId: "s1" })).toMatchObject({ refusal: "stale" })
  })

  test("F4 failed cancellation during validation is retried by the next answer", async () => {
    const { ports, owner, controller, turn } = setup()
    const waiting = turn.ask({ kind: "elicitation", requestId: "cancel-race", mode: "form", message: "Form", schema: { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } } })
    await tick()
    let release!: () => void
    ports.evaluated = new Promise<void>((done) => { release = done })
    const validating = owner.broker.answer("cancel-race", { kind: "form", values: { value: "ok" } }, { sessionId: "s1" })
    await tick()
    ports.failPersist = true
    controller.abort()
    await tick()
    release()
    expect(await validating).toMatchObject({ refusal: "persistence" })
    ports.failPersist = false
    expect(await owner.broker.answer("cancel-race", { kind: "form", values: { value: "ok" } }, { sessionId: "s1" }))
      .toMatchObject({ refusal: "duplicate" })
    expect(await waiting).toEqual({ kind: "cancelled" })
  })

  test("F8 URL consent deduplicates until completion", async () => {
    const { ports, owner, controller, turn } = setup()
    const request = { kind: "elicitation" as const, mode: "url" as const, message: "Connect", url: "https://example.com", elicitationId: "oauth" }
    const first = turn.ask({ ...request, requestId: "url-one" })
    await tick()
    expect(ports.published[0]).toMatchObject({ properties: { harnessPayload: { connectionId: "c1" } } })
    const duplicate = turn.ask({ ...request, requestId: "url-two" })
    await tick()
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    await expect(duplicate).rejects.toThrow("Duplicate outstanding elicitationId")
    await turn.completeElicitation("oauth")
    expect(ports.saved).toHaveLength(0)
    expect(owner.broker.list({ sessionId: "s1" })).toHaveLength(1)
    controller.abort()
    expect(await first).toEqual({ kind: "cancelled" })
  })

  test("F11 duplicate permission answer is a refusal during validation", async () => {
    const { owner, turn } = setup()
    const waiting = turn.ask(permission("busy"))
    await tick()
    const first = owner.broker.answer("busy", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })
    const second = owner.broker.answer("busy", { kind: "permission", decision: "allow_once" }, { sessionId: "s1" })
    expect(await second)
      .toMatchObject({ refusal: "duplicate" })
    await first
    await waiting
  })

  test("F13 grant auto-answer checks abort before persisting", async () => {
    const { ports, controller, turn } = setup()
    ports.states.set("s1", { brokerGrants: ["same", JSON.stringify(["c1", "same"])] })
    ports.onReadPermissionState = () => controller.abort()
    expect(await turn.ask(permission("auto-abort", "same"))).toEqual({ kind: "cancelled" })
    expect(ports.saved.every((row) => row.answer.kind !== "permission")).toBe(true)
  })

  test("cancelling a turn cancels every request even when one cancel fails to persist", async () => {
    const { ports, owner, turn } = setup()
    void turn.ask(question("cancel-a"))
    const second = turn.ask(question("cancel-b"))
    await tick()
    const persist = ports.persistAnswer.bind(ports)
    ports.persistAnswer = async (pending, answer, automatic, grant) => {
      if (pending.request.requestId === "cancel-a") throw new Error("disk full")
      return persist(pending, answer, automatic, grant)
    }
    await expect(owner.requests.cancelTurn(authority)).rejects.toThrow("could not be cancelled")
    expect(await second).toEqual({ kind: "cancelled" })
  })

  test("answer waits for asked publication", async () => {
    const { ports, owner, turn } = setup()
    let release!: () => void
    ports.publishGate = new Promise<void>((done) => { release = done })
    const waiting = turn.ask(question("publish-race"))
    await tick()
    const answer = owner.broker.answer("publish-race", { kind: "rejected" }, { sessionId: "s1" })
    await tick()
    expect(ports.saved).toHaveLength(0)
    release()
    expect(await answer).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ kind: "rejected" })
  })

  test("start factory checks connection and operation", () => {
    const { owner } = setup()
    const start: AgentSessionStartBinding = { sessionId: "s1", operationId: "op", workspaceId: "w1", connectionId: "c1", directory: "/work" }
    const context = { sessionId: "s1", directory: "/work", workspaceId: "w1", connectionId: "c1", operationId: "op", start, origin }
    expect(() => createSessionBroker(owner, { ...context, connectionId: "wrong" })).toThrow("does not match")
    expect(() => createSessionBroker(owner, { ...context, operationId: "wrong" })).toThrow("does not match")
  })
})

}
