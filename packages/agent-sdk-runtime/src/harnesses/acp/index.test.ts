import path from "node:path"
import { describe, expect, test } from "bun:test"
import { RequestError } from "@agentclientprotocol/sdk"
import { internalsOf, type WithInternals } from "../../test-utils/class-internals"
import { fakeRuntimeStore } from "../../test-utils/fake-runtime-store"
import { AcpHarnessAdapter, type AcpRuntimeStore, type ACPTransport } from "./index"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"
import { generateAITitle } from "./title"
import type { CompatEvent } from "../../compat-events"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { createRuntimeEventHub, type RuntimeEventEnvelope } from "../../runtime-event-hub"
import type { SessionUpdate } from "./process"
import { MemoryRuntimeStore } from "../../stores/memory"

function adapter() {
  const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
    store: {
      listPermissions: (directory: string) => Array<{ id: string; sessionID: string }>
      appendEvent: (input: unknown) => void
    }
    sessions: Map<string, { proc: { alive: boolean; pendingPermissions: Map<string, unknown>; respondPermission: (id: string, response: unknown) => void } }>
  }>
  item.sessions = new Map()
  Object.assign(item, { permissionOwners: new Map() })
  return item
}

describe("AcpHarnessAdapter permissions", () => {
  test("requires a workspace directory at cwd-dependent boundaries", async () => {
    const item = adapter()
    item.store = {
      listPermissions: () => [],
      appendEvent() {},
    }

    await expect(item.listPermissions(undefined as never)).rejects.toThrow("workspace directory is required")
  })

  test("deny without a reject option cancels instead of selecting an allow option", async () => {
    const replies: unknown[] = []
    const item = adapter()
    item.store = {
      listPermissions() {
        return [{ id: "perm-1", sessionID: "session-1" }]
      },
      appendEvent(input) {
        replies.push(input)
      },
    }
    const selected: unknown[] = []
    item.sessions.set("session-1", {
      proc: {
        alive: true,
        pendingPermissions: new Map([
          ["perm-1", {
            options: [{ kind: "allow_once", optionId: "allow-1" }],
          }],
        ]),
        respondPermission(_id, response) {
          selected.push(response)
        },
      },
    })

    await item.respondPermission("perm-1", "deny", path.resolve("/work"))

    expect(selected).toEqual([{ outcome: { outcome: "cancelled" } }])
    expect(replies).toHaveLength(1)
  })

  test("allow still selects the matching allow option", async () => {
    const item = adapter()
    item.store = {
      listPermissions() {
        return [{ id: "perm-1", sessionID: "session-1" }]
      },
      appendEvent() {},
    }
    const selected: unknown[] = []
    item.sessions.set("session-1", {
      proc: {
        alive: true,
        pendingPermissions: new Map([
          ["perm-1", {
            options: [
              { kind: "reject_once", optionId: "reject-1" },
              { kind: "allow_always", optionId: "allow-session" },
            ],
          }],
        ]),
        respondPermission(_id, response) {
          selected.push(response)
        },
      },
    })

    await item.respondPermission("perm-1", "allow_always", path.resolve("/work"))

    expect(selected).toEqual([{ outcome: { outcome: "selected", optionId: "allow-session" } }])
  })

  test("finds permissions on a live replacement process", async () => {
    const item = adapter()
    const stale: string[] = []
    item.store = {
      listPermissions() {
        return [{ id: "perm-1", sessionID: "session-1" }]
      },
      appendEvent() {},
      stalePermission(id: string) {
        stale.push(id)
      },
      markRecovering() {},
    } as typeof item.store
    item.sessions.set("session-1", {
      proc: {
        alive: true,
        pendingPermissions: new Map(),
        respondPermission() {},
      },
    })
    item.sessions.set("replacement", {
      proc: {
        alive: true,
        pendingPermissions: new Map([["perm-1", { options: [] }]]),
        respondPermission() {},
      },
    })

    await expect(item.listPermissions(path.resolve("/work"))).resolves.toEqual([{ id: "perm-1", sessionID: "session-1" }])
    expect(stale).toEqual([])
  })

  test("responds to permissions owned by a live replacement process", async () => {
    const item = adapter()
    const selected: unknown[] = []
    item.store = {
      listPermissions() {
        return [{ id: "perm-1", sessionID: "session-1" }]
      },
      appendEvent() {},
    }
    item.sessions.set("session-1", {
      proc: {
        alive: true,
        pendingPermissions: new Map(),
        respondPermission() {},
      },
    })
    item.sessions.set("replacement", {
      proc: {
        alive: true,
        pendingPermissions: new Map([
          ["perm-1", {
            options: [{ kind: "allow_always", optionId: "allow-session" }],
          }],
        ]),
        respondPermission(_id, response) {
          selected.push(response)
        },
      },
    })

    await item.respondPermission("perm-1", "allow_always", path.resolve("/work"))

    expect(selected).toEqual([{ outcome: { outcome: "selected", optionId: "allow-session" } }])
  })
})

