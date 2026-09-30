import { expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ChildSessionRef, HarnessSession, OutsideTurnUsage, RoutedEvent, SessionBroker, TurnBroker, TurnInput } from "../../contract"
import { agentMessage, collabAgentToolCall, subAgentActivity, tokenUsage, turnCompleted, turnStarted } from "./test-support/native-frames"
import { scriptedTransport } from "./test-support/transport"

const PARENT = "thread-1"
const CHILD = "01a0f161-82c1-7033-9fb4-51a955f898b5"
const CHILD_TURN = "01a0f161-82c6-7132-bcb7-34374ffaf3a1"
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => { for (let round = 0; round < 10; round++) await tick() }

type Delivery = { via: "turn" | "publishChild"; event: RoutedEvent }

function recordingHost(base: SessionBroker) {
  const log: string[] = []
  const observations: SubagentObservation[] = []
  const delivered: Delivery[] = []
  const metered: OutsideTurnUsage[] = []
  const background: number[] = []
  let refs = 0
  const children = {
    observeSubagent: async (observation: SubagentObservation): Promise<ChildSessionRef> => {
      observations.push(observation)
      log.push(`observe:${observation.status}`)
      refs += 1
      return { sessionId: "child-session", assistantMessageId: `child-a${refs}`, created: 1 }
    },
    associateChild: (key: string) => { log.push(`associate:${key}`) },
  }
  const broker: SessionBroker = { ...base, ...children,
    publishChild: async (event: RoutedEvent) => { log.push(`publishChild:${event.event.type}`); delivered.push({ via: "publishChild", event }) },
    meter: (usage: OutsideTurnUsage) => { metered.push(usage) },
    publish: async (event: { type: string; agents?: number }) => { if (event.type === "background-work") background.push(event.agents ?? -1) },
  } as unknown as SessionBroker
  const turnBroker = { signal: new AbortController().signal, origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
    ask: async () => { throw new Error("No request expected") }, completeElicitation: async () => {}, ...children } as unknown as TurnBroker
  return { broker, turnBroker, log, observations, delivered, metered, background }
}

const turnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
  prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Delegate" }] }, todos: [] } as TurnInput

async function nativeSession() {
  const peer = await scriptedTransport()
  const host = recordingHost(peer.liveBroker())
  const session: HarnessSession = await peer.transport.start(peer.startInput, host.broker)
  const turnEvents: RoutedEvent[] = []
  const running = (async () => {
    for await (const event of peer.transport.send(session, turnInput, host.turnBroker)) {
      turnEvents.push(event)
      if (event.route?.kind === "child") host.delivered.push({ via: "turn", event })
    }
  })()
  await peer.started
  peer.emit(turnStarted(PARENT, "turn-current"))
  await settle()
  return { peer, host, session, turnEvents, running }
}

const childText = (host: ReturnType<typeof recordingHost>) => host.delivered
  .filter((row) => row.event.event.type === "text-delta").map((row) => [row.via, row.event.route, (row.event.event as { delta: string }).delta.trim()])

test("a Codex v2 native subagent becomes a background child session whose transcript keeps moving after the parent turn ends", async () => {
  const { peer, host, turnEvents, running } = await nativeSession()
  try {
    const started = { id: "call_1", kind: "started" as const, agentThreadId: CHILD, agentPath: "/root/child_probe" }
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", started))
    peer.emit(subAgentActivity("item/completed", PARENT, "turn-current", started))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    for (const frame of agentMessage(CHILD, CHILD_TURN, "msg_3", "CHILD-BEFORE")) peer.emit(frame)
    await settle()
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
    for (const frame of agentMessage(CHILD, CHILD_TURN, "msg_4", "CHILD-AFTER")) peer.emit(frame)
    peer.emit(tokenUsage(CHILD, CHILD_TURN, 1, 1))
    peer.emit(turnCompleted(CHILD, CHILD_TURN))
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { ...started, id: `subagent-completed-${CHILD_TURN}`, kind: "completed" }))
    await settle()

    expect(host.observations[0]).toMatchObject({ toolCallId: "call_1", toolCallRole: "spawn", mode: "background", status: "running",
      stableCorrelationId: CHILD, providerId: CHILD, providerKind: "codex", label: "child_probe", transcript: { kind: "live" } })
    expect(host.log.slice(0, 2)).toEqual(["observe:running", `associate:${CHILD}`])
    expect(childText(host)).toEqual([["turn", { kind: "child", correlationKey: CHILD }, "CHILD-BEFORE"],
      ["publishChild", { kind: "child", correlationKey: CHILD }, "CHILD-AFTER"]])
    expect(host.log.at(-1)).toBe("observe:completed")
    expect(host.log.indexOf("observe:completed")).toBeGreaterThan(host.log.lastIndexOf("publishChild:text-delta"))
    expect(host.observations.map((row) => row.status)).toEqual(["running", "completed"])
    expect(turnEvents.filter((row) => row.route?.kind !== "child" && row.event.type === "finish")).toHaveLength(1)
    expect(host.background).toEqual([1, 0])
  } finally { await peer.close() }
})

