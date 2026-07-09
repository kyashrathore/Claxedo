import { describe, expect, test } from "bun:test"
import { AcpHarnessAdapter, type AcpRuntimeStore, type ACPTransport } from "./index"
import { generateAITitle } from "./title"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"

function adapter() {
  const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
    store: {
      listPermissions: (directory: string) => Array<{ id: string; sessionID: string }>
      appendEvent: (input: unknown) => void
    }
    sessions: Map<string, { proc: { alive: boolean; pendingPermissions: Map<string, unknown>; respondPermission: (id: string, response: unknown) => void } }>
  }
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

    await item.respondPermission("perm-1", "deny", "/work")

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

    await item.respondPermission("perm-1", "allow_always", "/work")

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

    await expect(item.listPermissions("/work")).resolves.toEqual([{ id: "perm-1", sessionID: "session-1" }])
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

    await item.respondPermission("perm-1", "allow_always", "/work")

    expect(selected).toEqual([{ outcome: { outcome: "selected", optionId: "allow-session" } }])
  })
})

describe("AcpHarnessAdapter active turn cleanup", () => {
  test("process keys are opaque fingerprints without raw launch secrets", () => {
    const item = new AcpHarnessAdapter({
      binary: "fake-acp",
      type: "codex-acp",
      args: ["--api-key", "arg-secret"],
      env: { ACP_TOKEN: "env-secret" },
      store: {} as AcpRuntimeStore,
    }) as AcpHarnessAdapter & {
      currentMcp: unknown[]
      processKey: (directory: string) => string
    }
    item.currentMcp = [{
      name: "private-mcp",
      command: "node",
      args: ["mcp-secret"],
      env: { MCP_TOKEN: "mcp-env-secret" },
    }]

    const key = item.processKey("/work")

    expect(key.startsWith("acp:")).toBe(true)
    expect(key).not.toContain("arg-secret")
    expect(key).not.toContain("env-secret")
    expect(key).not.toContain("mcp-secret")
    expect(key).not.toContain("mcp-env-secret")
    expect(key).not.toContain("--api-key")
  })

  test("process-level config changes ignore stale stored process keys", () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      currentModel: string
      options: { binary: string; type: "codex-acp" }
      store: { getSessionOwnerKey: (id: string) => string | null }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      processes: Map<string, unknown>
      sessionProcesses: Map<string, string>
      ignoreStoredProcessKeys: boolean
      keyForSession: (id: string, directory: string) => string
    }
    item.currentEnv = { ACP_TOKEN: "old" }
    item.currentMcp = []
    item.currentModel = ""
    item.options = { binary: "fake-acp", type: "codex-acp" }
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
    const next = item.keyForSession("s1", "/work")

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
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      currentModel: string
      options: { binary: string; type: "codex-acp" }
      store: {
        getAgentSessionId: (id: string) => string | null
        getSessionOwnerKey: (id: string) => string | null
        markSessionsInterruptedByOwner: (key: string, message?: string) => void
        stalePermission: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: typeof proc | null; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
      permissionOwners: Map<string, typeof proc>
    }
    const lost: unknown[] = []
    item.currentEnv = {}
    item.currentMcp = []
    item.currentModel = ""
    item.options = { binary: "fake-acp", type: "codex-acp" }
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
      { key: "process-key", directory: "/work", proc, init: null, sessionIds: new Set(["s1", "s2"]) },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"], ["s2", "process-key"]])
    item.permissionOwners = new Map([["perm-1", proc]])

    const result = await item.abort("s1", "/work")

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
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      store: {
        getSessionOwnerKey: (id: string) => string | null
        listSessionsByOwnerKey: (key: string) => string[]
        deleteSession: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: { dispose: () => void }; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
    }
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
        directory: "/work",
        proc: { dispose: () => calls.push("dispose") },
        init: null,
        sessionIds: new Set(["s1"]),
      },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"]])

    await item.deleteSession("s1", "/work")

    expect(calls).toEqual(["delete:s1"])
    expect(item.processes.has("process-key")).toBe(true)
  })

  test("delete disposes a shared process when no in-memory or persisted siblings remain", async () => {
    const calls: string[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      store: {
        getSessionOwnerKey: (id: string) => string | null
        listSessionsByOwnerKey: (key: string) => string[]
        deleteSession: (id: string) => void
      }
      processes: Map<string, { key: string; directory: string; proc: { dispose: () => void }; init: null; sessionIds: Set<string> }>
      sessionProcesses: Map<string, string>
    }
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
        directory: "/work",
        proc: { dispose: () => calls.push("dispose") },
        init: null,
        sessionIds: new Set(["s1"]),
      },
    ]])
    item.sessionProcesses = new Map([["s1", "process-key"]])

    await item.deleteSession("s1", "/work")

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
      type: "codex-acp",
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

  test("passes the selected model to Codex ACP process args", () => {
    const calls: unknown[] = []
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
        calls.push(input.args)
        return transport
      },
    })

    item.setModel("gpt-5.5")
    ;(item as unknown as { make: () => unknown }).make()

    expect(calls).toEqual([["-c", "service_tier=\"fast\"", "-c", "model=\"gpt-5.5\""]])
  })

  test("session config model patch updates Codex ACP process args", async () => {
    const calls: unknown[] = []
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
      store: {
        updateSessionConfig() {
          return {
            harness: { id: "codex", access: "acp" },
            model: { providerID: "codex-acp", modelID: "gpt-5.5" },
            variant: null,
            agent: "build",
          }
        },
        getAgentSessionId() {
          return undefined
        },
      } as AcpRuntimeStore,
      createTransport(input) {
        calls.push(input.args)
        return transport
      },
    })

    await item.updateSessionConfig("s1", {
      model: { providerID: "codex-acp", modelID: "gpt-5.5" },
    }, "/work")
    ;(item as unknown as { make: () => unknown }).make()

    expect(calls).toEqual([["-c", "service_tier=\"fast\"", "-c", "model=\"gpt-5.5\""]])
  })

  test("sendMessage applies the prompt model before process lookup", async () => {
    const calls: string[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      store: {
        getAgentSessionId: () => string
        getSession: () => { title: string }
      }
      setModel: (model: string) => void
      getOrSpawnProcess: () => Promise<never>
    }
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
    } as never, "/work", Date.now())) {
      break
    }

    expect(calls).toEqual(["setModel:gpt-5.5", "getOrSpawnProcess"])
  })

  test("initialization timeout disposes the process", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      initialize: (proc: { initialize: () => Promise<void>; dispose: () => void }, ms: number) => Promise<void>
    }
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
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      initialize: (proc: {
        initialize: () => Promise<void>
        dispose: () => void
        failureDetail: () => string
      }, ms: number) => Promise<void>
    }

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
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      currentModel: string
      options: { binary: string; type: "codex-acp" }
      store: {
        bindSession: () => void
        updateSessionConfig: () => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          newSession: (directory: string, title?: string) => Promise<string>
          dispose: () => void
        }
      }>
    }
    const calls: string[] = []
    item.currentModel = ""
    item.options = { binary: "fake-acp", type: "codex-acp" }
    item.store = {
      bindSession() {
        calls.push("bind")
      },
      updateSessionConfig() {
        calls.push("config")
      },
    }
    item.getOrSpawnProcess = async (_id, directory) => {
      expect(directory).toBe("/work")
      return {
        proc: {
          async newSession(dir, title) {
            expect(dir).toBe("/work")
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
      await expect(item.createSession("/work", "Test")).rejects.toThrow("ACP newSession timed out after 5ms")

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

    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { binary: string; type: "codex-acp" }
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
    }
    const calls: string[] = []
    item.options = { binary: "fake-acp", type: "codex-acp" }
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
      }, "/work")) {
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

    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { binary: string; type: "codex-acp" }
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
    }
    const calls: string[] = []
    item.options = { binary: "fake-acp", type: "codex-acp" }
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
      }, "/work")) {
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
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: unknown) => void
        bindSession: (input: unknown) => void
      }
      options: { binary: string; type: "codex-acp" }
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
    }

    const calls: string[] = []
    item.options = { binary: "fake-acp", type: "codex-acp" }
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
    }, "/work")[Symbol.asyncIterator]()

    expect((await iter.next()).value?.type).toBe("session.status")
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(true)
    expect(calls).toContain("prompt")

    await item.applyConfig({ mcp: {}, auth: { OPENAI_API_KEY: "sk-new" } })

    expect(calls).not.toContain("restart")
    expect(item.configRestartPending).toBe(true)
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
    expect(calls).not.toContain("restart")
    expect(item.turnLifecycle.busySessions.has("s1")).toBe(false)
    expect(item.turnLifecycle.activeTurns.size).toBe(0)

    await item.applyConfig({ mcp: {}, auth: { OPENAI_API_KEY: "sk-new" } })

    expect(calls).toContain("restart")
    expect(calls).toContain("forget")
    expect(item.configRestartPending).toBe(false)
  })

  test("unchanged config apply does not drain an active turn", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      options: { binary: string; type: "codex-acp" }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      restart: () => void
    }

    const calls: string[] = []
    item.currentEnv = { OPENAI_API_KEY: "sk-same" }
    item.currentMcp = []
    item.options = { binary: "fake-acp", type: "codex-acp" }
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

  test("claude oauth config applies as Claude Code oauth env", async () => {
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      currentEnv: Record<string, string>
      currentMcp: unknown[]
      options: { binary: string; type: "claude-acp" }
      turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
      restart: () => void
      forgetSessionProcessBindings: () => void
    }

    const calls: string[] = []
    item.currentEnv = {}
    item.currentMcp = []
    item.options = { binary: "fake-acp", type: "claude-acp" }
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
    const intervals: ReturnType<typeof setInterval>[] = []
    let cleared = 0
    globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = originalSetInterval(handler, timeout, ...args)
      intervals.push(id)
      return id
    }) as typeof setInterval
    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      if (id && intervals.includes(id)) cleared++
      return originalClearInterval(id)
    }) as typeof clearInterval

    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
      sessions: Map<string, unknown>
      probe: null
      getOrSpawnProbe: () => Promise<{ alive: boolean; cachedConfigOptions: unknown[] | null }>
      boot: () => Promise<string>
    }
    item.sessions = new Map()
    item.probe = null
    item.getOrSpawnProbe = async () => ({ alive: true, cachedConfigOptions: null })
    item.boot = async () => "probe-session"

    try {
      await expect(item.probeConfigOptions("/work")).rejects.toThrow("ACP harness did not return live config options")
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
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
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
    }
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

    await expect(item.forkSession("s1", "m1", "/work")).rejects.toThrow(
      "ACP agent does not advertise session fork support",
    )
    expect(calls).toEqual([])
  })

  test("binds a fork to the agent session returned by session/fork", async () => {
    const calls: unknown[] = []
    const item = Object.create(AcpHarnessAdapter.prototype) as AcpHarnessAdapter & {
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
    }
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

    const result = await item.forkSession("s1", "m1", "/work")

    expect(typeof result.id).toBe("string")
    expect(calls).toEqual([
      { resume: { agentSessionId: "agent_original", directory: "/work" } },
      {
        fork: {
          agentSessionId: "agent_original",
          directory: "/work",
        },
      },
      expect.objectContaining({
        directory: "/work",
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
        boot: async (item) => item.newSession("/work"),
      }, "s1", "/work", "please add tests")

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
    const store = {
      getSession() {
        return null
      },
      appendEvent(input: { payload: { type: string; properties: { info?: { title?: string } } } }) {
        persisted.push(input.payload.properties.info?.title ?? input.payload.type)
      },
    }
    const eventHub = {
      publishGlobal(event: { payload: { type: string; properties: { info?: { title?: string } } } }) {
        global.push(event.payload.properties.info?.title ?? event.payload.type)
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
      boot: async (item) => item.newSession("/work"),
    }, "s1", "/work", "please add tests")

    expect(persisted).toEqual(["Better Title"])
    expect(global).toEqual(["Better Title"])
  })
})