describe("AcpHarnessAdapter subagent routing", () => {
  test("admits Claude lifecycle before routing nested transcript events to the child", async () => {
    const runtimeEvents: RuntimeEventEnvelope[] = []
    const permissionModes: string[] = []
    const eventHub = createRuntimeEventHub()
    eventHub.subscribeRuntime((event) => runtimeEvents.push(event))
    const store = new MemoryRuntimeStore()
    store.bindSession({
      sessionId: "parent-session",
      directory: path.resolve("/work"),
      title: "Parent",
      agentSessionId: "parent-agent-session",
    })
    store.updateSessionConfig("parent-session", {
      harness: { id: "claude", access: "acp" },
      model: { providerID: "claude-acp", modelID: "default" },
      agent: "build",
      variant: null,
    })
    const adapter = new AcpHarnessAdapter({
      binary: "claude-agent-acp",
      harness: "claude",
      store,
      eventHub,
    })
    internalsOf<{
      getOrSpawnProcess: () => Promise<{ proc: {
        permissionPushers: Map<string, unknown>
        syncSession: () => Promise<void>
        prompt: (_sessionId: string, _input: unknown, forward: (update: SessionUpdate) => void) => Promise<{ stopReason: "end_turn" }>
        cancel: () => Promise<void>
      }; isNew: false }>
    }>(adapter).getOrSpawnProcess = async () => ({
      isNew: false,
      proc: {
        permissionPushers: new Map(),
        async syncSession() {},
        async setPermissionMode(_sessionId: string, modeId: string) {
          permissionModes.push(modeId)
          return { modes: [], currentModeId: modeId, appliesFrom: "next-turn" as const }
        },
        async prompt(_sessionId, _input, forward) {
          forward({
            sessionUpdate: "tool_call",
            toolCallId: "agent-1",
            title: "Agent",
            status: "in_progress",
            rawInput: { description: "Inspect cache" },
            _meta: { claudeCode: { subagent: true } },
          })
          forward({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "child result" },
            _meta: { claudeCode: { parentToolUseId: "agent-1" } },
          })
          return { stopReason: "end_turn" }
        },
        async cancel() {},
      },
    })

    for await (const _event of adapter.sendMessage("parent-session", {
      parts: [{ type: "text", text: "delegate" }],
      userMessageId: "parent-user",
      assistantMessageId: "parent-assistant",
      agent: "build",
      model: { providerID: "claude-acp", modelID: "default" },
      permissionMode: "bypassPermissions",
    }, path.resolve("/work"))) {}

    const childSessionId = store.listSubagents("parent-session")[0]?.childSessionId
    expect(childSessionId).toBeString()
    expect(store.getSession(childSessionId!)).toMatchObject({ parentID: "parent-session" })
    expect(JSON.stringify(store.getMessages(childSessionId!))).toContain("child result")
    expect(permissionModes).toEqual(["bypassPermissions"])
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      sessionId: "parent-session",
      payload: expect.objectContaining({
        type: "subagent-updated",
        childSessionId,
        transcript: { kind: "messages", ref: "acp:agent-1" },
      }),
    }))
    expect(runtimeEvents).toContainEqual(expect.objectContaining({
      sessionId: childSessionId,
      payload: expect.objectContaining({ type: "text-delta", delta: "child result" }),
    }))
    expect(runtimeEvents).not.toContainEqual(expect.objectContaining({
      sessionId: "parent-session",
      payload: expect.objectContaining({ type: "text-delta", delta: "child result" }),
    }))
  })
})

