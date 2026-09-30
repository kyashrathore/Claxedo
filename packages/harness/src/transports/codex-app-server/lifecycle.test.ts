import { expect, test } from "bun:test"
import type { Clock, TurnBroker, TurnInput, TurnRequest } from "../../contract"
import { scriptedTransport } from "./test-support/transport"

const turnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin: { actor: { kind: "person", userId: "owner" }, via: "relay", reissued: false },
  prompt: { agent: "codex", assistantMessageId: "a1", parts: [{ type: "text", text: "Reply" }] }, todos: [] } as TurnInput
const turnBroker = () => ({ signal: new AbortController().signal } as TurnBroker)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function drain(stream: AsyncIterable<unknown>) { for await (const _event of stream) {} }

test("a Codex app-server lost between turns reads disconnected and degraded, and the next turn resumes its thread in the same home", async () => {
  const peer = await scriptedTransport({ completeTurns: true })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    peer.exitLatest()
    await tick()
    expect(peer.transport.health.connection(peer.root, "s1").state).toBe("disconnected")
    expect(peer.transport.health.runtime(peer.root, "s1")).toMatchObject({ status: "degraded", reason: "harness_process_lost" })
    await drain(peer.transport.send(session, turnInput, turnBroker()))
    expect(peer.spawned()).toBe(2)
    expect(peer.environments[1]?.CODEX_HOME).toBe(peer.environments[0]?.CODEX_HOME)
    expect(peer.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-1", excludeTurns: true })
    expect(peer.transport.health.connection(peer.root, "s1").state).toBe("ready")
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
  } finally { await peer.close() }
})

test("a failed model/list is read again on the next request instead of failing every later one", async () => {
  const peer = await scriptedTransport({ modelListFailures: 1 })
  try {
    await peer.transport.start(peer.startInput, peer.liveBroker())
    await expect(peer.transport.capabilities({ sessionId: "s1", directory: peer.root })).rejects.toThrow("model catalog unavailable")
    const capabilities = await peer.transport.capabilities({ sessionId: "s1", directory: peer.root })
    expect(capabilities.modelSelection).toMatchObject({ status: "required", models: [{ modelId: "test-model" }] })
  } finally { await peer.close() }
})

test("a Codex exit reports its exit status and the tail of what it wrote to stderr", async () => {
  const peer = await scriptedTransport()
  try {
    await peer.transport.start(peer.startInput, peer.liveBroker())
    peer.stderr.write("\x1b[31mError\x1b[0m: loading config.toml: invalid type\n")
    await tick()
    peer.exitLatest()
    await tick()
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "degraded", reason: "harness_process_lost",
      message: "Codex app-server exited with code 1: Error: loading config.toml: invalid type" })
  } finally { await peer.close() }
})

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

test("a turn/start that never answers retires the app-server so no orphan turn runs, and the next turn resumes on a new one", async () => {
  const { clock, fire } = manualClock()
  const peer = await scriptedTransport({ holdTurnStart: true, clock })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = drain(peer.transport.send(session, turnInput, turnBroker()))
    await peer.started
    fire(60_000)
    await expect(running).rejects.toThrow("Codex turn/start did not answer within 60000ms")
    expect(peer.retired()).toBe(1)
    expect(peer.transport.health.runtime(peer.root, "s1")).toMatchObject({ status: "degraded", message: "Codex turn/start did not answer within 60000ms" })
    const second = drain(peer.transport.send(session, turnInput, turnBroker()))
    for (let attempt = 0; attempt < 50 && peer.frames.filter((frame) => frame.method === "turn/start").length < 2; attempt++) await tick()
    peer.releaseTurnStart()
    await tick()
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await second
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.filter((frame) => frame.method === "thread/resume")).toHaveLength(1)
  } finally { await peer.close() }
})

const brokered = (placeholder: string) => ({ machineLoginAllowed: false, accountOwner: "fixture-owner", secrets: {}, leaseGeneration: placeholder,
  providers: { openai: { baseUrl: "http://127.0.0.1:47509/v1", placeholder, authMode: "api-key" as const } } })

