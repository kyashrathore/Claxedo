import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { McpServer } from "@agentclientprotocol/sdk"
import { cancelAdapterTurn } from "../../test-utils/cancel-turn"
import { type WithInternals } from "../../test-utils/class-internals"
import { committedStartTurn, fakeRuntimeStore } from "../../test-utils/fake-runtime-store"
import type { AgentRuntimeTurnStartInput } from "../shared/runtime-store"
import { AcpHarnessAdapter, type AcpRuntimeStore, type ACPTransport } from "./index"
import { ACPProcess } from "./process"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { MemoryRuntimeStore } from "../../stores/memory"
import { executeTestTurn, executionBinding } from "../../test-utils/execution-binding"

// These fixtures isolate lifecycle operations; command projection is exercised over real ACP streams.
class LifecycleTestAdapter extends AcpHarnessAdapter {
  protected override bindCommandUpdates() {}
}

/**
 * Drives the adapter's *protected* surface on a real instance.
 *
 * `currentMcp`, `processKey` and `make` are `protected`, not `private`, so a
 * subclass reaches them directly. Exposing exactly those three keeps their
 * types the adapter's own: a test that mis-describes one now fails to compile,
 * where a caller-chosen internals cast accepted whatever the test invented.
 */
class ProtectedAcpAdapter extends AcpHarnessAdapter {
  seedMcp(servers: McpServer[]) {
    this.currentMcp = servers
  }

  keyFor(directory: string) {
    return this.processKey(directory)
  }

  spawn(directory: string, role: "harness" | "probe") {
    return this.make(directory, role)
  }
}

/** A transport that connects to nothing: enough to construct a live `ACPProcess`. */
function inertTransport() {
  return {
    kind: "stdio" as const,
    stream: { readable: new ReadableStream(), writable: new WritableStream() },
    metadata: {},
    pid: 1,
    alive: true,
    dispose() {},
  }
}

/**
 * A live process whose session sync rejects — the case `updateSessionConfig`
 * must roll back. Subclassing the real `ACPProcess` keeps `alive` and the rest
 * of the surface genuine; only the one call under test is replaced.
 */
class SyncRejectingProcess extends ACPProcess {
  override hasSession() { return true }
  override async syncSession(): Promise<never> {
    throw new Error("model rejected")
  }
}

/** Binds every session to one caller-supplied process, bypassing the spawn path. */
class BoundProcessAdapter extends AcpHarnessAdapter {
  bound: ACPProcess | null = null

  protected override entryForSession() {
    if (!this.bound) return undefined
    return {
      key: "acp:test",
      directory: path.resolve("/work"),
      proc: this.bound,
      init: null,
      sessionIds: new Set<string>(),
    }
  }
}

