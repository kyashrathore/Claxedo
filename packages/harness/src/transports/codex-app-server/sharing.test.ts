import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { Clock, RoutedEvent, StartInput, TurnBroker, TurnInput } from "../../contract"
import { agentMessage, subAgentActivity, tokenUsage, turnCompleted, turnStarted } from "./test-support/native-frames"
import { scriptedTransport } from "./test-support/transport"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await tick()
  expect(check()).toBe(true)
}

function manualClock() {
  const timers = new Map<number, { callback: () => void; ms: number }>()
  let next = 0
  const clock: Clock = {
    now: Date.now,
    setTimeout: (callback, ms) => { timers.set(++next, { callback, ms }); return next },
    clearTimeout: (handle) => { timers.delete(handle as number) },
  }
  return { clock, fire: (ms: number) => { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.callback() } } }
}

function turn(id: string): TurnInput {
  return { turnId: id, userMessageId: `u-${id}`, assistantMessageId: `a-${id}`, origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
    prompt: { agent: "codex", assistantMessageId: `a-${id}`, parts: [{ type: "text", text: id }] }, todos: [] } as TurnInput
}

function asking() {
  const asks: unknown[] = []
  const answers: ((answer: unknown) => void)[] = []
  const broker = { signal: new AbortController().signal, observeSubagent: async () => undefined,
    ask: (request: unknown) => { asks.push(request); return new Promise((resolve) => answers.push(resolve)) } } as unknown as TurnBroker
  return { broker, asks, answers }
}