test("a credential change during a turn is deferred to that turn's end, then applied by resuming the thread on a new app-server", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true })
  try {
    const session = await peer.transport.start({ ...peer.startInput, credentials: brokered("placeholder-one") }, peer.liveBroker())
    const running = drain(peer.transport.send(session, turnInput, turnBroker()))
    await peer.started
    expect(await peer.transport.configure(session, { credentials: brokered("placeholder-two") })).toEqual({ state: "deferred", until: "after-active-turns" })
    expect(peer.spawned()).toBe(1)
    peer.releaseTurnStart()
    await tick()
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await running
    for (let attempt = 0; attempt < 50 && !peer.frames.some((frame) => frame.method === "thread/resume"); attempt++) await tick()
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-1" })
    expect(await Bun.file(`${peer.environments[1]?.CODEX_HOME}/config.toml`).text()).toContain("placeholder-two")
    expect(await peer.transport.configure(session, { credentials: brokered("placeholder-two") })).toEqual({ state: "applied" })
    expect(peer.spawned()).toBe(2)
  } finally { await peer.close() }
})

test("an owner's credential change that leaves the Codex account as it was keeps the idle app-server running", async () => {
  const peer = await scriptedTransport()
  try {
    const credentials = brokered("placeholder-one")
    const session = await peer.transport.start({ ...peer.startInput, credentials }, peer.liveBroker())
    const other = { ...credentials, leaseGeneration: "lease-2", providers: { ...credentials.providers,
      anthropic: { baseUrl: "http://127.0.0.1:47510", placeholder: "claude-placeholder", authMode: "api-key" as const } } }
    expect(await peer.transport.configure(session, { credentials: other })).toEqual({ state: "applied" })
    expect(peer.spawned()).toBe(1)
    expect(peer.retired()).toBe(0)
  } finally { await peer.close() }
})

test("a request Codex resolves itself closes its open prompt and gets no late answer", async () => {
  const peer = await scriptedTransport()
  let asked!: (signal: AbortSignal | undefined) => void
  const asking = new Promise<AbortSignal | undefined>((resolve) => { asked = resolve })
  const broker = { signal: new AbortController().signal, ask: (_request: unknown, options?: { signal?: AbortSignal }) => {
    asked(options?.signal)
    return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve({ kind: "cancelled" }), { once: true }))
  } } as unknown as TurnBroker
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = drain(peer.transport.send(session, turnInput, broker))
    await peer.started
    peer.request(91, "item/commandExecution/requestApproval", { threadId: "thread-1", turnId: "turn-current", itemId: "item-1", command: "ls", cwd: peer.root })
    const signal = await asking
    peer.emit({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 91 } })
    await tick()
    expect(signal?.aborted).toBe(true)
    await tick()
    expect(peer.frames.some((frame) => frame.id === 91 && !frame.method)).toBe(false)
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await running
  } finally { await peer.close() }
})

test("an approval a spawn_agent child asks names that child's thread as its route, and the parent's own approval names none", async () => {
  const peer = await scriptedTransport()
  const asked: TurnRequest[] = []
  const broker = { signal: new AbortController().signal, origin: turnInput.origin,
    ask: async (request: TurnRequest) => { asked.push(request); return { kind: "permission", decision: "allow_once" } },
    observeSubagent: async () => ({ sessionId: "child-session", assistantMessageId: "child-a1", created: 1 }),
    associateChild: () => {}, completeElicitation: async () => {} } as unknown as TurnBroker
  const approval = (id: number, threadId: string) => peer.request(id, "item/commandExecution/requestApproval",
    { threadId, turnId: `${threadId}-turn`, itemId: `item-${id}`, command: "ls", cwd: peer.root })
  const replied = async (id: number) => { while (!peer.frames.some((frame) => frame.id === id && !frame.method)) await tick() }
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = drain(peer.transport.send(session, turnInput, broker))
    await peer.started
    peer.request(90, "item/tool/call", { threadId: "thread-1", turnId: "turn-current", callId: "call-1", tool: "spawn_agent",
      arguments: { task_name: "review", message: "Inspect" } })
    while (!peer.frames.some((frame) => frame.method === "turn/start" && frame.params?.threadId === "thread-2")) await tick()
    approval(91, "thread-2")
    await replied(91)
    approval(92, "thread-1")
    await replied(92)
    expect(asked.map((request) => request.child)).toEqual([{ correlationKey: "thread-2" }, undefined])
    peer.emit({ method: "turn/completed", params: { threadId: "thread-2", turn: { id: "turn-current", status: "completed" } } })
    await replied(90)
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await running
  } finally { await peer.close() }
})