function adapter() {
  const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
    store: {
      listPermissions: (directory: string) => Array<{ id: string; sessionID: string }>
      appendEvent: (input: unknown) => void
      getSessionConfig?: (id: string) => { permissionState: Record<string, unknown> } | null
      updateSessionConfig?: (id: string, update: unknown) => object
    }
    processes: Map<string, { proc: { alive: boolean; pendingPermissions: Map<string, unknown>; respondPermission: (id: string, response: unknown) => void } }>
  }>
  item.processes = new Map()
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
    item.processes.set("session-1", {
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

    await item.respondPermission(executionBinding("session-1", path.resolve("/work")), "perm-1", "deny")

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
      getSessionConfig() {
        return null
      },
      updateSessionConfig() {
        return {}
      },
    }
    const selected: unknown[] = []
    item.processes.set("session-1", {
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

    await item.respondPermission(executionBinding("session-1", path.resolve("/work")), "perm-1", "allow_always")

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
    item.processes.set("session-1", {
      proc: {
        alive: true,
        pendingPermissions: new Map(),
        respondPermission() {},
      },
    })
    item.processes.set("replacement", {
      proc: {
        alive: true,
        pendingPermissions: new Map([["perm-1", { options: [] }]]),
        respondPermission() {},
      },
    })

    expect(await item.listPermissions(path.resolve("/work"))).toMatchObject([{ id: "perm-1", sessionID: "session-1" }])
    expect(stale).toEqual([])
  })

  test("responds to permissions owned by a live replacement process and remembers an 'always'", async () => {
    const item = adapter()
    const selected: unknown[] = []
    const configUpdates: unknown[] = []
    item.store = {
      listPermissions() {
        return [{ id: "perm-1", sessionID: "session-1" }]
      },
      appendEvent() {},
      getSessionConfig() {
        return { permissionState: { codexCommandGrants: [] } }
      },
      updateSessionConfig(id: string, update: unknown) {
        configUpdates.push([id, update])
        return {}
      },
    }
    item.processes.set("session-1", {
      proc: {
        alive: true,
        pendingPermissions: new Map(),
        respondPermission() {},
      },
    })
    item.processes.set("replacement", {
      proc: {
        alive: true,
        pendingPermissions: new Map([
          ["perm-1", {
            tool: "bun test src",
            kind: "execute",
            options: [{ kind: "allow_always", optionId: "allow-session" }],
          }],
        ]),
        respondPermission(_id, response) {
          selected.push(response)
        },
      },
    })

    await item.respondPermission(executionBinding("session-1", path.resolve("/work")), "perm-1", "allow_always")

    expect(selected).toEqual([{ outcome: { outcome: "selected", optionId: "allow-session" } }])
    expect(configUpdates).toEqual([[
      "session-1",
      { permissionState: { codexCommandGrants: [], acpGrants: [{ kind: "execute", tool: "bun test src" }] } },
    ]])
  })

  test("a request covered by a saved 'always' is answered without asking", async () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        getSessionConfig: (id: string) => { permissionState: Record<string, unknown> }
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: AgentRuntimeTurnStartInput) => ReturnType<typeof committedStartTurn>
        appendEvent: (input: { payload: { type: string } }) => void
        bindSession: (input: unknown) => void
      }
      options: { connection: { kind: "process"; command: string }; harness: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      getOrSpawnProcess: () => Promise<{ proc: unknown; isNew: boolean }>
    }>
    const appended: string[] = []
    const answered: unknown[] = []
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSession() {
        return { title: "Active" }
      },
      getSessionConfig() {
        return { permissionState: { acpGrants: [{ kind: "execute", tool: "bun test src" }] } }
      },
      consumeRecoveryError() {
        return null
      },
      startTurn(input) {
        return committedStartTurn(input)
      },
      appendEvent(input) {
        appended.push(input.payload.type)
      },
      bindSession() {},
    }
    const permissionPushers = new Map<string, (payload: unknown) => void>()
    item.getOrSpawnProcess = async () => ({
      isNew: false,
      proc: {
        permissionPushers,
        listenSubagents: () => () => {},
        hasSession: () => true,
        pendingPermissions: new Map([
          ["perm-1", { tool: "bun test src", kind: "execute", options: [{ kind: "allow_once", optionId: "once" }] }],
          ["perm-2", { tool: "rm -rf build", kind: "execute", options: [{ kind: "allow_once", optionId: "once" }] }],
        ]),
        async resumeSession() {},
        async syncSession() {},
        async prompt() {
          const push = permissionPushers.get("agent-session-1")!
          push({ permId: "perm-1", tool: "bun test src", kind: "execute", paths: [] })
          push({ permId: "perm-2", tool: "rm -rf build", kind: "execute", paths: [] })
          return { stopReason: "end_turn", usage: null }
        },
        respondPermission(permId: string, response: unknown) {
          answered.push([permId, response])
        },
        async cancel() {},
        dispose() {},
      },
    })

    const events: string[] = []
    for await (const event of executeTestTurn(item, "s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: "connection:example", modelID: "default" },
    }, path.resolve("/work"))) {
      events.push(event.type)
    }

    expect(answered).toEqual([["perm-1", { outcome: { outcome: "selected", optionId: "once" } }]])
    // Nobody was asked about the granted request, so only its answer is recorded.
    expect(events.filter((type) => type === "permission.asked")).toHaveLength(1)
    expect(events.filter((type) => type === "permission.replied")).toHaveLength(1)
    expect(appended.filter((type) => type === "permission.asked")).toHaveLength(1)
    expect(appended.filter((type) => type === "permission.replied")).toHaveLength(1)
  })
})

