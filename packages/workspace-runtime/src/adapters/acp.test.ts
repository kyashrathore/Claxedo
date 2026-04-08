import { describe, expect, it } from "bun:test"
import { ACPAdapter } from "./acp"

function adapter() {
  const out = Object.create(ACPAdapter.prototype) as ACPAdapter & {
    busySessions: Set<string>
    currentModel: string
    options: { binary: string }
    sessions: Map<string, { directory: string; proc: null; init: null }>
    probe: null
  }
  out.busySessions = new Set()
  out.currentModel = ""
  out.options = { binary: "fake-acp" }
  out.sessions = new Map()
  out.probe = null
  return out
}

describe("ACPAdapter", () => {
  it("restores and syncs an existing ACP session before prompting on a fresh process", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const seen: string[] = []
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: (id: string, directory: string) => Promise<void>
          syncSession: (id: string, input: unknown) => Promise<void>
          prompt: (id: string, input: unknown, onUpdate: (update: unknown) => void) => Promise<{ stopReason: "end_turn" }>
        }
        isNew: boolean
      }>
    }

    item.store = {
      getAgentSessionId() {
        return "acp-1"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession(input) {
        calls.push({ name: "bindSession", args: [input] })
      },
      consumeRecoveryError() {
        return null
      },
      startTurn(input) {
        calls.push({ name: "startTurn", args: [input] })
      },
      appendEvent(input) {
        seen.push(input.payload.type)
      },
    }

    item.getOrSpawnProcess = async (_id, _directory) => ({
      isNew: true,
      proc: {
        permissionPushers: new Map(),
        async resumeSession(id, directory) {
          calls.push({ name: "resumeSession", args: [id, directory] })
        },
        async syncSession(id, input) {
          calls.push({ name: "syncSession", args: [id, input] })
        },
        async prompt(id, input, _onUpdate) {
          calls.push({ name: "prompt", args: [id, input] })
          return { stopReason: "end_turn" }
        },
      },
    })

    const out: string[] = []
    for await (const event of item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "fast",
      system: "sys",
    }, "/work", Date.now())) {
      out.push(event.type)
    }

    expect(calls.map((item) => item.name)).toEqual([
      "startTurn",
      "resumeSession",
      "syncSession",
      "prompt",
    ])
    expect(out).toContain("message.completed")
    expect(out).toContain("session.idle")
    expect(seen).toContain("message.completed")
    expect(seen).toContain("session.idle")
  })

  it("applies prompt response usage to the final assistant message before idle", async () => {
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: (id: string, directory: string) => Promise<void>
          syncSession: (id: string, input: unknown) => Promise<void>
          prompt: (
            id: string,
            input: unknown,
            onUpdate: (update: unknown) => void,
          ) => Promise<{
            stopReason: "end_turn"
            usage: {
              inputTokens: number
              outputTokens: number
              totalTokens: number
              thoughtTokens: number
              cachedReadTokens: number
              cachedWriteTokens: number
            }
          }>
        }
        isNew: boolean
      }>
    }

    item.store = {
      getAgentSessionId() {
        return "acp-1"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession() {},
      consumeRecoveryError() {
        return null
      },
      startTurn() {},
      appendEvent() {},
    }

    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        permissionPushers: new Map(),
        async resumeSession() {},
        async syncSession() {},
        async prompt() {
          return {
            stopReason: "end_turn",
            usage: {
              inputTokens: 10,
              outputTokens: 20,
              totalTokens: 40,
              thoughtTokens: 5,
              cachedReadTokens: 3,
              cachedWriteTokens: 2,
            },
          }
        },
      },
    })

    const out: Array<{ type: string; properties?: Record<string, unknown> }> = []
    for await (const event of item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      variant: "fast",
    }, "/work", Date.now())) {
      out.push(event as { type: string; properties?: Record<string, unknown> })
    }

    const msgs = out.filter((event) => event.type === "message.updated")
    const last = msgs.at(-1)
    const info = last?.properties?.info as
      | { id: string; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }
      | undefined

    expect(info?.id).toBe("a1")
    expect(info?.tokens).toEqual({
      input: 10,
      output: 20,
      reasoning: 5,
      cache: { read: 3, write: 2 },
    })
    expect(out.at(-1)?.type).toBe("session.idle")
  })

  it("caches resolved MCP when config updates only auth", async () => {
    const item = adapter() as ACPAdapter & {
      currentMcp: unknown[]
      restart: () => void
    }
    let restarts = 0
    item.currentMcp = []
    item.restart = () => {
      restarts++
    }

    await item.applyConfig({
      mcp: {
        "claxedo-mcp": {
          name: "claxedo-mcp",
          source: "managed",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: { OPENCODE_API_URL: "http://localhost:3001" },
        },
      },
      auth: { "claude-acp": "sk-test" },
    })

    expect(item.currentMcp).toEqual([{
      name: "claxedo-mcp",
      command: "node",
      args: ["server.js"],
      env: [{ name: "OPENCODE_API_URL", value: "http://localhost:3001" }],
    }])
    expect(restarts).toBe(1)
  })

  it("recreates the ACP session when resume says resource not found after restart", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: (id: string, directory: string) => Promise<void>
          newSession: (directory: string, title?: string) => Promise<string>
          syncSession: (id: string, input: unknown) => Promise<void>
          prompt: (id: string, input: unknown, onUpdate: (update: unknown) => void) => Promise<{ stopReason: "end_turn" }>
        }
        isNew: boolean
      }>
    }

    item.store = {
      getAgentSessionId() {
        return "acp-stale"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession(input) {
        calls.push({ name: "bindSession", args: [input] })
      },
      consumeRecoveryError() {
        return null
      },
      startTurn(input) {
        calls.push({ name: "startTurn", args: [input] })
      },
      appendEvent(_input) {},
    }

    item.getOrSpawnProcess = async (_id, _directory) => ({
      isNew: true,
      proc: {
        permissionPushers: new Map(),
        async resumeSession(id, directory) {
          calls.push({ name: "resumeSession", args: [id, directory] })
          throw new Error("Resource not found: acp-stale")
        },
        async newSession(directory, title) {
          calls.push({ name: "newSession", args: [directory, title] })
          return "acp-new"
        },
        async syncSession(id, input) {
          calls.push({ name: "syncSession", args: [id, input] })
        },
        async prompt(id, input, _onUpdate) {
          calls.push({ name: "prompt", args: [id, input] })
          return { stopReason: "end_turn" }
        },
      },
    })

    const out: string[] = []
    for await (const event of item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, "/work", Date.now())) {
      out.push(event.type)
    }

    expect(calls.map((item) => item.name)).toEqual([
      "startTurn",
      "resumeSession",
      "newSession",
      "bindSession",
      "syncSession",
      "prompt",
    ])
    expect(calls[3]?.args[0]).toMatchObject({
      sessionId: "s1",
      directory: "/work",
      title: "Saved",
      agentSessionId: "acp-new",
    })
    expect(calls[4]?.args[0]).toBe("acp-new")
    expect(calls[5]?.args[0]).toBe("acp-new")
    expect(out).toContain("session.idle")
  })

  it("emits recovering status instead of terminal error for recoverable ACP restarts", async () => {
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: (id: string, directory: string) => Promise<void>
          syncSession: (id: string, input: unknown) => Promise<void>
          prompt: (id: string, input: unknown, onUpdate: (update: unknown) => void) => Promise<{ stopReason: "end_turn" }>
        }
        isNew: boolean
      }>
    }

    item.store = {
      getAgentSessionId() {
        return "acp-1"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession() {},
      consumeRecoveryError() {
        return "ACP process restarted; pending interactive state must be rerun"
      },
      startTurn() {},
      appendEvent() {},
    }

    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        permissionPushers: new Map(),
        async resumeSession() {},
        async syncSession() {},
        async prompt() {
          return { stopReason: "end_turn" }
        },
      },
    })

    const out: Array<{ type: string; status?: unknown }> = []
    for await (const event of item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, "/work", Date.now())) {
      out.push({
        type: event.type,
        ...("status" in event.properties ? { status: event.properties.status } : {}),
      })
    }

    expect(out[0]).toMatchObject({
      type: "session.status",
      status: {
        type: "recovering",
        kind: "process_restart",
        message: "ACP process restarted; pending interactive state must be rerun",
      },
    })
    expect(out.some((item) => item.type === "session.error")).toBe(false)
    expect(out.some((item) => item.type === "session.idle")).toBe(true)
  })

  it("retries the prompt with a replacement ACP session when prompt says resource not found", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = []
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          syncSession: (id: string, input: unknown) => Promise<void>
          newSession: (directory: string, title?: string) => Promise<string>
          prompt: (id: string, input: unknown, onUpdate: (update: unknown) => void) => Promise<{ stopReason: "end_turn" }>
        }
        isNew: boolean
      }>
    }

    item.store = {
      getAgentSessionId() {
        return "acp-stale"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession(input) {
        calls.push({ name: "bindSession", args: [input] })
      },
      consumeRecoveryError() {
        return null
      },
      startTurn(input) {
        calls.push({ name: "startTurn", args: [input] })
      },
      appendEvent(_input) {},
    }

    let promptCount = 0
    item.getOrSpawnProcess = async (_id, _directory) => ({
      isNew: false,
      proc: {
        permissionPushers: new Map(),
        async syncSession(id, input) {
          calls.push({ name: "syncSession", args: [id, input] })
        },
        async newSession(directory, title) {
          calls.push({ name: "newSession", args: [directory, title] })
          return "acp-new"
        },
        async prompt(id, input, _onUpdate) {
          calls.push({ name: "prompt", args: [id, input] })
          promptCount++
          if (promptCount === 1) throw new Error("Resource not found")
          return { stopReason: "end_turn" }
        },
      },
    })

    const out: string[] = []
    for await (const event of item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, "/work", Date.now())) {
      out.push(event.type)
    }

    expect(calls.map((item) => item.name)).toEqual([
      "startTurn",
      "syncSession",
      "prompt",
      "newSession",
      "bindSession",
      "syncSession",
      "prompt",
    ])
    expect(calls[4]?.args[0]).toMatchObject({
      sessionId: "s1",
      directory: "/work",
      title: "Saved",
      agentSessionId: "acp-new",
    })
    expect(out).toContain("session.idle")
  })

  it("spawns separate ACP processes for separate local sessions", async () => {
    const item = adapter() as ACPAdapter & {
      store: {
        getSession: (id: string) => { id: string } | null
        processLostSession: (id: string) => void
      }
      make: (dead?: () => void) => {
        initialize: () => Promise<void>
        dispose: () => void
        alive: boolean
      }
    }
    const seen: string[] = []
    item.store = {
      getSession(id) {
        return { id }
      },
      processLostSession() {},
    }

    item.make = () => ({
      alive: true,
      async initialize() {
        seen.push("init")
      },
      dispose() {},
    })

    const first = await (item as any).getOrSpawnProcess("s1", "/work")
    const second = await (item as any).getOrSpawnProcess("s2", "/work")
    const again = await (item as any).getOrSpawnProcess("s1", "/work")

    expect(seen).toEqual(["init", "init"])
    expect(first.proc).not.toBe(second.proc)
    expect(first.proc).toBe(again.proc)
  })

  it("clears a persisted permission reply even after reload lost the live ACP process", async () => {
    const calls: Array<{ sessionId: string; payload: { type: string; properties: { requestID: string } } }> = []
    const item = adapter() as ACPAdapter & {
      store: {
        listPermissions: (directory: string) => Array<{ id: string; sessionID: string }>
        appendEvent: (input: { sessionId: string; payload: { type: string; properties: { requestID: string } } }) => void
      }
      sessions: Map<string, { proc?: { alive: boolean; pendingPermissions: Map<string, unknown>; respondPermission: (...args: unknown[]) => void } }>
    }

    item.store = {
      listPermissions() {
        return [{ id: "perm-1", sessionID: "s1" }]
      },
      appendEvent(input) {
        calls.push(input)
      },
    }
    item.sessions = new Map()

    await item.respondPermission("perm-1", "allow_once", "/work")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionId).toBe("s1")
    expect(calls[0]?.payload.type).toBe("permission.replied")
    expect(calls[0]?.payload.properties.requestID).toBe("perm-1")
  })

  it("hides orphaned ACP permissions after reload and marks the session recovering", async () => {
    const stale: string[] = []
    const recovering: Array<{ id: string; message: string }> = []
    const item = adapter() as ACPAdapter & {
      store: {
        listPermissions: (directory: string) => Array<{ id: string; sessionID: string }>
        stalePermission: (id: string) => void
        markRecovering: (id: string, message: string) => void
      }
      sessions: Map<string, { proc?: { alive: boolean; pendingPermissions: Map<string, unknown> } }>
    }

    item.store = {
      listPermissions() {
        return [
          { id: "perm-live", sessionID: "s-live" },
          { id: "perm-stale", sessionID: "s-stale" },
        ]
      },
      stalePermission(id) {
        stale.push(id)
      },
      markRecovering(id, message) {
        recovering.push({ id, message })
      },
    }
    item.sessions = new Map([
      ["s-live", { proc: { alive: true, pendingPermissions: new Map([["perm-live", {}]]) } }],
      ["s-stale", { proc: { alive: false, pendingPermissions: new Map() } }],
    ])

    expect(await item.listPermissions("/work")).toEqual([{ id: "perm-live", sessionID: "s-live" }])
    expect(stale).toEqual(["perm-stale"])
    expect(recovering).toEqual([{
      id: "s-stale",
      message: "ACP process restarted; pending interactive state must be rerun",
    }])
  })

  it("fails the turn instead of hanging forever when cold-start resume stalls", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "10"
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: (id: string, directory: string) => Promise<void>
          syncSession: (id: string, input: unknown) => Promise<void>
          prompt: (id: string, input: unknown, onUpdate: (update: unknown) => void) => Promise<{ stopReason: "end_turn" }>
        }
        isNew: boolean
      }>
    }

    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })

    item.store = {
      getAgentSessionId() {
        return "acp-1"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession() {},
      consumeRecoveryError() {
        return null
      },
      startTurn() {},
      appendEvent() {},
    }

    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        permissionPushers: new Map(),
        async resumeSession() {
          await gate
        },
        async syncSession() {},
        async prompt() {
          return { stopReason: "end_turn" }
        },
      },
    })

    const iter = item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, "/work", Date.now())[Symbol.asyncIterator]()
    try {
      const seen: string[] = []
      const until = Date.now() + 40
      while (Date.now() < until) {
        const row = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<{ type: string }> | null>((resolve) => setTimeout(() => resolve(null), 5)),
        ])
        if (!row) continue
        if (row.done) break
        seen.push(row.value.type)
        if (row.value.type === "session.error") break
      }
      expect(seen).toContain("session.error")
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
      open()
      let row = await iter.next()
      while (!row.done) {
        row = await iter.next()
      }
    }
  })

  it("fails the turn instead of hanging forever when cold-start sync stalls", async () => {
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "10"
    const item = adapter() as ACPAdapter & {
      store: {
        getAgentSessionId: (id: string) => string
        getSession: (id: string) => { title?: string | null } | null
        processLostSession: (id: string) => void
        bindSession: (input: unknown) => void
        consumeRecoveryError: (id: string) => string | null
        startTurn: (input: unknown) => void
        appendEvent: (input: { payload: { type: string } }) => void
      }
      getOrSpawnProcess: (id: string, directory: string) => Promise<{
        proc: {
          permissionPushers: Map<string, unknown>
          resumeSession: (id: string, directory: string) => Promise<void>
          syncSession: (id: string, input: unknown) => Promise<void>
          prompt: (id: string, input: unknown, onUpdate: (update: unknown) => void) => Promise<{ stopReason: "end_turn" }>
        }
        isNew: boolean
      }>
    }

    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })

    item.store = {
      getAgentSessionId() {
        return "acp-1"
      },
      getSession() {
        return { title: "Saved" }
      },
      processLostSession() {},
      bindSession() {},
      consumeRecoveryError() {
        return null
      },
      startTurn() {},
      appendEvent() {},
    }

    item.getOrSpawnProcess = async () => ({
      isNew: true,
      proc: {
        permissionPushers: new Map(),
        async resumeSession() {},
        async syncSession() {
          await gate
        },
        async prompt() {
          return { stopReason: "end_turn" }
        },
      },
    })

    const iter = item._sendMessage("s1", {
      parts: [{ type: "text", text: "hello" }],
      userMessageId: "u1",
      assistantMessageId: "a1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }, "/work", Date.now())[Symbol.asyncIterator]()
    try {
      const seen: string[] = []
      const until = Date.now() + 40
      while (Date.now() < until) {
        const row = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<{ type: string }> | null>((resolve) => setTimeout(() => resolve(null), 5)),
        ])
        if (!row) continue
        if (row.done) break
        seen.push(row.value.type)
        if (row.value.type === "session.error") break
      }
      expect(seen).toContain("session.error")
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
      open()
      let row = await iter.next()
      while (!row.done) {
        row = await iter.next()
      }
    }
  })

})