describe("AcpHarnessAdapter active turn cleanup", () => {
  test("process keys are opaque fingerprints without raw launch secrets", () => {
    const adapter = new AcpHarnessAdapter({
      binary: "fake-acp",
      harness: "codex",
      args: ["--api-key", "arg-secret"],
      env: { ACP_TOKEN: "env-secret" },
      store: {} as AcpRuntimeStore,
    })
    const item = internalsOf<{
      currentMcp: unknown[]
      processKey: (directory: string) => string
    }>(adapter)
    item.currentMcp = [{
      name: "private-mcp",
      command: "node",
      args: ["mcp-secret"],
      env: { MCP_TOKEN: "mcp-env-secret" },
    }]

    const key = item.processKey(path.resolve("/work"))

    expect(key.startsWith("acp:")).toBe(true)
    expect(key).not.toContain("arg-secret")
    expect(key).not.toContain("env-secret")
    expect(key).not.toContain("mcp-secret")
    expect(key).not.toContain("mcp-env-secret")
    expect(key).not.toContain("--api-key")
  })

  test("process-level config changes ignore stale stored process keys", () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      currentModel: string
      options: { binary: string }
      store: { getSessionOwnerKey: (id: string) => string | null }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
      ignoreStoredProcessKeys: boolean
      keyForSession: (id: string, directory: string) => string
    }>
    item.currentEnv = { ACP_TOKEN: "old" }
    item.currentMcp = []
    item.currentModel = ""
    item.options = { binary: "fake-acp" }
    item.store = {
      getSessionOwnerKey() {
        return "old-stored-key"
      },
    }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.processes = new Map()
    item.sessionProcesses = new Map([["s1", "old-memory-key"]])
    item.ignoreStoredProcessKeys = false

    item.setAuth({ ACP_TOKEN: "new" })
    const next = item.keyForSession("s1", path.resolve("/work"))

    expect(next.startsWith("acp:")).toBe(true)
    expect(next).not.toBe("old-memory-key")
    expect(next).not.toBe("old-stored-key")
    expect(item.sessionProcesses.get("s1")).toBe(next)
  })

  test("abort failure invalidates the whole shared process", async () => {
    const calls: string[] = []
    const proc = {
      alive: true,
      pendingPermissions: new Map(),
      async cancel() {
        calls.push("cancel")
        throw new Error("cancel failed")
      },
      dispose() {
        calls.push("dispose")
      },
    }
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      currentModel: string
      options: { binary: string }
      store: {
        getAgentSessionId: (id: string) => string | null
        getSessionOwnerKey: (id: string) => string | null
        markSessionsInterruptedByOwner: (key: string, message?: string) => void
        stalePermission: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: typeof proc | null; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
      permissionOwners: Map<string, typeof proc>
    }>
    const lost: unknown[] = []
    item.currentEnv = {}
    item.currentMcp = []
    item.currentModel = ""
    item.options = { binary: "fake-acp" }
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSessionOwnerKey() {
        return "process-key"
      },
      markSessionsInterruptedByOwner(key, message) {
        lost.push({ key, message })
      },
      stalePermission(id) {
        calls.push(`stale:${id}`)
      },
    }
    item.processes = new Map([[
      "process-key",
      { key: "process-key", directory: path.resolve("/work"), proc, init: null, sessionIds: new Set(["s1", "s2"]) },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"], ["s2", "process-key"]])
    item.permissionOwners = new Map([["perm-1", proc]])

    const result = await item.abort("s1", path.resolve("/work"))

    expect(result).toEqual({
      ok: false,
      status: "recovering",
      message: "ACP session cancellation failed; the agent process was stopped.",
    })
    expect(calls).toEqual(["cancel", "stale:perm-1", "dispose"])
    expect(lost).toEqual([{
      key: "process-key",
      message: "ACP session cancellation failed; the agent process was stopped.",
    }])
    expect(item.processes.get("process-key")?.proc).toBeNull()
  })

  test("delete keeps a shared process alive while persisted siblings remain", async () => {
    const calls: string[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getSessionOwnerKey: (id: string) => string | null
        listSessionsByOwnerKey: (key: string) => string[]
        deleteSession: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: { dispose: () => void }; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
    }>
    item.store = {
      getSessionOwnerKey() {
        return "process-key"
      },
      listSessionsByOwnerKey() {
        return ["s1", "s2"]
      },
      deleteSession(id) {
        calls.push(`delete:${id}`)
      },
    }
    item.processes = new Map([[
      "process-key",
      {
        key: "process-key",
        directory: path.resolve("/work"),
        proc: { dispose: () => calls.push("dispose") },
        init: null,
        sessionIds: new Set(["s1"]),
      },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"]])

    await item.deleteSession("s1", path.resolve("/work"))

    expect(calls).toEqual(["delete:s1"])
    expect(item.processes.has("process-key")).toBe(true)
  })

  test("delete disposes a shared process when no in-memory or persisted siblings remain", async () => {
    const calls: string[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getSessionOwnerKey: (id: string) => string | null
        listSessionsByOwnerKey: (key: string) => string[]
        deleteSession: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: { dispose: () => void }; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
    }>
    item.store = {
      getSessionOwnerKey() {
        return "process-key"
      },
      listSessionsByOwnerKey() {
        return ["s1"]
      },
      deleteSession(id) {
        calls.push(`delete:${id}`)
      },
    }
    item.processes = new Map([[
      "process-key",
      {
        key: "process-key",
        directory: path.resolve("/work"),
        proc: { dispose: () => calls.push("dispose") },
        init: null,
        sessionIds: new Set(["s1"]),
      },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"]])

    await item.deleteSession("s1", path.resolve("/work"))

    expect(calls).toEqual(["dispose", "delete:s1"])
    expect(item.processes.has("process-key")).toBe(false)
  })

  test("builds ACP processes through the injected transport factory", () => {
    const calls: unknown[] = []
    const transport: ACPTransport = {
      kind: "streamable-http",
      stream: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      metadata: { transport: "fake-http" },
      alive: true,
      dispose() {
        calls.push("dispose")
      },
    }
    const item = new AcpHarnessAdapter({
      binary: "remote-acp",
      args: ["--stdio"],
      env: { ACP_TOKEN: "secret" },
      store: {} as AcpRuntimeStore,
      createTransport(input) {
        calls.push({
          directory: input.directory,
          binary: input.binary,
          args: input.args,
          model: input.model,
          env: input.env,
        })
        return transport
      },
    })
    const proc = (item as unknown as {
      make: () => { alive: boolean; dispose: () => void }
    }).make()

    expect(proc.alive).toBe(true)
    proc.dispose()
    expect(calls).toEqual([
      {
        directory: process.cwd(),
        binary: "remote-acp",
        args: ["--stdio"],
        model: "",
        env: { ACP_TOKEN: "secret" },
      },
      "dispose",
    ])
  })

  /**
   * Cursor is the only ACP harness whose binary is a general CLI rather than a
   * dedicated adapter: `cursor-agent` alone opens an interactive TUI, and
   * `cursor-agent acp` is what speaks the protocol. Getting this wrong does not
   * error — it hands a TUI a pipe and the handshake hangs — so it is asserted
   * rather than left to a launch that happens to work.
   *
   * The dedupe case is not hypothetical: the subcommand used to be supplied by
   * workspace-runtime's own `ACP_ARGS` table, and configs written against that
   * still pass it.
   */
  const launchArgs = (harness: "cursor" | "claude", args?: string[]) => {
    const seen: string[][] = []
    const transport: ACPTransport = {
      kind: "stdio",
      stream: { readable: new ReadableStream(), writable: new WritableStream() },
      metadata: { transport: "fake" },
      alive: true,
      dispose() {},
    }
    const item = new AcpHarnessAdapter({
      binary: "bin",
      harness,
      ...(args ? { args } : {}),
      store: {} as AcpRuntimeStore,
      createTransport(input) {
        seen.push(input.args)
        return transport
      },
    })
    const proc = (item as unknown as { make: () => { dispose: () => void } }).make()
    proc.dispose()
    return seen[0]
  }

  test("cursor is launched through its acp subcommand", () => {
    expect(launchArgs("cursor")).toEqual(["acp"])
  })

  test("cursor's subcommand leads caller args rather than trailing them", () => {
    expect(launchArgs("cursor", ["--foo"])).toEqual(["acp", "--foo"])
  })

  test("a caller that already passes acp does not get it twice", () => {
    expect(launchArgs("cursor", ["acp"])).toEqual(["acp"])
  })

  test("no other harness gains a subcommand", () => {
    expect(launchArgs("claude")).toEqual([])
  })

  test("registers direct ACP harness, probe, and MCP lifecycles without launch secrets", () => {
    const sentinel = "acp-observer-sentinel"
    const descriptors: AgentProcessDescriptor[] = []
    const exits: unknown[] = []
    const processObserver: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return {
          update: () => undefined,
          exit: (event) => exits.push(event),
        }
      },
    }
    const createTransport = () => ({
      kind: "stdio" as const,
      stream: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      metadata: {},
      pid: 456,
      alive: true,
      dispose() {},
    })
    const adapter = new AcpHarnessAdapter({
      binary: "/safe/bin/codex-acp",
      harness: "codex",
      args: ["--token", sentinel],
      env: { TOKEN: sentinel },
      store: {} as AcpRuntimeStore,
      createTransport,
      processObserver,
    })
    const item = internalsOf<{
      currentMcp: Array<{
        name: string
        command: string
        args: string[]
        env: Array<{ name: string; value: string }>
      }>
      make: (directory: string, role: "harness" | "probe") => { dispose(): void }
    }>(adapter)
    item.currentMcp = [{
      name: "safe-mcp",
      command: "node",
      args: [sentinel],
      env: [{ name: "TOKEN", value: sentinel }],
    }]

    const harness = item.make(path.resolve("/work"), "harness")
    const probe = item.make(path.resolve("/work"), "probe")

    expect(descriptors.map((descriptor) => [descriptor.role, descriptor.pid, descriptor.parentOwnerId])).toEqual([
      ["harness", 456, undefined],
      ["mcp", undefined, descriptors[0]!.ownerId],
      ["probe", 456, undefined],
      ["mcp", undefined, descriptors[2]!.ownerId],
    ])
    expect(JSON.stringify(descriptors)).not.toContain(sentinel)
    harness.dispose()
    probe.dispose()
    expect(exits).toHaveLength(4)
  })

  test("passes the selected model to Codex ACP through CODEX_CONFIG", () => {
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = []
    const transport: ACPTransport = {
      kind: "streamable-http",
      stream: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      metadata: { transport: "fake-http" },
      alive: true,
      dispose() {},
    }
    const item = new AcpHarnessAdapter({
      binary: "codex-acp",
      harness: "codex",
      args: ["-c", "service_tier=\"fast\""],
      store: {} as AcpRuntimeStore,
      createTransport(input) {
        calls.push({ args: input.args, env: input.env })
        return transport
      },
    })

    item.setModel("gpt-5.5")
    ;(item as unknown as { make: () => unknown }).make()

    expect(calls[0]?.args).toEqual([])
    expect(JSON.parse(calls[0]?.env.CODEX_CONFIG ?? "{}")).toEqual({
      service_tier: "fast",
      model: "gpt-5.5",
    })
  })

  test("session config model patch updates Codex ACP CODEX_CONFIG", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string | undefined> }> = []
    const transport: ACPTransport = {
      kind: "streamable-http",
      stream: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      metadata: { transport: "fake-http" },
      alive: true,
      dispose() {},
    }
    const item = new AcpHarnessAdapter({
      binary: "codex-acp",
      harness: "codex",
      args: ["-c", "service_tier=\"fast\""],
      store: fakeRuntimeStore({
        updateSessionConfig() {
          return {
            harness: { id: "codex", access: "acp" },
            model: { providerID: "codex-acp", modelID: "gpt-5.5" },
            variant: null,
            agent: "build",
          }
        },
        getAgentSessionId: () => undefined,
      }),
      createTransport(input) {
        calls.push({ args: input.args, env: input.env })
        return transport
      },
    })

    await item.updateSessionConfig("s1", {
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    }, path.resolve("/work"))
    ;(item as unknown as { make: () => unknown }).make()

    expect(calls[0]?.args).toEqual([])
    expect(JSON.parse(calls[0]?.env.CODEX_CONFIG ?? "{}")).toEqual({
      service_tier: "fast",
      model: "gpt-5.5",
    })
  })

  test("rejects and rolls back config when a live ACP session rejects the update", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "native-1" })
    store.updateSessionConfig("s1", {
      harness: { id: "codex", access: "acp" },
      model: { providerID: "codex", modelID: "gpt-5.5" },
      variant: "medium",
      agent: "build",
    })
    const item = new AcpHarnessAdapter({ binary: "codex-acp", harness: "codex", store })
    item.setModel("gpt-5.5")
    internalsOf<{
      entryForSession: () => { proc: { alive: boolean; syncSession: () => Promise<void> } }
    }>(item).entryForSession = () => ({
      proc: {
        alive: true,
        async syncSession() { throw new Error("model rejected") },
      },
    })

    await expect(item.updateSessionConfig("s1", { variant: "high" }, path.resolve("/work")))
      .rejects.toThrow("model rejected")
    expect(store.getSessionConfig("s1")?.variant).toBe("medium")
    item.dispose()
  })

  test("sendMessage applies the prompt model before process lookup", async () => {
    const calls: string[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: () => string
        getSession: () => { title: string }
      }
      setModel: (model: string) => void
      getOrSpawnProcess: () => Promise<never>
    }>
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSession() {
        return { title: "Test" }
      },
    }
    item.setModel = (model) => calls.push(`setModel:${model}`)
    item.getOrSpawnProcess = async () => {
      calls.push("getOrSpawnProcess")
      throw new Error("stop")
    }

    for await (const _ of (item as unknown as {
      _sendMessage: (id: string, input: unknown, directory: string, t0: number) => AsyncIterable<unknown>
    })._sendMessage("s1", {
      parts: [],
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    } as never, path.resolve("/work"), Date.now())) {
      break
    }

    expect(calls).toEqual(["setModel:gpt-5.5", "getOrSpawnProcess"])
  })

  test("initialization timeout disposes the process", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      initialize: (proc: { initialize: () => Promise<void>; dispose: () => void }, ms: number) => Promise<void>
    }>
    let disposed = false

    await expect(item.initialize({
      async initialize() {
        return new Promise(() => {})
      },
      dispose() {
        disposed = true
      },
    }, 5)).rejects.toThrow("ACP initialize timed out after 5ms")

    expect(disposed).toBe(true)
  })

  test("initialization failure preserves ACP stderr detail", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      initialize: (proc: {
        initialize: () => Promise<void>
        dispose: () => void
        failureDetail: () => string
      }, ms: number) => Promise<void>
    }>

    await expect(item.initialize({
      async initialize() {
        throw new Error("ACP connection closed")
      },
      dispose() {},
      failureDetail() {
        return "Error: error loading config: ~/.codex/config.toml:7:16: unknown variant `default`"
      },
    }, 5)).rejects.toThrow(
      "ACP connection closed: Error: error loading config: ~/.codex/config.toml:7:16: unknown variant `default`",
    )
  })

  test("session creation timeout disposes the process before storing a session", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "5"
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentModel: string
      options: { binary: string }
      store: {
        getSession: () => unknown
        bindSession: () => void
        updateSessionConfig: () => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          newSession: (directory: string, title?: string) => Promise<string>
          dispose: () => void
        }
      }>
    }>
    const calls: string[] = []
    item.currentModel = ""
    item.options = { binary: "fake-acp" }
    item.store = {
      getSession: () => undefined,
      bindSession() {
        calls.push("bind")
      },
      updateSessionConfig() {
        calls.push("config")
      },
    }
    item.getOrSpawnProcess = async (_id, directory) => {
      expect(directory).toBe(path.resolve("/work"))
      return {
        proc: {
          async newSession(dir, title) {
            expect(dir).toBe(path.resolve("/work"))
            expect(title).toBe("Test")
            calls.push("newSession")
            return new Promise(() => {})
          },
          dispose() {
            calls.push("dispose")
          },
        },
      }
    }

    try {
      await expect(item.createSession(path.resolve("/work"), "Test")).rejects.toThrow("ACP newSession timed out after 5ms")

      expect(calls).toContain("newSession")
      expect(calls).toContain("dispose")
      expect(calls).not.toContain("bind")
      expect(calls).not.toContain("config")
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  })

  test("resume timeout cancels and disposes the wedged process", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "5"

    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { binary: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      getOrSpawnProcess: () => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: () => Promise<never>
          syncSession: () => Promise<void>
          prompt: () => Promise<never>
          cancel: () => Promise<void>
          dispose: () => void
        }
        isNew: boolean
      }>
    }>
    const calls: string[] = []
    item.options = { binary: "fake-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSession() {
        return { title: "Active" }
      },
      consumeRecoveryError() {
        return null
      },
      startTurn() {},
      appendEvent() {},
      bindSession() {},
    }
    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        permissionPushers: new Map<string, unknown>(),
        async resumeSession() {
          calls.push("resume")
          return new Promise<never>(() => {})
        },
        async syncSession() {},
        async prompt() {
          throw new Error("prompt should not run")
        },
        async cancel() {
          calls.push("cancel")
        },
        dispose() {
          calls.push("dispose")
        },
      },
    })

    try {
      const events: string[] = []
      for await (const event of item.sendMessage("s1", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "codex-acp", modelID: "default" },
      }, path.resolve("/work"))) {
        events.push(event.type)
      }

      expect(calls).toContain("resume")
      expect(calls).toContain("cancel")
      expect(calls).toContain("dispose")
      expect(events).toContain("session.error")
      expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
      expect(item.turnLifecycle.activeTurns.size).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  })

  test("prompt timeout cancels and disposes the wedged process", async () => {
    // The PROMPT turn is bounded by the prompt timeout (not the new-session
    // handshake timeout — a slow model turn must not be cancelled at 10s).
    const prev = process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS
    process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = "5"

    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { binary: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      getOrSpawnProcess: () => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: () => Promise<void>
          syncSession: () => Promise<void>
          prompt: () => Promise<never>
          cancel: () => Promise<void>
          dispose: () => void
        }
        isNew: boolean
      }>
    }>
    const calls: string[] = []
    item.options = { binary: "fake-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSession() {
        return { title: "Active" }
      },
      consumeRecoveryError() {
        return null
      },
      startTurn() {},
      appendEvent() {},
      bindSession() {},
    }
    item.getOrSpawnProcess = async () => ({
      isNew: false,
      proc: {
        permissionPushers: new Map<string, unknown>(),
        async resumeSession() {},
        async syncSession() {},
        async prompt() {
          calls.push("prompt")
          return new Promise<never>(() => {})
        },
        async cancel() {
          calls.push("cancel")
        },
        dispose() {
          calls.push("dispose")
        },
      },
    })

    try {
      const events: string[] = []
      for await (const event of item.sendMessage("s1", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "codex-acp", modelID: "default" },
      }, path.resolve("/work"))) {
        events.push(event.type)
      }

      expect(calls).toContain("prompt")
      expect(calls).toContain("cancel")
      expect(calls).toContain("dispose")
      expect(events).toContain("session.error")
      expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
      expect(item.turnLifecycle.activeTurns.size).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = prev
    }
  })

  test("config apply defers restart while a turn is active", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { binary: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      sessions: Map<string, { directory: string; proc: unknown; init: null }>
      probe: null
      currentMcp: unknown[]
      currentEnv: Record<string, string>
      configRestartPending: boolean
      restart: () => void
      forgetSessionProcessBindings: () => void
      getOrSpawnProcess: () => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: () => Promise<void>
          syncSession: () => Promise<void>
          prompt: () => Promise<never>
          cancel: () => Promise<void>
          dispose: () => void
        }
        isNew: boolean
      }>
    }>

    const calls: string[] = []
    item.options = { binary: "fake-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.sessions = new Map()
    item.probe = null
    item.currentMcp = []
    item.currentEnv = {}
    item.configRestartPending = false
    item.restart = () => calls.push("restart")
    item.forgetSessionProcessBindings = () => calls.push("forget")
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSession() {
        return { title: "Active" }
      },
      consumeRecoveryError() {
        return null
      },
      startTurn() {},
      appendEvent() {},
      bindSession() {},
    }
    const proc = {
      permissionPushers: new Map<string, unknown>(),
      async resumeSession() {},
      async syncSession() {},
      async prompt() {
        calls.push("prompt")
        return new Promise<never>(() => {})
      },
      async cancel() {
        calls.push("cancel")
      },
      dispose() {
        calls.push("dispose")
      },
    }
    item.getOrSpawnProcess = async () => ({ proc, isNew: false })

    const iter = item.sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: "codex-acp", modelID: "default" },
    }, path.resolve("/work"))[Symbol.asyncIterator]()

    expect((await iter.next()).value?.type).toBe("session.status")
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(true)
    expect(calls).toContain("prompt")

    await item.applyConfig({ mcp: {}, auth: { OPENAI_API_KEY: "sk-new" } })

    expect(calls).not.toContain("restart")
    expect(item.configRestartPending).toBe(true)
    let configReady = false
    const readiness = item.waitForConfigReady().then(() => {
      configReady = true
    })
    await Bun.sleep(0)
    expect(configReady).toBe(false)
    expect(calls).not.toContain("restart")
    item.turnLifecycle.drain("s1", "test cleanup")

    const events: string[] = []
    while (true) {
      const next = await iter.next()
      if (next.done) break
      events.push(next.value.type)
    }

    expect(events).toContain("session.error")
    expect(calls).toContain("cancel")
    expect(calls).toContain("dispose")
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
    expect(item.turnLifecycle.activeTurns.size).toBe(0)

    await readiness

    expect(configReady).toBe(true)
    expect(calls).toContain("restart")
    expect(calls).toContain("forget")
    expect(item.configRestartPending).toBe(false)
  })

  test("unchanged config apply does not drain an active turn", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      options: { binary: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      restart: () => void
    }>

    const calls: string[] = []
    item.currentEnv = { OPENAI_API_KEY: "sk-same" }
    item.currentMcp = []
    item.options = { binary: "fake-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.turnLifecycle.enter("s1")
    item.turnLifecycle.set("s1", {
      drain(message) {
        calls.push(`drain:${message}`)
      },
    })
    item.restart = () => {
      calls.push("restart")
      item.turnLifecycle.drainAll("should not happen")
    }

    await item.applyConfig({ mcp: {}, auth: { OPENAI_API_KEY: "sk-same" } })

    expect(calls).toEqual([])
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(true)
    expect(item.turnLifecycle.activeTurns.size).toBe(1)
  })

  test("supportsMcpServers: false keeps configured MCP servers out of the adapter entirely", async () => {
    const makeItem = (supportsMcpServers?: boolean) => {
      const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
        currentEnv: Record<string, string>
        currentMcp: unknown[]
        options: { binary: string; supportsMcpServers?: boolean }
        turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
        restart: () => void
        forgetSessionProcessBindings: () => void
      }>
      item.currentEnv = {}
      item.currentMcp = []
      item.options = { binary: "fake-acp", ...(supportsMcpServers !== undefined ? { supportsMcpServers } : {}) }
      item.turnLifecycle = createSessionTurnLifecycle()
      const calls: string[] = []
      item.restart = () => calls.push("restart")
      item.forgetSessionProcessBindings = () => calls.push("forget")
      return { item, calls }
    }
    const mcp = {
      docs: { name: "docs", transport: "stdio" as const, command: "docs-mcp", args: [], env: {} },
    }

    // Flag off: the MCP config never reaches adapter state, and since the
    // effective config is unchanged the agent process is not restarted.
    const disabled = makeItem(false)
    await disabled.item.applyConfig({ mcp, auth: {} })
    expect(disabled.item.currentMcp).toEqual([])
    expect(disabled.calls).toEqual([])

    // Flag absent: the same config produces an offered server as usual.
    const offered = makeItem()
    await offered.item.applyConfig({ mcp, auth: {} })
    expect(offered.item.currentMcp).toHaveLength(1)
    expect(offered.calls).toEqual(["restart", "forget"])
  })

  test("claude oauth config applies as Claude Code oauth env", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      options: { binary: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      restart: () => void
      forgetSessionProcessBindings: () => void
    }>

    const calls: string[] = []
    item.currentEnv = {}
    item.currentMcp = []
    item.options = { binary: "fake-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.restart = () => calls.push("restart")
    item.forgetSessionProcessBindings = () => calls.push("forget")

    await item.applyConfig({
      mcp: {},
      auth: {
        "claude-acp": JSON.stringify({
          claudeAiOauth: {
            accessToken: "sk-ant-oauth",
          },
        }),
      },
    })

    expect(item.currentEnv).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oauth" })
    expect(calls).toEqual(["restart", "forget"])
  })

  test("probe config cache wait clears its polling interval", async () => {
    const prev = process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
    process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = "5"
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const intervals: number[] = []
    let cleared = 0
    globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = originalSetInterval(handler, timeout, ...args)
      intervals.push(id)
      return id
    }) as typeof setInterval
    globalThis.clearInterval = ((id?: number) => {
      if (id !== undefined && intervals.includes(id)) cleared++
      return originalClearInterval(id)
    }) as typeof clearInterval

    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      sessions: Map<string, unknown>
      probe: null
      getOrSpawnProbe: () => Promise<{ alive: boolean; cachedConfigOptions: unknown[] | null }>
      boot: () => Promise<string>
    }>
    item.sessions = new Map()
    item.probe = null
    item.getOrSpawnProbe = async () => ({ alive: true, cachedConfigOptions: null })
    item.boot = async () => "probe-session"

    try {
      await expect(item.probeConfigOptions(path.resolve("/work"))).rejects.toThrow("ACP harness did not return live config options")
      expect(cleared).toBe(1)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
      for (const id of intervals) originalClearInterval(id)
      if (prev === undefined) delete process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_PROBE_TIMEOUT_MS = prev
    }
  })
})

