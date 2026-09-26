import { expect, test } from "bun:test"
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, SessionBroker, StartInput, TurnBroker, TurnInput } from "../../contract"
import { ClaudeSdkTransport } from "./index"
import type { ClaudeQueryLauncher } from "./query-options"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/work", locality: "local",
  owner: { kind: "machine-owner" }, config: { harness: { id: "claude", access: "native" } },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" } }
const origin = { actor: input.owner, via: "loopback" as const, reissued: false }
const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, todos: [],
  prompt: { agent: "claude", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }] } }
const services = { log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices

function transport(messages: AsyncIterable<SDKMessage>) {
  const value = new ClaudeSdkTransport(services, { executable: "claude", configRoot: "/tmp/claude-test", userConfigRoot: "/tmp/claude-user", env: {} })
  const launcher = { launch: async () => ({ [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close() {} } as Query) } as unknown as ClaudeQueryLauncher
  Object.assign(value, { launcher })
  return value
}

test("a reconstructed binding attaches to the same Claude session without object identity", async () => {
  const value = new ClaudeSdkTransport({} as HarnessServices, { executable: "claude", configRoot: "/tmp/claxedo-claude",
    userConfigRoot: "/tmp/person-claude", env: {} })
  const session = await value.start(input, { rebind: async () => {} } as unknown as SessionBroker)
  const reconstructed = JSON.parse(JSON.stringify(session)) as typeof session
  expect(await value.config.read(reconstructed)).toEqual(input.config)
  await expect(value.config.read({ ...reconstructed, binding: { ...reconstructed.binding, workspaceId: "other" } }))
    .rejects.toMatchObject({ transport: "claude", code: "session" })
  await value.close(session)
})

test("a Claude transport turn fails when the SDK stream ends without a result", async () => {
  const value = transport({ async *[Symbol.asyncIterator]() {} })
  const session = await value.start(input, { rebind: async () => {} } as unknown as SessionBroker)
  const signal = new AbortController().signal
  const broker = { signal } as TurnBroker
  await expect((async () => { for await (const _event of value.send(session, turn, broker)) {} })())
    .rejects.toThrow("result")
  await value.dispose()
})

test("a Claude transport turn removes its broker abort listener on settlement", async () => {
  const value = transport({ async *[Symbol.asyncIterator]() {
    yield { type: "result", subtype: "success", is_error: false, session_id: "up1", uuid: "r1" } as unknown as SDKMessage
  } })
  const session = await value.start(input, { rebind: async () => {} } as unknown as SessionBroker)
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

test("goal cancellation reports unknown when admission settles failed", async () => {
  const value = transport({ async *[Symbol.asyncIterator]() {} })
  const session = await value.start(input, { rebind: async () => {} } as unknown as SessionBroker)
  Object.assign(value, { goalRuntime: { turnId: () => "t1", cancel: async () => ({ state: "failed", error: "retirement failed" }) } })
  expect(await value.cancel(session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 1000, signal: new AbortController().signal }))
    .toMatchObject({ execution: "unknown", cleanup: "unknown", error: { message: "retirement failed" } })
})