test("a native child's tokens are metered once, on the child, never on the parent", async () => {
  const { peer, host, running } = await nativeSession()
  try {
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { id: "call_1", kind: "started", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    peer.emit(tokenUsage(CHILD, CHILD_TURN, 5, 5))
    await settle()
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
    peer.emit(tokenUsage(CHILD, CHILD_TURN, 9, 4))
    peer.emit(turnCompleted(CHILD, CHILD_TURN))
    await settle()
    const childUsage = host.delivered.filter((row) => row.event.event.type === "usage")
    expect(childUsage.map((row) => [row.via, row.event.route?.kind])).toEqual([["turn", "child"], ["publishChild", "child"]])
    expect(host.metered).toEqual([])
  } finally { await peer.close() }
})

test("an interrupted or failed native child turn is not reported as success", async () => {
  for (const [status, error, expected] of [["interrupted", null, "interrupted"], ["failed", { message: "child exploded" }, "failed"]] as const) {
    const { peer, host, running } = await nativeSession()
    try {
      peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { id: "call_1", kind: "started", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
      peer.emit(turnStarted(CHILD, CHILD_TURN))
      peer.emit(turnCompleted(CHILD, CHILD_TURN, status, error))
      await settle()
      expect(host.observations.at(-1)).toMatchObject({ status: expected, ...(expected === "failed" ? { label: "child exploded" } : {}) })
      peer.emit(turnCompleted(PARENT, "turn-current"))
      await running
    } finally { await peer.close() }
  }
})

test("a v1 collab spawn binds each receiver before its frames route, and a later interaction opens a new child turn under that call", async () => {
  const { peer, host, running } = await nativeSession()
  try {
    const spawn = { id: "call_1", tool: "spawnAgent", prompt: "Reply with exactly NATIVECHILDTASK" }
    peer.emit(collabAgentToolCall("item/started", PARENT, "turn-current", { ...spawn, receiverThreadIds: [], agentsStates: {} }))
    peer.emit(collabAgentToolCall("item/completed", PARENT, "turn-current", { ...spawn, receiverThreadIds: [CHILD],
      agentsStates: { [CHILD]: { status: "pendingInit", message: null } } }))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    for (const frame of agentMessage(CHILD, CHILD_TURN, "msg_3", "FIRST")) peer.emit(frame)
    peer.emit(turnCompleted(CHILD, CHILD_TURN))
    const followup = { id: "call_2", tool: "sendInput", prompt: "Continue", receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: "running", message: null } } }
    peer.emit(collabAgentToolCall("item/started", PARENT, "turn-current", followup))
    peer.emit(turnStarted(CHILD, "child-turn-2"))
    for (const frame of agentMessage(CHILD, "child-turn-2", "msg_5", "SECOND")) peer.emit(frame)
    peer.emit(collabAgentToolCall("item/completed", PARENT, "turn-current", followup))
    peer.emit(turnCompleted(CHILD, "child-turn-2"))
    await settle()
    expect(host.observations.map((row) => [row.status, row.toolCallId, row.toolCallRole])).toEqual([
      ["running", "call_1", "spawn"], ["completed", undefined, undefined], ["running", "call_2", "interaction"], ["completed", undefined, undefined]])
    expect(host.observations[0]).toMatchObject({ description: "Reply with exactly NATIVECHILDTASK", mode: "background", providerId: CHILD })
    expect(childText(host).map((row) => row[2])).toEqual(["FIRST", "SECOND"])
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
  } finally { await peer.close() }
})

