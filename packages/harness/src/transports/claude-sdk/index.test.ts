import { expect, test } from "bun:test"
import type { query, Query, SDKMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, SessionBroker, StartInput, TurnBroker, TurnInput } from "../../contract"
import { ClaudeSdkTransport } from "./index"
import { ClaudeQueryLauncher } from "./query-options"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" } },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }
const origin = { actor: input.owner, via: "loopback" as const, reissued: false }
const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, todos: [],
  prompt: { agent: "claude", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }] } }
const services = { log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices
const runtimeConfig = { current: { ...input.config, instructions: "keep me", permissionMode: "plan" } }
const sessionBroker = { rebind: async (upstreamSessionId: string) => Object.freeze({ sessionId: "s1", workspaceId: "w1", directory: "/work",
  connectionId: "claude-sdk", upstreamSessionId }), config: () => runtimeConfig.current } as unknown as SessionBroker

function transport(messages: AsyncIterable<SDKMessage>, specs: Parameters<ClaudeQueryLauncher["launch"]>[0][] = []) {
  const value = new ClaudeSdkTransport(services, { executable: "claude", configRoot: "/tmp/claude-test", userConfigRoot: "/tmp/claude-user", env: {} })
  const launcher = { launch: async (spec: Parameters<ClaudeQueryLauncher["launch"]>[0]) => {
    specs.push(spec)
    return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close() {} } as Query
  } } as unknown as ClaudeQueryLauncher
  Object.assign(value, { launcher })
  return value
}

test("a reconstructed binding attaches to the same Claude session without object identity", async () => {
  const value = new ClaudeSdkTransport({} as HarnessServices, { executable: "claude", configRoot: "/tmp/claxedo-claude",
    userConfigRoot: "/tmp/person-claude", env: {} })
  const session = await value.start(input, sessionBroker)
  const reconstructed = JSON.parse(JSON.stringify(session)) as typeof session
  expect(await value.config.read(reconstructed)).toEqual(runtimeConfig.current)
  await expect(value.config.read({ ...reconstructed, binding: { ...reconstructed.binding, workspaceId: "other" } }))
    .rejects.toMatchObject({ transport: "claude", code: "session" })
  await value.close(session)
})

test("a Claude transport turn fails when the SDK stream ends without a result", async () => {
  const value = transport({ async *[Symbol.asyncIterator]() {} })
  const session = await value.start(input, sessionBroker)
  const signal = new AbortController().signal
  const broker = { signal } as TurnBroker
  await expect((async () => { for await (const _event of value.send(session, turn, broker)) {} })())
    .rejects.toThrow("result")
  await value.dispose()
})

test("a turn without a resolved model launches Claude's default, not the start model", async () => {
  const specs: Parameters<ClaudeQueryLauncher["launch"]>[0][] = []
  const value = transport({ async *[Symbol.asyncIterator]() {
    yield { type: "result", subtype: "success", is_error: false, session_id: "up1", uuid: "r1" } as unknown as SDKMessage
  } }, specs)
  const session = await value.start({ ...input, model: { providerID: "anthropic", modelID: "claude-opus-5" } }, sessionBroker)
  try { for await (const _event of value.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {} }
  finally { await value.dispose() }
  expect(specs).toHaveLength(1)
  expect(specs[0]).toMatchObject({ model: "default" })
  expect(specs[0]?.turn?.()).toBeUndefined()
  expect(specs[0]?.system).toBeUndefined()
})

test("a Claude transport turn removes its broker abort listener on settlement", async () => {
  const value = transport({ async *[Symbol.asyncIterator]() {
    yield { type: "result", subtype: "success", is_error: false, session_id: "up1", uuid: "r1" } as unknown as SDKMessage
  } })
  const session = await value.start(input, sessionBroker)
  const signal = new AbortController().signal
  let added = 0
  let removed = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((...args: Parameters<typeof signal.addEventListener>) => { added++; return add(...args) }) as typeof signal.addEventListener
  signal.removeEventListener = ((...args: Parameters<typeof signal.removeEventListener>) => { removed++; return remove(...args) }) as typeof signal.removeEventListener
  const broker = { signal } as TurnBroker
  try { for await (const _event of value.send(session, turn, broker)) {} }
  finally { await value.dispose() }
  expect(added).toBeGreaterThan(0)
  expect(removed).toBe(added)
})

test("an unselected Claude draft reports the auto classifier mode", async () => {
  const value = new ClaudeSdkTransport({} as HarnessServices, { executable: "claude", configRoot: "/tmp/claxedo-claude", userConfigRoot: "/tmp/person-claude", env: {} })
  expect((await value.config.permissionModes({ draft: { ...input, config: { harness: input.config.harness } } })).currentModeId).toBe("auto")
})

test("Claude session config has one owner, the runtime, and the transport keeps no copy", async () => {
  const value = new ClaudeSdkTransport({} as HarnessServices, { executable: "claude", configRoot: "/tmp/claxedo-claude", userConfigRoot: "/tmp/person-claude", env: {} })
  const session = await value.start({ ...input, config: { ...input.config, permissionMode: "default" } }, sessionBroker)
  try {
    expect(await value.config.read(session)).toEqual(runtimeConfig.current)
    expect((await value.config.permissionModes({ session })).currentModeId).toBe("plan")
    expect((await value.config.setPermissionMode(session, "acceptEdits")).currentModeId).toBe("acceptEdits")
    expect((await value.config.permissionModes({ session })).currentModeId).toBe("plan")
    await expect(value.config.setPermissionMode(session, "unknown")).rejects.toMatchObject({ code: "configuration" })
    const updated = await value.config.update(session, { model: { providerID: "anthropic", modelID: "haiku" }, permissionMode: null })
    expect(updated).toEqual({ ...runtimeConfig.current, model: { providerID: "anthropic", modelID: "haiku" }, permissionMode: undefined })
    expect(updated.instructions).toBe("keep me")
    await expect(value.config.update(session, { permissionMode: "unknown" })).rejects.toMatchObject({ code: "configuration" })
    expect(await value.config.read(session)).toEqual(runtimeConfig.current)
  } finally { await value.close(session) }
})

test("a stop during Claude turn startup aborts it before launch and says nothing ran", async () => {
  const specs: Parameters<ClaudeQueryLauncher["launch"]>[0][] = []
  const value = transport({ async *[Symbol.asyncIterator]() {} }, specs)
  const session = await value.start(input, sessionBroker)
  try {
    const stream = value.send(session, turn, { signal: new AbortController().signal } as TurnBroker)[Symbol.asyncIterator]()
    const first = stream.next()
    expect(await value.cancel(session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ execution: "terminal", cleanup: "verified_clear" })
    expect(await first).toEqual({ done: true, value: undefined })
    expect(specs).toEqual([])
  } finally { await value.dispose() }
})

test("a stop of a launched Claude turn retires its process and claims no process it still owns", async () => {
  let launched!: () => void
  const running = new Promise<void>((resolve) => { launched = resolve })
  const value = transport({ async *[Symbol.asyncIterator]() {
    launched()
    await new Promise(() => {})
  } })
  const session = await value.start(input, sessionBroker)
  try {
    const stream = value.send(session, turn, { signal: new AbortController().signal } as TurnBroker)[Symbol.asyncIterator]()
    void stream.next()
    await running
    expect(await value.cancel(session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 1_000, signal: new AbortController().signal }))
      .toEqual({ execution: "unknown", cleanup: "unknown" })
  } finally { await value.dispose() }
})