describe("AcpHarnessAdapter runtime health isolation", () => {
  test("ignores recovering sessions owned by other workspace harnesses", () => {
    const store = fakeRuntimeStore({
      listSessions: () => [
        {
          id: "old-codex-native",
          status: "recovering",
          recovery_error: "old native process stopped",
          config: { harness: { id: "codex", access: "native" } },
        },
        {
          id: "other-acp",
          status: "recovering",
          recovery_error: "other ACP process stopped",
          config: { harness: { id: "gemini", access: "connection" } },
        },
        {
          id: "openclaw-idle",
          status: "idle",
          config: { harness: { id: "openclaw", access: "connection" } },
        },
      ],
    })
    const item = new AcpHarnessAdapter({
      connection: { kind: "process", command: "openclaw" },
      harness: "openclaw",
      store,
    })

    expect(item.readRuntimeHealth(path.resolve("/work"))).toEqual({ status: "ok" })
  })

  test("reports recovery for the current ACP harness only", () => {
    const store = fakeRuntimeStore({
      listSessions: () => [{
        id: "openclaw-recovering",
        status: "recovering",
        recovery_error: "OpenClaw process stopped",
      }],
      getSessionConfig: (id) => id === "openclaw-recovering"
        ? { harness: { id: "openclaw", access: "connection" } }
        : null,
    })
    const item = new AcpHarnessAdapter({
      connection: { kind: "process", command: "openclaw" },
      harness: "openclaw",
      store,
    })

    expect(item.readRuntimeHealth(path.resolve("/work"))).toEqual({
      status: "degraded",
      reason: "harness_process_lost",
      message: "OpenClaw process stopped",
      sessions: [{
        id: "openclaw-recovering",
        status: "recovering",
        message: "OpenClaw process stopped",
      }],
    })
  })

  test("an exact-session health read ignores a three-day-old recovering session without an active turn", () => {
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1_000)
    const store = fakeRuntimeStore({
      listSessions: () => [
        {
          id: "old-openclaw",
          status: "recovering",
          recovery_error: "old OpenClaw process stopped",
          time: { created: threeDaysAgo, updated: threeDaysAgo },
          config: { harness: { id: "openclaw", access: "connection" } },
        },
        {
          id: "current-openclaw",
          status: "idle",
          config: { harness: { id: "openclaw", access: "connection" } },
        },
      ],
    })
    const item = new AcpHarnessAdapter({
      connection: { kind: "process", command: "openclaw" },
      harness: "openclaw",
      store,
    })

    expect(item.readRuntimeHealth(path.resolve("/work"), { sessionId: "current-openclaw" })).toEqual({ status: "ok" })
    expect(item.readRuntimeHealth(path.resolve("/work"), { sessionId: "old-openclaw" })).toEqual({ status: "ok" })
  })

})