test("a v2 interaction opens the child's next turn under its call", async () => {
  const { peer, host, running } = await nativeSession()
  try {
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { id: "call_1", kind: "started", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    peer.emit(turnCompleted(CHILD, CHILD_TURN))
    peer.emit(subAgentActivity("item/completed", PARENT, "turn-current", { id: "call_Af8jXKO0U1Qmxq0HbZ30RphB", kind: "interacted", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
    peer.emit(turnStarted(CHILD, "child-turn-2"))
    await settle()
    expect(host.observations.map((row) => [row.status, row.toolCallId])).toEqual([
      ["running", "call_1"], ["completed", undefined], ["running", "call_Af8jXKO0U1Qmxq0HbZ30RphB"]])
    peer.emit(turnCompleted(CHILD, "child-turn-2"))
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
  } finally { await peer.close() }
})

test("per-task stop interrupts only the native child's running turn, and names no task it cannot find", async () => {
  const { peer, host, session, running } = await nativeSession()
  try {
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { id: "call_1", kind: "started", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
    await settle()
    expect(await peer.transport.backgroundTasks.stop(session, { toolCallId: "call_1" })).toEqual({ ok: true })
    expect(peer.frames.filter((frame) => frame.method === "turn/interrupt").map((frame) => frame.params)).toEqual([{ threadId: CHILD, turnId: CHILD_TURN }])
    peer.emit(turnCompleted(CHILD, CHILD_TURN, "interrupted"))
    await settle()
    expect(host.observations.at(-1)?.status).toBe("interrupted")
    expect(await peer.transport.backgroundTasks.stop(session, { toolCallId: "call_1" })).toMatchObject({ ok: false, status: "not_found" })
    expect(await peer.transport.backgroundTasks.stop(session, { toolCallId: "call_unknown" })).toMatchObject({ ok: false, status: "not_found" })
  } finally { await peer.close() }
})

test("an approval a native child asks names the child it came from", async () => {
  const { peer, host, running } = await nativeSession()
  try {
    const asked: unknown[] = []
    host.turnBroker.ask = (async (request: unknown) => { asked.push(request); return { kind: "permission", decision: "allow_once" } }) as TurnBroker["ask"]
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { id: "call_1", kind: "started", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    await settle()
    peer.request(91, "item/commandExecution/requestApproval", { threadId: CHILD, turnId: CHILD_TURN, itemId: "item-1", command: "ls", cwd: peer.root })
    for (let round = 0; round < 50 && !peer.frames.some((frame) => frame.id === 91 && !frame.method); round++) await tick()
    expect(asked).toMatchObject([{ child: { correlationKey: CHILD } }])
    expect(asked).not.toContainEqual(expect.objectContaining({ permission: expect.objectContaining({ metadata: expect.objectContaining({ subagent: expect.anything() }) }) }))
    peer.emit(turnCompleted(CHILD, CHILD_TURN))
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
  } finally { await peer.close() }
})

test("an approval a native child asks after its parent's turn ended goes to the session broker with the child's route", async () => {
  const { peer, host, running } = await nativeSession()
  try {
    const asked: { via: string; request: unknown }[] = []
    host.broker.ask = (async (request: unknown) => { asked.push({ via: "session", request }); return { kind: "permission", decision: "allow_once" } }) as SessionBroker["ask"]
    peer.emit(subAgentActivity("item/started", PARENT, "turn-current", { id: "call_1", kind: "started", agentThreadId: CHILD, agentPath: "/root/child_probe" }))
    peer.emit(turnStarted(CHILD, CHILD_TURN))
    await settle()
    peer.emit(turnCompleted(PARENT, "turn-current"))
    await running
    peer.request(92, "item/commandExecution/requestApproval", { threadId: CHILD, turnId: CHILD_TURN, itemId: "item-2", command: "ls", cwd: peer.root })
    for (let round = 0; round < 50 && !peer.frames.some((frame) => frame.id === 92 && !frame.method); round++) await tick()
    expect(asked).toMatchObject([{ via: "session", request: { child: { correlationKey: CHILD } } }])
    expect(peer.frames.find((frame) => frame.id === 92 && !frame.method)).toMatchObject({ result: { decision: "accept" } })
    peer.emit(turnCompleted(CHILD, CHILD_TURN))
    await settle()
  } finally { await peer.close() }
})