describe("AcpHarnessAdapter fork support", () => {
  test("does not fabricate a fork when the ACP process does not advertise fork support", async () => {
    const calls: unknown[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentMcp: unknown[]
      store: {
        getSession: (id: string) => { title?: string } | null
        getAgentSessionId: (id: string) => string | null
        bindSession: (input: unknown) => void
      }
      getOrSpawnProcess: () => Promise<{
        isNew: boolean
        proc: {
          supportsForkSession: () => boolean
          forkSession: () => Promise<string>
        }
      }>
    }>
    item.currentMcp = []
    item.store = {
      getSession: () => ({ title: "Demo" }),
      getAgentSessionId: () => "agent_original",
      bindSession(input) {
        calls.push(input)
      },
    }
    item.getOrSpawnProcess = async () => ({
      isNew: false,
      proc: {
        supportsForkSession: () => false,
        async forkSession() {
          throw new Error("should not call unsupported ACP fork")
        },
      },
    })

    await expect(item.forkSession("s1", "m1", path.resolve("/work"))).rejects.toThrow(
      "ACP agent does not advertise session fork support",
    )
    expect(calls).toEqual([])
  })

  test("binds a fork to the agent session returned by session/fork", async () => {
    const calls: unknown[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentMcp: unknown[]
      store: {
        getSession: (id: string) => { title?: string } | null
        getAgentSessionId: (id: string) => string | null
        bindSession: (input: unknown) => void
      }
      getOrSpawnProcess: () => Promise<{
        isNew: boolean
          proc: {
            resumeSession: (agentSessionId: string, directory: string) => Promise<void>
            supportsForkSession: (agentSessionId?: string) => boolean
            forkSession: (agentSessionId: string, directory: string) => Promise<string>
        }
      }>
    }>
    item.currentMcp = []
    item.store = {
      getSession: () => ({ title: "Demo" }),
      getAgentSessionId: () => "agent_original",
      bindSession(input) {
        calls.push(input)
      },
    }
    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        async resumeSession(agentSessionId, directory) {
          calls.push({ resume: { agentSessionId, directory } })
        },
        supportsForkSession: (agentSessionId) => agentSessionId === "agent_original",
        async forkSession(agentSessionId, directory) {
          calls.push({ fork: { agentSessionId, directory } })
          return "agent_forked"
        },
      },
    })

    const result = await item.forkSession("s1", "m1", path.resolve("/work"))

    expect(typeof result.id).toBe("string")
    expect(calls).toEqual([
      { resume: { agentSessionId: "agent_original", directory: path.resolve("/work") } },
      {
        fork: {
          agentSessionId: "agent_original",
          directory: path.resolve("/work"),
        },
      },
      expect.objectContaining({
        directory: path.resolve("/work"),
        title: "Demo",
        agentSessionId: "agent_forked",
      }),
    ])
  })
})