describe("AcpHarnessAdapter active turn cleanup", () => {
  test("process keys are opaque fingerprints without raw launch secrets", () => {
    const adapter = new ProtectedAcpAdapter({
      connection: {
        kind: "process",
        command: "fake-acp",
        args: ["--api-key", "arg-secret"],
        env: { ACP_TOKEN: "env-secret" },
      },
      harness: "codex",
      store: {} as AcpRuntimeStore,
    })
    adapter.seedMcp([{
      name: "private-mcp",
      command: "node",
      args: ["mcp-secret"],
      env: [{ name: "MCP_TOKEN", value: "mcp-env-secret" }],
    }])

    const key = adapter.keyFor(path.resolve("/work"))

    expect(key.startsWith("acp:")).toBe(true)
    expect(key).not.toContain("arg-secret")
    expect(key).not.toContain("env-secret")
    expect(key).not.toContain("mcp-secret")
    expect(key).not.toContain("mcp-env-secret")
    expect(key).not.toContain("--api-key")
  })

  test("process-level config changes ignore stale stored process keys", () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      currentModel: string
      options: { connection: { kind: "process"; command: string }; harness: string }
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
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "openclaw-active" }
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

  test("abort answers the cancelled turn's pending permissions with cancelled and commits the reject", async () => {
    const responses: Array<{ id: string; response: unknown }> = []
    const proc = {
      alive: true,
      listenSubagents: () => () => {},
      hasSession: () => true,
      rootAgentSessionId: (id: string) => id,
      sessionIsWithin: (id: string, ancestor: string) => id === ancestor,
      pendingPermissions: new Map([
        ["perm-mine", { aid: "agent-session-1", tool: "bash", paths: [], options: [], resolve() {} }],
        ["perm-other", { aid: "agent-session-2", tool: "bash", paths: [], options: [], resolve() {} }],
      ]),
      async cancelAndWait() {},
      respondPermission(id: string, response: unknown) {
        responses.push({ id, response })
        proc.pendingPermissions.delete(id)
      },
      dispose() {},
    }
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string | null
        getSessionOwnerKey: (id: string) => string | null
        appendEvent: (input: { payload: unknown }) => { payload: unknown }
      }
      processes: Map<string, { key: string; directory: string; proc: typeof proc | null; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
      permissionOwners: Map<string, typeof proc>
    }>
    const appended: unknown[] = []
    item.store = {
      getAgentSessionId: () => "agent-session-1",
      getSessionOwnerKey: () => "process-key",
      appendEvent(input) {
        appended.push(input)
        return { payload: input.payload }
      },
    }
    item.processes = new Map([[
      "process-key",
      { key: "process-key", directory: path.resolve("/work"), proc, init: null, sessionIds: new Set(["s1"]) },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"]])
    item.permissionOwners = new Map([["perm-mine", proc], ["perm-other", proc]])

    const result = await cancelAdapterTurn(item, executionBinding("s1", path.resolve("/work")))

    // The agent acknowledged the notification; ACP says nothing about whether
    // the prompt stopped, so neither fact may be claimed here.
    expect(result).toEqual({ execution: "unknown", cleanup: "unknown" })
    expect(responses).toEqual([{ id: "perm-mine", response: { outcome: { outcome: "cancelled" } } }])
    expect(proc.pendingPermissions.has("perm-mine")).toBe(false)
    expect(proc.pendingPermissions.has("perm-other")).toBe(true)
    expect(appended).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        agentSessionId: "agent-session-1",
        payload: {
          id: "permission.replied:perm-mine",
          type: "permission.replied",
          properties: { sessionID: "s1", requestID: "perm-mine", reply: "reject" },
        },
      }),
    ])
    expect(item.permissionOwners.has("perm-mine")).toBe(false)
    expect(item.permissionOwners.has("perm-other")).toBe(true)
  })

  test("abort failure interrupts only its session and preserves the shared process", async () => {
    const calls: string[] = []
    const proc = {
      alive: true,
      listenSubagents: () => () => {},
      hasSession: () => true,
      pendingPermissions: new Map(),
      async cancelAndWait() {
        calls.push("cancel")
        throw new Error("cancel failed")
      },
      dispose() {
        calls.push("dispose")
      },
    }
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      currentModel: string
      options: { connection: { kind: "process"; command: string }; harness: string }
      store: {
        getAgentSessionId: (id: string) => string | null
        getSessionOwnerKey: (id: string) => string | null
        markSessionInterrupted: (id: string, message?: string) => void
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
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
    item.store = {
      getAgentSessionId() {
        return "agent-session-1"
      },
      getSessionOwnerKey() {
        return "process-key"
      },
      markSessionInterrupted(id, message) {
        lost.push({ id, message })
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

    const result = await cancelAdapterTurn(item, executionBinding("s1", path.resolve("/work")))

    expect(result).toEqual({
      execution: "unknown",
      cleanup: "unknown",
      error: {
        code: "provider_unreachable",
        message: "ACP session cancellation was not acknowledged; its outcome is uncertain.",
      },
    })
    expect(calls).toEqual(["cancel"])
    expect(lost).toEqual([{
      id: "s1",
      message: "ACP session cancellation was not acknowledged; its outcome is uncertain.",
    }])
    expect(item.processes.get("process-key")?.proc).toBe(proc)
  })

  test("delete keeps a shared process alive while persisted siblings remain", async () => {
    const calls: string[] = []
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string | null
        getSessionOwnerKey: (id: string) => string | null
        listSessionsByOwnerKey: (key: string) => string[]
        deleteSession: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: { dispose: () => void }; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
    }>
    item.store = {
      getAgentSessionId() {
        return null
      },
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

    await item.deleteSession(executionBinding("s1", path.resolve("/work")))

    expect(calls).toEqual([])
    expect(item.processes.has("process-key")).toBe(true)
  })

  test("delete disposes a shared process when no in-memory or persisted siblings remain", async () => {
    const calls: string[] = []
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string | null
        getSessionOwnerKey: (id: string) => string | null
        listSessionsByOwnerKey: (key: string) => string[]
        deleteSession: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: { dispose: () => void }; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
    }>
    item.store = {
      getAgentSessionId() {
        return null
      },
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

    await item.deleteSession(executionBinding("s1", path.resolve("/work")))

    expect(calls).toEqual(["dispose"])
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
      connection: {
        kind: "process",
        command: "remote-acp",
        args: ["--stdio"],
        env: { ACP_TOKEN: "secret" },
      },
      harness: "openclaw",
      store: {} as AcpRuntimeStore,
      createTransport(input) {
        calls.push({
          directory: input.directory,
          command: input.command,
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
        command: "remote-acp",
        args: ["--stdio"],
        model: "",
        env: { ACP_TOKEN: "secret" },
      },
      "dispose",
    ])
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
      listenSubagents: () => () => {},
      hasSession: () => true,
      dispose() {},
    })
    const adapter = new ProtectedAcpAdapter({
      connection: {
        kind: "process",
        command: "/safe/bin/openclaw",
        args: ["--token", sentinel],
        env: { TOKEN: sentinel },
      },
      harness: "openclaw",
      store: {} as AcpRuntimeStore,
      createTransport,
      processObserver,
    })
    adapter.seedMcp([{
      name: "safe-mcp",
      command: "node",
      args: [sentinel],
      env: [{ name: "TOKEN", value: sentinel }],
    }])

    const harness = adapter.spawn(path.resolve("/work"), "harness")
    const probe = adapter.spawn(path.resolve("/work"), "probe")

    expect(descriptors.map((descriptor) => [descriptor.role, descriptor.pid, descriptor.parentOwnerId])).toEqual([
      ["harness", 456, undefined],
      ["mcp", undefined, descriptors[0].ownerId],
      ["probe", 456, undefined],
      ["mcp", undefined, descriptors[2].ownerId],
    ])
    expect(JSON.stringify(descriptors)).not.toContain(sentinel)
    harness.dispose()
    probe.dispose()
    expect(exits).toHaveLength(4)
  })

  test("rejects and rolls back config when a live ACP session rejects the update", async () => {
    const store = new MemoryRuntimeStore()
    store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "native-1" })
    store.updateSessionConfig("s1", {
      harness: { id: "codex", access: "connection" },
      model: { providerID: "codex", modelID: "gpt-5.5" },
      variant: "medium",
      agent: "build",
    })
    const item = new BoundProcessAdapter({ connection: { kind: "process", command: "example-acp" }, harness: "example", store })
    item.setModel("gpt-5.5")
    item.bound = new SyncRejectingProcess(
      path.resolve("/work"),
      "example-acp",
      [],
      "gpt-5.5",
      () => [],
      () => {},
      inertTransport,
      () => ({}),
    )

    await expect(item.updateSessionConfig(executionBinding("s1", path.resolve("/work")), { variant: "high" }))
      .rejects.toThrow("model rejected")
    expect(store.getSessionConfig("s1")?.variant).toBe("medium")
    item.bound.dispose()
    item.dispose()
  })

  test("sendMessage keeps the prompt model session scoped during process lookup", async () => {
    const calls: string[] = []
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
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
      model: { providerID: "connection:example", modelID: "gpt-5.5" },
    } as never, path.resolve("/work"), Date.now())) {
      break
    }

    expect(calls).toEqual(["getOrSpawnProcess"])
  })

  test("initialization timeout disposes the process", async () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
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
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
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
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentModel: string
      options: { connection: { kind: "process"; command: string }; harness: string }
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
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
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

  test("resume timeout quarantines its session without disposing the process", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "5"

    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        getSessionConfig: () => null
        markSessionInterrupted: () => void
        startTurn: (input: AgentRuntimeTurnStartInput) => ReturnType<typeof committedStartTurn>
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { connection: { kind: "process"; command: string }; harness: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      getOrSpawnProcess: () => Promise<{
        proc: {
          alive: boolean
          quarantineSession: () => void
          pendingPermissions: Map<string, never>
          cancelAndWait: () => Promise<void>
          listenSubagents: () => () => void
          hasSession: () => boolean
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
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
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
      getSessionConfig: () => null,
      markSessionInterrupted() {},
      startTurn(input) {
        return committedStartTurn(input)
      },
      appendEvent() {},
      bindSession() {},
    }
    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        alive: true,
        quarantineSession() { calls.push("quarantine") },
        pendingPermissions: new Map<string, never>(),
        async cancelAndWait() { calls.push("cancel") },
        listenSubagents: () => () => {},
        hasSession: () => true,
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
      for await (const event of executeTestTurn(item, "s1", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "connection:example", modelID: "default" },
      }, path.resolve("/work"))) {
        events.push(event.type)
      }

      expect(calls).toContain("resume")
      expect(calls).not.toContain("cancel")
      expect(calls).not.toContain("dispose")
      expect(events).toContain("session.error")
      expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
      expect(item.turnLifecycle.activeTurns.size).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  })

  test("a prompt failure leaves the shared process intact", async () => {
    // The process owns the only bound on a turn (see `ACPProcess.prompt`); the
    // runner must not add a wall clock of its own, so a prompt that outlives
    // the handshake timeout many times over is left alone until the process
    // itself gives up on it.
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        getSessionConfig: () => null
        markSessionInterrupted: () => void
        startTurn: (input: AgentRuntimeTurnStartInput) => ReturnType<typeof committedStartTurn>
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { connection: { kind: "process"; command: string }; harness: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      getOrSpawnProcess: () => Promise<{
        proc: {
          alive: boolean
          quarantineSession: () => void
          pendingPermissions: Map<string, never>
          cancelAndWait: () => Promise<void>
          listenSubagents: () => () => void
          hasSession: () => boolean
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
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
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
      getSessionConfig: () => null,
      markSessionInterrupted() {},
      startTurn(input) {
        return committedStartTurn(input)
      },
      appendEvent() {},
      bindSession() {},
    }
    item.getOrSpawnProcess = async () => ({
      isNew: false,
      proc: {
        alive: true,
        quarantineSession() { calls.push("quarantine") },
        pendingPermissions: new Map<string, never>(),
        async cancelAndWait() { calls.push("cancel") },
        listenSubagents: () => () => {},
        hasSession: () => true,
        permissionPushers: new Map<string, unknown>(),
        async resumeSession() {},
        async syncSession() {},
        async prompt() {
          calls.push("prompt")
          await new Promise((resolve) => setTimeout(resolve, 30))
          throw new Error("ACP prompt timed out after 5ms of inactivity")
        },
        async cancel() {
          calls.push("cancel")
        },
        dispose() {
          calls.push("dispose")
        },
      },
    })

    const prevHandshake = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "5"
    try {
      const events: string[] = []
      for await (const event of executeTestTurn(item, "s1", {
        parts: [{ type: "text", text: "hello" }],
        userMessageId: "user-1",
        assistantMessageId: "assistant-1",
        agent: "build",
        model: { providerID: "connection:example", modelID: "default" },
      }, path.resolve("/work"))) {
        events.push(event.type)
      }

      expect(calls).toContain("prompt")
      expect(calls).not.toContain("cancel")
      expect(calls).not.toContain("dispose")
      expect(events).toContain("session.error")
      expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
      expect(item.turnLifecycle.activeTurns.size).toBe(0)
    } finally {
      if (prevHandshake === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prevHandshake
    }
  })

  test("config apply defers restart while a turn is active", async () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        getSessionConfig: () => null
        markSessionInterrupted: () => void
        startTurn: (input: AgentRuntimeTurnStartInput) => ReturnType<typeof committedStartTurn>
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { connection: { kind: "process"; command: string }; harness: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      processes: Map<string, { directory: string; proc: unknown; init: null }>
      probe: null
      currentMcp: unknown[]
      currentEnv: Record<string, string>
      configRestartPending: boolean
      restart: () => void
      forgetSessionProcessBindings: () => void
      getOrSpawnProcess: () => Promise<{
        proc: {
          alive: boolean
          quarantineSession: () => void
          pendingPermissions: Map<string, never>
          cancelAndWait: () => Promise<void>
          listenSubagents: () => () => void
          hasSession: () => boolean
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
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
    item.turnLifecycle = createSessionTurnLifecycle()
    item.processes = new Map()
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
      getSessionConfig: () => null,
      markSessionInterrupted() {},
      startTurn(input) {
        return committedStartTurn(input)
      },
      appendEvent() {},
      bindSession() {},
    }
    const proc = {
      alive: true,
        quarantineSession() { calls.push("quarantine") },
        pendingPermissions: new Map<string, never>(),
        async cancelAndWait() { calls.push("cancel") },
        listenSubagents: () => () => {},
      hasSession: () => true,
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

    const iter = executeTestTurn(item, "s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "user-1",
      assistantMessageId: "assistant-1",
      agent: "build",
      model: { providerID: "connection:openclaw-active", modelID: "default" },
    }, path.resolve("/work"))[Symbol.asyncIterator]()

    expect((await iter.next()).value?.type).toBe("session.status")
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(true)
    expect(calls).toContain("prompt")

    await item.applyConfig({ mcp: {}, env: { OPENCLAW_TOKEN: "new" } })

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
    expect(calls).not.toContain("dispose")
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
    expect(item.turnLifecycle.activeTurns.size).toBe(0)

    await readiness

    expect(configReady).toBe(true)
    expect(calls).toContain("restart")
    expect(calls).toContain("forget")
    expect(item.configRestartPending).toBe(false)
  })

  test("unchanged config apply does not drain an active turn", async () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      options: { connection: { kind: "process"; command: string }; harness: string }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      restart: () => void
    }>

    const calls: string[] = []
    item.currentEnv = { OPENAI_API_KEY: "sk-same" }
    item.currentMcp = []
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "test-acp" }
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
      const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
        currentEnv: Record<string, string>
        currentMcp: unknown[]
        options: { connection: { kind: "process"; command: string; supportsMcpServers?: boolean }; harness: string }
        turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
        restart: () => void
        forgetSessionProcessBindings: () => void
      }>
      item.currentEnv = {}
      item.currentMcp = []
      item.options = {
        connection: {
          kind: "process",
          command: "fake-acp",
          ...(supportsMcpServers !== undefined ? { supportsMcpServers } : {}),
        },
        harness: "openclaw-mcp",
      }
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

  test("a completed probe with no config channel returns an authoritative empty option list", async () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      options: { connection: { kind: "process"; command: string }; harness: string }
      probe: null
      getOrSpawnProbe: () => Promise<{ alive: boolean; cachedConfigOptions: null; configOptions: (id: string) => { options: [] } }>
      boot: () => Promise<string>
    }>
    item.options = { connection: { kind: "process", command: "fake-acp" }, harness: "openclaw-probe" }
    item.probe = null
    item.getOrSpawnProbe = async () => ({ alive: true, cachedConfigOptions: null, configOptions: () => ({ options: [] }) })
    item.boot = async () => "probe-session"
    expect(await item.probeConfigOptions(path.resolve("/work"))).toEqual({ options: [] })
  })

})

