import { expect, test } from "bun:test"
import type { Clock, TurnBroker, TurnInput } from "../../contract"
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

test.each(["thread not found: thread-1", "Thread not found: thread-1", "401 Unauthorized", "turn interrupted"])("turn/start surfaces %s without resume or retry", async (message) => {
  const peer = await scriptedTransport({ turnStartError: message, completeTurns: true })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    await expect(drain(peer.transport.send(session, turnInput, turnBroker()))).rejects.toMatchObject({ transport: "codex", code: "protocol", message })
    expect(peer.frames.filter((frame) => frame.method === "turn/start")).toHaveLength(1)
    expect(peer.frames.filter((frame) => frame.method === "thread/resume")).toHaveLength(0)
    expect(peer.spawned()).toBe(1)
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

test("a turn/start that never answers fails only its session, interrupts the turn once Codex starts it, and the next turn resumes on the same app-server", async () => {
  const { clock, fire } = manualClock()
  const peer = await scriptedTransport({ holdTurnStart: true, clock, idleMs: 30_000 })
  try {
    const session = await peer.transport.start(peer.startInput, peer.liveBroker())
    const running = drain(peer.transport.send(session, turnInput, turnBroker()))
    await peer.started
    fire(60_000)
    await expect(running).rejects.toThrow("Codex turn/start did not answer within 60000ms")
    expect(peer.retired()).toBe(0)
    expect(peer.transport.health.runtime(peer.root, "s1")).toMatchObject({ status: "degraded", message: "Codex turn/start did not answer within 60000ms" })
    peer.releaseTurnStart()
    for (let attempt = 0; attempt < 50 && !peer.frames.some((frame) => frame.method === "turn/interrupt"); attempt++) await tick()
    expect(peer.frames.find((frame) => frame.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "turn-current" })
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "interrupted" } } })
    const second = drain(peer.transport.send(session, turnInput, turnBroker()))
    for (let attempt = 0; attempt < 50 && peer.frames.filter((frame) => frame.method === "turn/start").length < 2; attempt++) await tick()
    peer.releaseTurnStart()
    await tick()
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await second
    expect(peer.spawned()).toBe(1)
    expect(peer.frames.filter((frame) => frame.method?.startsWith("thread/") && frame.method !== "thread/start").map((frame) => frame.method))
      .toEqual(["thread/archive", "thread/resume", "thread/unarchive", "thread/resume", "thread/goal/get"])
    expect(peer.transport.health.runtime(peer.root, "s1")).toEqual({ status: "ok" })
  } finally { await peer.close() }
})

const brokered = (placeholder: string, credentialId = "account-one") => ({ machineLoginAllowed: false, accountOwner: "fixture-owner", secrets: {}, leaseGeneration: placeholder,
  providers: { openai: { baseUrl: "http://127.0.0.1:47509/v1", placeholder, authMode: "api-key" as const, account: { credentialId, providerId: "openai" } } } })

test("an account change during a turn is deferred to that turn's end, then moves the session's thread to a new app-server", async () => {
  const peer = await scriptedTransport({ holdTurnStart: true })
  try {
    const session = await peer.transport.start({ ...peer.startInput, credentials: brokered("placeholder-one") }, peer.liveBroker())
    const running = drain(peer.transport.send(session, turnInput, turnBroker()))
    await peer.started
    expect(await peer.transport.configure(session, { credentials: brokered("placeholder-two", "account-two") })).toEqual({ state: "deferred", until: "after-active-turns" })
    expect(peer.spawned()).toBe(1)
    peer.releaseTurnStart()
    await tick()
    peer.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-current", status: "completed" } } })
    await running
    for (let attempt = 0; attempt < 50 && !peer.frames.some((frame) => frame.method === "thread/resume"); attempt++) await tick()
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.filter((frame) => frame.method === "thread/archive").map((frame) => frame.params)).toEqual([{ threadId: "thread-1" }])
    expect(peer.frames.find((frame) => frame.method === "thread/resume")?.params).toMatchObject({ threadId: "thread-1" })
    expect(await peer.transport.configure(session, { credentials: brokered("placeholder-two", "account-two") })).toEqual({ state: "applied" })
    expect(peer.spawned()).toBe(2)
  } finally { await peer.close() }
})

test("a placeholder rotation of the same account keeps the app-server and logs the new key in before the next turn", async () => {
  const peer = await scriptedTransport({ completeTurns: true })
  try {
    const session = await peer.transport.start({ ...peer.startInput, credentials: brokered("placeholder-one") }, peer.liveBroker())
    await drain(peer.transport.send(session, turnInput, turnBroker()))
    expect(await peer.transport.configure(session, { credentials: brokered("placeholder-two") })).toEqual({ state: "applied" })
    await drain(peer.transport.send(session, turnInput, turnBroker()))
    expect(peer.spawned()).toBe(1)
    expect(peer.logins()).toEqual(["placeholder-one", "placeholder-two"])
    expect(await Bun.file(`${peer.environments[0]?.CODEX_HOME}/config.toml`).text()).not.toContain("placeholder")
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

test("an account change preserves Codex background terminals and moves the session only after they finish", async () => {
  const backgroundTerminals = ["running-job"]
  const peer = await scriptedTransport({ backgroundTerminals, completeTurns: true })
  try {
    const session = await peer.transport.start({ ...peer.startInput, credentials: brokered("placeholder-one") }, peer.liveBroker())
    await expect(peer.transport.configure(session, { credentials: brokered("placeholder-two", "account-two") })).rejects.toThrow("background tasks are running")
    await expect(drain(peer.transport.send(session, turnInput, turnBroker()))).rejects.toThrow("background tasks are running")
    expect(peer.spawned()).toBe(1)
    expect(peer.retired()).toBe(0)
    expect(peer.frames.some((frame) => frame.method === "thread/backgroundTerminals/terminate")).toBe(false)
    backgroundTerminals.splice(0)
    await drain(peer.transport.send(session, turnInput, turnBroker()))
    expect(peer.spawned()).toBe(2)
    expect(peer.frames.filter((frame) => frame.method === "thread/resume")).toHaveLength(1)
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