describe("AcpHarnessAdapter event fan-out", () => {
  test("AI title prompt timeout cancels the temporary title session", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "5"
    const calls: string[] = []
    const store = {
      getSession() {
        return null
      },
      appendEvent() {
        calls.push("append")
      },
    }
    const proc = {
      async newSession() {
        return "title-session"
      },
      async prompt() {
        calls.push("prompt")
        return new Promise<never>(() => {})
      },
      async cancel(id: string) {
        calls.push(`cancel:${id}`)
      },
      dispose() {
        calls.push("dispose")
      },
    }

    try {
      await generateAITitle({
        store,
        getOrSpawnProcess: async () => ({ proc: proc as never }),
        boot: async (item) => item.newSession(path.resolve("/work")),
      }, "s1", path.resolve("/work"), "please add tests")

      expect(calls).toContain("prompt")
      expect(calls).toContain("cancel:title-session")
      expect(calls).not.toContain("append")
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  })

  test("AI title updates are persisted before direct global fan-out", async () => {
    const persisted: string[] = []
    const global: string[] = []
    /** Only `session.updated` carries a session row, so the title has to be read behind that check. */
    const titleOrType = (payload: CompatEvent) =>
      payload.type === "session.updated" ? payload.properties.info.title : payload.type
    const store = {
      getSession() {
        return null
      },
      appendEvent(input: { sessionId: string; payload: CompatEvent }) {
        persisted.push(titleOrType(input.payload))
      },
    }
    const eventHub = {
      publishGlobal(event: { payload: CompatEvent }) {
        global.push(titleOrType(event.payload))
      },
    }
    const proc = {
      async newSession() {
        return "title-session"
      },
      dispose() {},
      async prompt(_id: string, _input: unknown, onUpdate: (update: unknown) => void) {
        onUpdate({ sessionUpdate: "agent_message_chunk", delta: "Better Title" })
        return { stopReason: "end_turn" }
      },
      async cancel() {},
    }

    await generateAITitle({
      store,
      eventHub: eventHub as never,
      getOrSpawnProcess: async () => ({ proc: proc as never }),
      boot: async (item) => item.newSession(path.resolve("/work")),
    }, "s1", path.resolve("/work"), "please add tests")

    expect(persisted).toEqual(["Better Title"])
    expect(global).toEqual(["Better Title"])
  })
})

