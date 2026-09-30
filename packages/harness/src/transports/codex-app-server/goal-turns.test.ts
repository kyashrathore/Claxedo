import { expect, test } from "bun:test"
import type { HarnessSession, RoutedEvent, SessionBroker, TurnBroker, TurnInput, TurnRef } from "../../contract"
import { scriptedTransport } from "./test-support/transport"

const turnInput = (id: string) => ({ turnId: id, userMessageId: `u-${id}`, assistantMessageId: id, origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
  prompt: { agent: "codex", assistantMessageId: id, parts: [{ type: "text", text: "Reply" }] }, todos: [] } as TurnInput)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => { for (let round = 0; round < 5; round++) await tick() }

function hostBroker(base: SessionBroker) {
  let lease = false
  let freed: (() => void)[] = []
  const release = () => { lease = false; const waiting = freed; freed = []; for (const wake of waiting) wake() }
  const leased = async (): Promise<void> => {
    if (!lease) { lease = true; return }
    await new Promise<void>((wake) => { freed.push(wake) })
    return leased()
  }
  const refused: string[] = []
  const asked: string[] = []
  const events = new Map<string, RoutedEvent[]>()
  const controllers: AbortController[] = []
  const turnBroker = (signal: AbortSignal): TurnBroker => ({ signal, origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
    ask: async (request: { kind: string }) => { asked.push(request.kind); return { kind: "permission", decision: "allow_once" } },
    completeElicitation: async () => {}, observeSubagent: async () => undefined, associateChild: () => {} } as unknown as TurnBroker)
  const broker: SessionBroker = { ...base,
    ask: async () => { throw new Error("Session ask requires a start binding") },
    admitProviderTurn: async (_input, run) => {
      await leased()
      const turn: TurnRef = { turnId: `provider-${controllers.length + 1}`, assistantMessageId: `provider-${controllers.length + 1}` }
      const controller = new AbortController()
      controllers.push(controller)
      const settled = Promise.resolve().then(async () => {
        try { for await (const routed of run(turnBroker(controller.signal), turn)) events.set(turn.turnId, [...events.get(turn.turnId) ?? [], routed]) }
        finally { release() }
        return controller.signal.aborted ? { state: "cancelled" as const } : { state: "completed" as const }
      })
      return { admitted: true, turn, settled }
    } }
  const userTurn = async (transport: { send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent> }, session: HarnessSession, id: string) => {
    await leased()
    try { for await (const _event of transport.send(session, turnInput(id), turnBroker(new AbortController().signal))) {} }
    finally { release() }
  }
  return { broker, refused, asked, events, controllers, userTurn }
}

const goal = (status: string) => ({ method: "thread/goal/updated", params: { threadId: "thread-1", turnId: null,
  goal: { threadId: "thread-1", objective: "Keep going", status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } })
const started = (id: string) => ({ method: "turn/started", params: { threadId: "thread-1", turn: { id, items: [], status: "inProgress" } } })
const completed = (id: string, status = "completed") => ({ method: "turn/completed", params: { threadId: "thread-1", turn: { id, items: [], status } } })

async function goalSession() {
  const peer = await scriptedTransport()
  const host = hostBroker(peer.liveBroker())
  const session = await peer.transport.start(peer.startInput, host.broker)
  peer.emit(goal("active"))
  return { peer, host, session }
}

test("an approval asked during a goal turn reaches that turn's broker and is answered", async () => {
  const { peer, host } = await goalSession()
  try {
    peer.emit(started("goal-1"))
    await settle()
    peer.request(90, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "goal-1", itemId: "item-1", command: "ls", cwd: peer.root })
    for (let round = 0; round < 50 && !peer.frames.some((frame) => frame.id === 90 && !frame.method); round++) await tick()
    expect(peer.frames.find((frame) => frame.id === 90 && !frame.method)).toMatchObject({ result: { decision: "accept" } })
    expect(host.asked).toEqual(["permission"])
    peer.emit(completed("goal-1"))
  } finally { await peer.close() }
})

test("Stop interrupts a running goal turn, and a steer lands in it", async () => {
  const { peer, host, session } = await goalSession()
  try {
    peer.emit(started("goal-1"))
    await settle()
    expect(await peer.transport.steer.steer(session, { turnId: "provider-1", assistantMessageId: "provider-1" }, turnInput("steer"))).toEqual({ ok: true })
    expect(peer.frames.find((frame) => frame.method === "turn/steer")?.params).toMatchObject({ expectedTurnId: "goal-1", clientUserMessageId: "u-steer" })
    peer.emit({ method: "item/started", params: { threadId: "thread-1", turnId: "goal-1", item: { type: "userMessage", id: "item-steer", clientId: "u-steer", content: [] } } })
    const stopping = peer.transport.cancel(session, { turnId: "provider-1", assistantMessageId: "provider-1" }, { at: Date.now() + 5_000, signal: new AbortController().signal })
    for (let round = 0; round < 50 && !peer.frames.some((frame) => frame.method === "turn/interrupt"); round++) await tick()
    expect(peer.frames.find((frame) => frame.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "goal-1" })
    peer.emit(completed("goal-1", "interrupted"))
    expect(await stopping).toMatchObject({ execution: "terminal" })
    await settle()
    expect(host.events.get("provider-1")?.some((routed) => routed.event.type === "input-incorporated")).toBe(true)
  } finally { await peer.close() }
})

test("a goal continuation that starts as the previous user or goal turn ends is admitted once that turn is released, never refused", async () => {
  const { peer, host, session } = await goalSession()
  try {
    const user = host.userTurn(peer.transport, session, "user-1")
    for (let round = 0; round < 50 && !peer.frames.some((frame) => frame.method === "turn/start"); round++) await tick()
    await tick()
    peer.emit(completed("turn-current"))
    peer.emit(started("goal-1"))
    await user
    await settle()
    peer.emit(completed("goal-1"))
    peer.emit(started("goal-2"))
    await settle()
    peer.emit(completed("goal-2"))
    await settle()
    expect(host.refused).toEqual([])
    expect([...host.events.keys()]).toEqual(["provider-1", "provider-2"])
  } finally { await peer.close() }
})

test("the host cancelling a goal turn through its signal interrupts it in Codex", async () => {
  const { peer, host } = await goalSession()
  try {
    peer.emit(started("goal-1"))
    await settle()
    host.controllers[0]?.abort()
    for (let round = 0; round < 50 && !peer.frames.some((frame) => frame.method === "turn/interrupt"); round++) await tick()
    expect(peer.frames.find((frame) => frame.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "goal-1" })
    peer.emit(completed("goal-1", "interrupted"))
  } finally { await peer.close() }
})