async function collect(stream: AsyncIterable<RoutedEvent>): Promise<RoutedEvent[]> {
  const events: RoutedEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

const text = (events: RoutedEvent[]) => events.flatMap((row) => row.event.type === "text-delta" ? [row.event.delta] : []).join("")

const account = (credentialId: string): StartInput["credentials"] => ({ machineLoginAllowed: false, accountOwner: "fixture-owner", secrets: {}, leaseGeneration: credentialId,
  providers: { openai: { baseUrl: "http://127.0.0.1:47509/v1", placeholder: `placeholder-${credentialId}`, authMode: "api-key", account: { credentialId, providerId: "openai" } } } })

async function shared(options: Parameters<typeof scriptedTransport>[0] = {}, credentials?: StartInput["credentials"]) {
  const peer = await scriptedTransport(options)
  const bDirectory = path.join(peer.root, "b")
  await fs.mkdir(bDirectory)
  const aInput = { ...peer.startInput, ...(credentials ? { credentials } : {}) }
  const aSession = await peer.transport.start(aInput, peer.liveBroker())
  const bSession = await peer.transport.start({ ...aInput, sessionId: "s2", directory: bDirectory }, peer.liveBroker("s2"))
  const turnStarts = () => peer.frames.filter((frame) => frame.method === "turn/start")
  return { peer, b: peer.transport, aSession, bSession, bDirectory, turnStarts, close: () => peer.close() }
}

test("two sessions of one workspace, owner and account share one app-server with their own cwd, approvals, text and usage", async () => {
  const { peer, b, aSession, bSession, bDirectory, turnStarts, close } = await shared()
  const a = asking()
  const other = asking()
  try {
    expect(peer.spawned()).toBe(1)
    expect(peer.frames.filter((frame) => frame.method === "thread/start").map((frame) => frame.params?.cwd)).toEqual([peer.root, bDirectory])
    const aRunning = collect(peer.transport.send(aSession, turn("A"), a.broker))
    const bRunning = collect(b.send(bSession, turn("B"), other.broker))
    await until(() => turnStarts().length === 2)
    peer.request(91, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-current", itemId: "A-command", command: "echo A", cwd: peer.root })
    peer.request(92, "item/commandExecution/requestApproval", { threadId: "thread-2", turnId: "turn-current", itemId: "B-command", command: "echo B", cwd: bDirectory })
    await until(() => a.asks.length === 1 && other.asks.length === 1)
    expect(JSON.stringify(a.asks[0])).toContain("echo A")
    expect(JSON.stringify(other.asks[0])).toContain("echo B")
    other.answers[0]!({ kind: "permission", decision: "deny" })
    await until(() => peer.frames.some((frame) => frame.id === 92 && !frame.method))
    expect(peer.frames.some((frame) => frame.id === 91 && !frame.method)).toBe(false)
    a.answers[0]!({ kind: "permission", decision: "allow_once" })
    await until(() => peer.frames.some((frame) => frame.id === 91 && !frame.method))
    for (const frame of agentMessage("thread-1", "turn-current", "a-text", "ONLY_A")) peer.emit(frame)
    for (const frame of agentMessage("thread-2", "turn-current", "b-text", "ONLY_B")) peer.emit(frame)
    peer.emit(tokenUsage("thread-1", "turn-current", 7, 7))
    peer.emit(tokenUsage("thread-2", "turn-current", 11, 11))
    peer.emit(turnCompleted("thread-1", "turn-current"))
    peer.emit(turnCompleted("thread-2", "turn-current"))
    const [aEvents, bEvents] = await Promise.all([aRunning, bRunning])
    expect(text(aEvents)).toBe("ONLY_A")
    expect(text(bEvents)).toBe("ONLY_B")
    expect(aEvents.filter((row) => row.event.type === "usage")).toHaveLength(1)
    expect(bEvents.filter((row) => row.event.type === "usage")).toHaveLength(1)
    await peer.transport.close(aSession)
    expect(peer.frames.filter((frame) => frame.method === "thread/archive").map((frame) => frame.params)).toEqual([{ threadId: "thread-1" }])
    expect(peer.retired()).toBe(0)
    expect(b.health.runtime(bDirectory, "s2")).toEqual({ status: "ok" })
    await b.close(bSession)
    expect(peer.retired()).toBe(1)
  } finally { await close() }
})

test("one session's turn/start timeout fails only that session while its sibling keeps streaming", async () => {
  const { clock, fire } = manualClock()
  const { peer, b, aSession, bSession, bDirectory, turnStarts, close } = await shared({ holdTurnStart: true, clock })
  try {
    const bRunning = collect(b.send(bSession, turn("B"), asking().broker))
    await until(() => turnStarts().length === 1)
    peer.releaseTurnStart()
    const aRunning = collect(peer.transport.send(aSession, turn("A"), asking().broker))
    await until(() => turnStarts().length === 2)
    fire(60_000)
    await expect(aRunning).rejects.toThrow("Codex turn/start did not answer within 60000ms")
    expect(peer.transport.health.runtime(peer.root, "s1")).toMatchObject({ status: "degraded" })
    for (const frame of agentMessage("thread-2", "turn-current", "b-text", "B_CONTINUES")) peer.emit(frame)
    peer.emit(turnCompleted("thread-2", "turn-current"))
    expect(text(await bRunning)).toBe("B_CONTINUES")
    expect(b.health.runtime(bDirectory, "s2")).toEqual({ status: "ok" })
    expect(peer.retired()).toBe(0)
    await peer.transport.close(aSession)
    expect(peer.frames.filter((frame) => frame.method === "thread/archive").map((frame) => frame.params)).toEqual([{ threadId: "thread-1" }])
  } finally { await close() }
})

test("a stray frame for a thread no session owns is dropped with a diagnostic after 10 s and fails nothing", async () => {
  const { clock, fire } = manualClock()
  const { peer, b, aSession, bSession, bDirectory, close } = await shared({ clock })
  try {
    for (const frame of agentMessage("orphan-thread", "orphan-turn", "orphan-item", "UNOWNED")) peer.emit(frame)
    peer.request(95, "item/commandExecution/requestApproval", { threadId: "orphan-thread", turnId: "orphan-turn", itemId: "orphan", command: "echo orphan", cwd: peer.root })
    await tick()
    fire(10_000)
    await until(() => peer.frames.some((frame) => frame.id === 95 && !frame.method))
    expect(peer.frames.find((frame) => frame.id === 95 && !frame.method)?.error).toMatchObject({ code: -32000 })
    expect(peer.warnings.filter((row) => row.message.includes("unrecognized frame"))).toHaveLength(3)
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
    expect(b.health.runtime(bDirectory, "s2")).toEqual({ status: "ok" })
    expect(peer.retired()).toBe(0)
    expect(peer.transport.health.connection(peer.root, aSession.binding.sessionId).state).toBe("ready")
    expect(b.health.connection(bDirectory, bSession.binding.sessionId).state).toBe("ready")
  } finally { await close() }
})

test("300 frames for unowned threads overflow only themselves while a sibling's turn completes", async () => {
  const { peer, b, bSession, bDirectory, close } = await shared({ completeTurns: false })
  try {
    const bRunning = collect(b.send(bSession, turn("B"), asking().broker))
    await until(() => peer.frames.some((frame) => frame.method === "turn/start"))
    for (let index = 0; index < 300; index++) peer.emit(turnStarted(`stray-${index}`, "stray-turn"))
    for (const frame of agentMessage("thread-2", "turn-current", "b-text", "B_SURVIVES")) peer.emit(frame)
    peer.emit(turnCompleted("thread-2", "turn-current"))
    expect(text(await bRunning)).toBe("B_SURVIVES")
    expect(peer.warnings.filter((row) => JSON.stringify(row.fields).includes("exceeded 256 frames"))).toHaveLength(44)
    expect(b.health.runtime(bDirectory, "s2")).toEqual({ status: "ok" })
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
    expect(peer.retired()).toBe(0)
  } finally { await close() }
})

test("an early child request and frame bind to the session that spawned the child, never to its sibling", async () => {
  const { peer, b, aSession, bSession, turnStarts, close } = await shared()
  const a = asking()
  const other = asking()
  try {
    const aRunning = collect(peer.transport.send(aSession, turn("A"), a.broker))
    const bRunning = collect(b.send(bSession, turn("B"), other.broker))
    await until(() => turnStarts().length === 2)
    peer.emit(turnStarted("child-A", "child-turn"))
    peer.request(94, "item/commandExecution/requestApproval", { threadId: "child-A", turnId: "child-turn", itemId: "child-command", command: "echo child", cwd: peer.root })
    peer.emit(subAgentActivity("item/started", "thread-1", "turn-current", { id: "spawn-A", kind: "started", agentThreadId: "child-A", agentPath: "/root/A" }))
    await until(() => a.asks.length === 1)
    expect(a.asks[0]).toMatchObject({ child: { correlationKey: "child-A" } })
    expect(other.asks).toHaveLength(0)
    a.answers[0]!({ kind: "permission", decision: "allow_once" })
    peer.emit(turnCompleted("child-A", "child-turn"))
    peer.emit(turnCompleted("thread-1", "turn-current"))
    peer.emit(turnCompleted("thread-2", "turn-current"))
    const [aEvents, bEvents] = await Promise.all([aRunning, bRunning])
    expect(aEvents.some((row) => row.route?.kind === "child")).toBe(true)
    expect(bEvents.filter((row) => row.route?.kind === "child")).toHaveLength(0)
  } finally { await close() }
})

test("an account change moves only that session to a new app-server while its sibling's turn completes on the shared one", async () => {
  const { peer, b, aSession, bSession, turnStarts, close } = await shared({ holdTurnStart: true }, account("account-one"))
  try {
    expect(peer.spawned()).toBe(1)
    const bRunning = collect(b.send(bSession, turn("B"), asking().broker))
    await until(() => turnStarts().length === 1)
    peer.releaseTurnStart()
    expect(await peer.transport.configure(aSession, { credentials: account("account-two") })).toEqual({ state: "applied" })
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.filter((frame) => frame.method === "thread/archive").map((frame) => frame.params)).toEqual([{ threadId: "thread-1" }])
    expect(peer.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-1" })
    for (const frame of agentMessage("thread-2", "turn-current", "b-text", "B_STAYS")) peer.emit(frame, 0)
    peer.emit(turnCompleted("thread-2", "turn-current"), 0)
    expect(text(await bRunning)).toBe("B_STAYS")
    expect(peer.retired()).toBe(0)
    expect(peer.logins()).toEqual(["placeholder-account-one", "placeholder-account-two"])
  } finally { await close() }
})

test("a process exit fails every session on it, and each resumes its own thread on a new shared app-server", async () => {
  const { peer, b, aSession, bSession, bDirectory, close } = await shared({ completeTurns: true })
  try {
    peer.exitLatest()
    await until(() => b.health.runtime(bDirectory, "s2").status === "degraded")
    expect(peer.transport.health.runtime(peer.root, "s1")).toMatchObject({ status: "degraded" })
    await collect(peer.transport.send(aSession, turn("A"), asking().broker))
    await collect(b.send(bSession, turn("B"), asking().broker))
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.filter((frame) => frame.method === "thread/resume").map((frame) => frame.params?.threadId)).toEqual(["thread-1", "thread-2"])
  } finally { await close() }
})

test("a move whose thread release fails leaves the session lost, and its next turn resumes on the new app-server", async () => {
  const { peer, aSession, close } = await shared({ completeTurns: true, archiveFailures: 1 }, account("account-one"))
  try {
    await expect(peer.transport.configure(aSession, { credentials: account("account-two") })).rejects.toThrow("archive refused")
    await collect(peer.transport.send(aSession, turn("A"), asking().broker))
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-1" })
    expect(peer.logins()).toEqual(["placeholder-account-one", "placeholder-account-two"])
  } finally { await close() }
})