test("an aborted Claude turn signal ends the stream before launch without an error", async () => {
  const specs: Parameters<ClaudeQueryLauncher["launch"]>[0][] = []
  const value = transport({ async *[Symbol.asyncIterator]() {} }, specs)
  const session = await value.start(input, sessionBroker)
  const controller = new AbortController()
  controller.abort()
  try {
    const events = []
    for await (const event of value.send(session, turn, { signal: controller.signal } as TurnBroker)) events.push(event)
    expect(events).toEqual([])
    expect(specs).toEqual([])
  } finally { await value.dispose() }
})

test("subagent usage the SDK mirrors ahead of the stream is metered at the turn's result, after the stream's own usage", async () => {
  const log: [string, number | null][] = []
  const tokens = (usage: unknown) => (usage as { observation: { tokens: { input: number | null } } }).observation.tokens.input
  const options = { executable: "claude", configRoot: "/tmp/claude-test", userConfigRoot: "/tmp/claude-user", env: {} }
  const runQuery = ((call: Parameters<typeof query>[0]) => ({ async *[Symbol.asyncIterator]() {
    const store = call.options?.sessionStore as SessionStore
    await store.append({ projectKey: "p", sessionId: "up1", subpath: "agent-1" },
      [{ type: "assistant", message: { id: "child-request", model: "claude-sonnet-4-5", usage: { input_tokens: 5, output_tokens: 5 } } }])
    yield { type: "stream_event", session_id: "up1", parent_tool_use_id: null, uuid: "e1",
      event: { type: "message_start", message: { id: "main-request", model: "claude-sonnet-4-5", usage: { input_tokens: 1, output_tokens: 1 } } } } as unknown as SDKMessage
    yield { type: "result", subtype: "success", is_error: false, session_id: "up1", uuid: "r1" } as unknown as SDKMessage
  }, close() {} }) as unknown as Query) as typeof query
  const launchServices = { ...services, firstPartyMcp: () => undefined } as unknown as HarnessServices
  const value = new ClaudeSdkTransport(services, options)
  Object.assign(value, { launcher: new ClaudeQueryLauncher(launchServices, options, runQuery) })
  const broker = { ...sessionBroker, sessionId: "s1", goal: { read: () => null, publish: async () => {} }, publish: async () => {},
    meter: (usage: { usage: unknown }) => { log.push(["mirror", tokens(usage.usage)]) } } as unknown as SessionBroker
  const session = await value.start(input, broker)
  try {
    for await (const routed of value.send(session, turn, { signal: new AbortController().signal } as TurnBroker)) {
      if (routed.event.type === "usage") log.push(["stream", tokens(routed.event)])
    }
  } finally { await value.dispose() }
  expect(log).toEqual([["stream", 1], ["mirror", 6], ["stream", 6]])
})