describe("AcpHarnessAdapter fork support", () => {
  test("does not fabricate a fork when the ACP process does not advertise fork support", async () => {
    const calls: unknown[] = []
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      currentMcp: unknown[]
      store: {
        getSession: (id: string) => { title?: string } | null
        getAgentSessionId: (id: string) => string | null
        bindSession: (input: unknown) => void
      }
      getOrSpawnProcess: () => Promise<{
        isNew: boolean
        proc: {
          listenSubagents: () => () => void
          hasSession: () => boolean
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
        listenSubagents: () => () => {},
        hasSession: () => true,
        supportsForkSession: () => false,
        async forkSession() {
          throw new Error("should not call unsupported ACP fork")
        },
      },
    })

    await expect(item.forkSession(executionBinding("s1", path.resolve("/work")), "m1")).rejects.toThrow(
      "ACP agent does not advertise session fork support",
    )
    expect(calls).toEqual([])
  })

  test("binds a fork to the agent session returned by session/fork", async () => {
    const calls: unknown[] = []
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
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

    const result = await item.forkSession(executionBinding("s1", path.resolve("/work")), "m1")

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

for (const fails of [false, true]) {
  test(`concurrent draft discovery shares one session creation (failure=${fails})`, async () => {
    const item = Object.create(LifecycleTestAdapter.prototype) as WithInternals<AcpHarnessAdapter, {
      peekAcpConfigOptions: () => null
      getOrSpawnProbe: () => Promise<ACPProcess>
      boot: () => Promise<string>
    }>
    const proc = { cachedConfigOptions: null, configOptions: () => ({ options: [] }) } as unknown as ACPProcess
    item.peekAcpConfigOptions = () => null
    item.getOrSpawnProbe = async () => proc
    let boots = 0
    let settle!: () => void
    const gate = new Promise<void>((resolve) => { settle = resolve })
    item.boot = async () => { boots++; await gate; if (fails) throw new Error("discovery failed"); return "probe-session" }
    const first = item.probeAcpConfigOptions(path.resolve("/work"))
    const second = item.probeAcpConfigOptions(path.resolve("/work"))
    await Bun.sleep(0)
    expect(boots).toBe(1)
    settle()
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(fails ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"])
    if (fails) {
      item.getOrSpawnProbe = async () => ({ cachedConfigOptions: null, configOptions: () => ({ options: [] }) }) as unknown as ACPProcess
      item.boot = async () => { boots++; return "replacement-probe-session" }
      expect(await item.probeAcpConfigOptions(path.resolve("/work"))).toEqual({ options: [] })
      expect(boots).toBe(2)
    }
  })
}
