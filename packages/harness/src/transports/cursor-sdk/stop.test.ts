import { expect, test } from "bun:test"
import type { HarnessServices, HarnessSession, StartInput, TurnBroker, TurnInput } from "../../contract"
import type { CursorHost } from "./host-registry"
import { CursorSdkTransport } from "./index"

const origin = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const turn: TurnInput = { turnId: "t1", userMessageId: "u1", assistantMessageId: "a1", origin, todos: [],
  prompt: { agent: "build", assistantMessageId: "a1", parts: [{ type: "text", text: "hello" }] } }

function fixture() {
  const acquiring = Promise.withResolvers<void>()
  const acquired = Promise.withResolvers<void>()
  const commands: string[] = []
  const host = { failed: false, call: async (command: { kind: string }) => {
    commands.push(command.kind)
    return { id: 1, kind: "result", value: { status: "cancelled" } }
  } } as unknown as CursorHost
  const registry = {
    acquire: async () => { acquiring.resolve(); await acquired.promise; return host },
    release: async () => {},
    existing: () => undefined,
  }
  const transport = new CursorSdkTransport({ log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices,
    { homeRoot: "/tmp", ownerCursorDir: "/tmp/owner-cursor", worker: { file: process.execPath, args: ["cursor-worker.js"] }, env: {}, placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: false })
  const session = { binding: { sessionId: "s1", upstreamSessionId: "agent" }, directory: "/work" } as HarnessSession
  const entry = { session, input: { directory: "/work", config: {}, credentials: { leaseGeneration: "g1", providers: {}, machineLoginAllowed: false }, owner: { kind: "machine-owner" },
    projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] } } as unknown as StartInput,
    credential: { key: "key", apiKey: "test", bound: false, ownerLogin: false },
    host: { binding: "key", home: "/tmp" }, process: { failed: true } as CursorHost, plugins: {}, busy: false, reopen: false }
  const internals = transport as unknown as { entries: Map<string, typeof entry>; registry: typeof registry }
  internals.entries.set("s1", entry)
  internals.registry = registry
  return { transport, session, acquiring, acquired, commands }
}

test("a stop during Cursor turn startup aborts it before launch and says nothing ran", async () => {
  const f = fixture()
  const stream = f.transport.send(f.session, turn, { signal: new AbortController().signal } as TurnBroker)[Symbol.asyncIterator]()
  const first = stream.next()
  await f.acquiring.promise
  expect(await f.transport.cancel(f.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 1_000, signal: new AbortController().signal }))
    .toEqual({ execution: "terminal", cleanup: "verified_clear" })
  f.acquired.resolve()
  expect(await first).toEqual({ done: true, value: undefined })
  expect(f.commands).toEqual([])
})

test("an aborted Cursor turn signal ends the stream cleanly instead of throwing", async () => {
  const f = fixture()
  f.acquired.resolve()
  const controller = new AbortController()
  controller.abort()
  const events = []
  for await (const event of f.transport.send(f.session, turn, { signal: controller.signal } as TurnBroker)) events.push(event)
  expect(events).toEqual([])
  expect(f.commands).toEqual([])
})

function busyFixture(running: Promise<void>) {
  const f = fixture()
  const commands: string[] = []
  const host = { call: async (command: { kind: string }) => { commands.push(command.kind); return { id: 1, kind: "result" } } } as unknown as CursorHost
  const internals = f.transport as unknown as { entries: Map<string, { busy: boolean; running?: Promise<void> }>; registry: { existing: () => CursorHost } }
  Object.assign(internals.entries.get("s1")!, { busy: true, running })
  internals.registry.existing = () => host
  return { ...f, commands }
}

test("a stop reports the Cursor run terminal once the run it cancelled has ended", async () => {
  const ended = Promise.withResolvers<void>()
  const f = busyFixture(ended.promise)
  const outcome = f.transport.cancel(f.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 1_000, signal: new AbortController().signal })
  ended.resolve()
  expect(await outcome).toEqual({ execution: "terminal", cleanup: "unknown" })
  expect(f.commands).toEqual(["cancel"])
})

test("a Cursor run still going at the stop deadline is reported unknown, with the timeout named", async () => {
  const f = busyFixture(new Promise<void>(() => {}))
  expect(await f.transport.cancel(f.session, { turnId: "t1", assistantMessageId: "a1" }, { at: Date.now() + 20, signal: new AbortController().signal }))
    .toMatchObject({ execution: "unknown", cleanup: "unknown", error: { code: "cancellation_timeout" } })
})
