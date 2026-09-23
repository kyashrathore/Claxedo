import { expect, test } from "bun:test"
import type { AnyMessage } from "@agentclientprotocol/sdk"
import { createACPConnectionObservations } from "./connection-state"
import { AcpHarnessAdapter } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import { runtimeWorkspaceDirectory } from "../../test-utils/workspace-directory"

const WORK = runtimeWorkspaceDirectory("work")

test("observations fence old generations, isolate directories, and never promote discovery readiness", () => {
  const observations = createACPConnectionObservations()
  expect(observations.read(WORK)).toEqual({ state: "configured", processes: [] })
  observations.begin("probe", WORK, "discovery")({ state: "ready" })
  expect(observations.read(WORK).state).toBe("configured")
  const old = observations.begin("main", WORK, "execution")
  old({ state: "ready" })
  const oldGeneration = observations.read(WORK, "main").processes[0].generation
  const current = observations.begin("main", WORK, "execution")
  old({ state: "disconnected" })
  expect(observations.read(WORK, "main").state).toBe("connecting")
  expect(observations.read(WORK, "main").processes[0].generation).not.toBe(oldGeneration)
  current({ state: "ready" })
  observations.begin("sibling", WORK, "execution")({ state: "failed", reason: "initialization_failed" })
  expect(observations.read(WORK).state).toBe("ready")
  expect(observations.read("/other").state).toBe("configured")
  observations.associate("main", "/other")
  expect(observations.read("/other").state).toBe("ready")
  current({ state: "disconnected", reason: "disposed" })
  expect(observations.read(WORK, "main").state).toBe("configured")
  current({ state: "ready" })
  expect(observations.read(WORK, "main").state).toBe("configured")
})

class ObservedAdapter extends AcpHarnessAdapter {
  shared(key: string, directory: string) { return this.getOrSpawnProcessForKey(key, directory) }
}

function fixture(options: { authRequired?: boolean; launchFailure?: boolean; initFailure?: boolean } = {}) {
  let launches = 0
  let initialize!: () => void
  let disconnect!: () => void
  const adapter = new ObservedAdapter({
    harness: "test-observed", connection: { kind: "process", command: "fixture" }, store: new MemoryRuntimeStore(),
    createTransport() {
      launches++
      if (options.launchFailure) throw new Error("Cannot spawn fixture")
      let send!: (message: AnyMessage) => void
      const readable = new ReadableStream<AnyMessage>({ start(controller) {
        send = (message) => controller.enqueue(message)
        disconnect = () => controller.close()
      } })
      return { kind: "stdio", metadata: {}, alive: true, dispose() {}, stream: { readable, writable: new WritableStream<AnyMessage>({ write(message) {
        if (!("method" in message) || !("id" in message)) return
        if (message.method === "initialize") initialize = () => send(options.initFailure
          ? { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "initialize failed" } }
          : { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
        if (message.method === "session/new") send(options.authRequired
          ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } }
          : { jsonrpc: "2.0", id: message.id, result: { sessionId: "upstream" } })
      } }) } }
    },
  })
  return { adapter, launches: () => launches, initialize: () => initialize(), hasInitialize: () => !!initialize, disconnect: () => disconnect() }
}

async function handshake(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 30 && !f.hasInitialize(); i++) await new Promise(resolve => setTimeout(resolve, 1))
  expect(f.hasInitialize()).toBe(true)
  f.initialize()
}

test("read-only adapter state observes real wire handshake, auth, loss and retirement without probe sessions", async () => {
  for (const authRequired of [false, true]) {
    const f = fixture({ authRequired })
    try {
      expect(f.adapter.readConnectionState(WORK).state).toBe("configured")
      expect(f.launches()).toBe(0)
      const session = f.adapter.createSession(WORK, undefined, "local").catch(error => error)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(f.adapter.readConnectionState(WORK).state).toBe("connecting")
      await handshake(f)
      const result = await session
      expect(result instanceof Error).toBe(authRequired)
      expect(f.adapter.readConnectionState(WORK).state).toBe(authRequired ? "auth-required" : "ready")
      expect(f.launches()).toBe(1)
      if (!authRequired) {
        expect(f.adapter.readConnectionState(WORK, { sessionId: "local" }).state).toBe("ready")
        expect(f.adapter.readConnectionState(WORK, { sessionId: "unknown" })).toEqual({ state: "configured", processes: [] })
        f.disconnect()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(f.adapter.readConnectionState(WORK).state).toBe("disconnected")
      }
    } finally { f.adapter.dispose() }
  }
  const f = fixture()
  try {
    const session = f.adapter.createSession(WORK, undefined, "local")
    await handshake(f)
    await session
    f.adapter.dispose()
    expect(f.adapter.readConnectionState(WORK).state).toBe("configured")
    expect(f.adapter.readConnectionState(WORK).processes[0]?.state).toBe("disconnected")
  } finally { f.adapter.dispose() }
})

test("launch and initialization failures remain observed failures", async () => {
  for (const options of [{ launchFailure: true }, { initFailure: true }]) {
    const f = fixture(options)
    try {
      const creation = f.adapter.createSession(WORK, undefined, "local").catch(error => error)
      if (!options.launchFailure) await handshake(f)
      expect(await creation).toBeInstanceOf(Error)
      expect(f.adapter.readConnectionState(WORK).state).toBe("failed")
    } finally { f.adapter.dispose() }
  }
})


test("handshake timeout reports a failed generation", async () => {
  const previous = process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS
  process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS = "10"
  const f = fixture()
  try {
    await expect(f.adapter.createSession(WORK, undefined, "local")).rejects.toThrow("timed out")
    expect(f.adapter.readConnectionState(WORK)).toMatchObject({ state: "failed", processes: [{ reason: "initialize_timeout" }] })
  } finally {
    f.adapter.dispose()
    if (previous === undefined) delete process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS
    else process.env.CLAXEDO_ACP_INITIALIZE_TIMEOUT_MS = previous
  }
})


test("one reused process is observed in each directory it actually serves", async () => {
  const f = fixture()
  try {
    const first = f.adapter.shared("shared-owner", "/first")
    await handshake(f)
    const one = await first
    const two = await f.adapter.shared("shared-owner", "/second")
    expect(two.proc).toBe(one.proc)
    expect(f.launches()).toBe(1)
    expect(f.adapter.readConnectionState("/first").state).toBe("ready")
    expect(f.adapter.readConnectionState("/second").state).toBe("ready")
    expect(f.adapter.readConnectionState("/first").processes[0]?.generation).toBe(f.adapter.readConnectionState("/second").processes[0]?.generation)
  } finally { f.adapter.dispose() }
})