/**
 * `unrestorable()` decides whether a failed `resumeSession` is recoverable by
 * minting a replacement agent-side session (preserving the durable Claxedo
 * Session identity) or is a real error the caller must see.
 *
 * For codex this is keyed on the JSON-RPC code, not the rendered message,
 * because codex-acp funnels its failures through
 * `RequestError.internalError(details)` — so the message reads "Internal error"
 * only while `data` is empty, and carries the detail text otherwise. An
 * equality test against "Internal error" therefore stopped recovering sessions
 * precisely when the agent explained what went wrong.
 *
 * These drive the real `sendMessage` resume path rather than calling the
 * module-private `unrestorable` directly: the observable behavior is that the
 * adapter re-boots and re-binds the session instead of emitting `session.error`.
 * The `WithInternals` seam is the same one the resume/prompt timeout tests above
 * use, so nothing extra had to be exported to reach it.
 */
describe("AcpHarnessAdapter resume recovery classification", () => {
  type ResumeInternals = WithInternals<AcpHarnessAdapter, {
    store: AcpRuntimeStore
    options: { binary: string; harness: string }
    turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
    boot: (proc: unknown, directory: string, title?: string) => Promise<string>
    getOrSpawnProcess: () => Promise<{
      proc: {
        permissionPushers: Map<string, unknown>
        resumeSession: () => Promise<never>
        syncSession: () => Promise<void>
        prompt: () => Promise<{ stopReason: string; usage: { totalTokens: number; inputTokens: number; outputTokens: number } }>
        cancel: () => Promise<void>
        dispose: () => void
      }
      isNew: boolean
    }>
  }>

  /**
   * Runs one `sendMessage` whose resume rejects with `resumeError`, and reports
   * whether the adapter took the replacement path (`boot` + `bindSession`) or
   * surfaced the failure.
   */
  async function resumeWith(harness: string, resumeError: unknown) {
    const item = Object.create(AcpHarnessAdapter.prototype) as ResumeInternals
    const calls: string[] = []
    let boundAgentSessionId: string | undefined

    item.options = { binary: "fake-acp", harness }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.store = fakeRuntimeStore({
      getAgentSessionId: () => "agent-session-1",
      getSession: () => ({ title: "Active" } as ReturnType<AcpRuntimeStore["getSession"]>),
      bindSession(input) {
        calls.push("bindSession")
        boundAgentSessionId = input.agentSessionId
      },
    })
    // The replacement session the adapter mints when it decides the old one is
    // unrestorable. Stubbed so the test can observe that it ran at all.
    item.boot = async () => {
      calls.push("boot")
      return "agent-session-2"
    }
    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        permissionPushers: new Map<string, unknown>(),
        async resumeSession() {
          calls.push("resume")
          throw resumeError
        },
        async syncSession() {},
        // A normal completed turn with usage, so the only thing that can put a
        // `session.error` on the stream is the resume classification itself.
        async prompt() {
          calls.push("prompt")
          return { stopReason: "end_turn", usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 } }
        },
        async cancel() {},
        dispose() {},
      },
    })

    const events: string[] = []
    for await (const event of item.sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: `${harness}-acp`, modelID: "default" },
    }, "/work")) {
      events.push(event.type)
    }

    return {
      calls,
      events,
      boundAgentSessionId,
      replaced: calls.includes("boot") && calls.includes("bindSession"),
      errored: events.includes("session.error"),
    }
  }

  // The four shapes codex-acp's generic error handler actually produces:
  //   const details = errorDetails(e)
  //   try   { RequestError.internalError(details ? JSON.parse(details) : {}) }
  //   catch { RequestError.internalError({ details }) }
  // Before this was keyed on the code, only the first and last recovered.
  const codexInternalErrors: [string, unknown][] = [
    ["no details", RequestError.internalError({})],
    ["non-JSON details", RequestError.internalError({ details: "session not found" })],
    ["JSON details carrying a message", RequestError.internalError({ message: "session not found" })],
    ["JSON details with other keys", RequestError.internalError({ code: "SESSION_GONE" })],
  ]

  for (const [label, err] of codexInternalErrors) {
    test(`codex replaces the agent session when resume fails with an internal error (${label})`, async () => {
      const out = await resumeWith("codex", err)

      expect(out.calls).toContain("resume")
      expect(out.replaced).toBe(true)
      expect(out.boundAgentSessionId).toBe("agent-session-2")
      expect(out.errored).toBe(false)
    })
  }

  test("a codex failure with a different JSON-RPC code is a real error, not a replacement", async () => {
    // -32602 Invalid params: the agent rejected the request itself, so minting a
    // fresh session would just replay the same rejection.
    const out = await resumeWith("codex", RequestError.invalidParams({ details: "cwd must be absolute" }))

    expect(out.calls).toContain("resume")
    expect(out.replaced).toBe(false)
    expect(out.errored).toBe(true)
  })

  test("a non-codex harness does not replace on an internal error", async () => {
    // The codex branch is harness-scoped: claude-agent-acp reports genuine
    // startup failures as internal errors, and those must reach the user.
    const out = await resumeWith("claude", RequestError.internalError({ details: "session not found" }))

    expect(out.calls).toContain("resume")
    expect(out.replaced).toBe(false)
    expect(out.errored).toBe(true)
  })
})
