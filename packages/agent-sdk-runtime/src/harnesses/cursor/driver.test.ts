import { describe, expect, test } from "bun:test"
import {
  createCursorSdkDriver,
  cursorPluginLocalOptions,
  cursorPluginRoots,
  cursorTurnPrompt,
  ingestCursorSdkMessage,
} from "./driver"
import type { AgentProcessDescriptor, AgentProcessObserver } from "../../process-observer"

describe("Cursor SDK driver", () => {
  test("enables Cursor's native plugin setting source only for materialized plugin roots", () => {
    expect(cursorPluginRoots({ pluginRoots: ["/managed/one", "/managed/one", "/managed/two"] }))
      .toEqual(["/managed/one", "/managed/two"])
    expect(cursorPluginLocalOptions(["/managed/one"])).toEqual({ settingSources: ["plugins"] })
    expect(cursorPluginLocalOptions([])).toEqual({})
    expect(() => cursorPluginRoots({ pluginRoots: [""] })).toThrow("non-empty paths")
  })

  test("passes the plugin setting source through the real create-session driver entrypoint", async () => {
    const created: unknown[] = []
    const agent = {
      agentId: "cursor-agent-1",
      close() {},
    }
    const driver = createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
    } as never, {
      loadSdk: async () => ({
        Agent: {
          async create(options: unknown) {
            created.push(options)
            return agent
          },
        },
        Cursor: { models: { list: async () => [] } },
      } as never),
    })
    await driver.applyConfig({ launch: { pluginRoots: ["/managed/cursor/plugin"] } })
    await driver.createAgentSession({ directory: "/workspace", model: "auto", sessionId: "session-a" })

    expect(created).toMatchObject([{
      local: {
        cwd: "/workspace",
        settingSources: ["plugins"],
      },
    }])
  })

  function probeDriver(created: unknown[]) {
    return createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
    } as never, {
      loadSdk: async () => ({
        Agent: {
          async create(options: unknown) {
            created.push(options)
            return { agentId: "cursor-agent-1", close() {} }
          },
        },
        Cursor: { models: { list: async () => [] } },
      } as never),
    })
  }

  const cursorProjection = {
    baseUrl: "http://127.0.0.1:2595/bindings/beef",
    placeholder: "signed-cursor-placeholder",
    authMode: "bearer" as const,
    expiresAt: 1_800_000_000_000,
  }

  test("a bound Cursor account sets the SDK's backend and carries the placeholder", async () => {
    const previous = process.env.CURSOR_BACKEND_URL
    const created: unknown[] = []
    const driver = probeDriver(created)
    try {
      await driver.applyConfig({ auth: { "cursor-sdk": cursorProjection } })

      expect(process.env.CURSOR_BACKEND_URL).toBe("http://127.0.0.1:2595/bindings/beef")
      await driver.createAgentSession({ directory: "/workspace", model: "auto", sessionId: "session-b" })
      expect(created).toMatchObject([{ apiKey: "signed-cursor-placeholder" }])

      await driver.applyConfig({ auth: {} })
      expect(process.env.CURSOR_BACKEND_URL).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.CURSOR_BACKEND_URL
      else process.env.CURSOR_BACKEND_URL = previous
    }
  })

  test("a projection for another harness leaves Cursor on the machine's own key", async () => {
    const previous = { url: process.env.CURSOR_BACKEND_URL, key: process.env.CURSOR_API_KEY }
    const created: unknown[] = []
    const driver = probeDriver(created)
    process.env.CURSOR_API_KEY = "machine-cursor-key"
    try {
      await driver.applyConfig({ auth: { "claude-sdk": cursorProjection } })

      expect(process.env.CURSOR_BACKEND_URL).toBeUndefined()
      await driver.createAgentSession({ directory: "/workspace", model: "auto", sessionId: "session-c" })
      expect(created).toMatchObject([{ apiKey: "machine-cursor-key" }])
    } finally {
      if (previous.url === undefined) delete process.env.CURSOR_BACKEND_URL
      else process.env.CURSOR_BACKEND_URL = previous.url
      if (previous.key === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = previous.key
    }
  })

  test("an unavailable Cursor account fails the turn instead of using the machine's key", async () => {
    const previous = process.env.CURSOR_API_KEY
    const created: unknown[] = []
    const driver = probeDriver(created)
    process.env.CURSOR_API_KEY = "machine-cursor-key"
    try {
      await driver.applyConfig({ auth: { "cursor-sdk": { unavailable: true, reason: "auth_failed" } } })

      await expect(driver.createAgentSession({ directory: "/workspace", model: "auto", sessionId: "session-d" }))
        .rejects.toThrow("the account selected for cursor cannot be used: auth_failed")

      expect(created).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = previous
    }
  })

  test("places a handoff transcript before the first Cursor prompt", () => {
    expect(cursorTurnPrompt({ text: "continue", attachments: [] }, "prior conversation"))
      .toBe("prior conversation\n\ncontinue")
    expect(cursorTurnPrompt({ text: "continue", attachments: [] }))
      .toBe("continue")
  })

  test("sends an image attachment's bytes alongside the text that names its path", () => {
    const attachment = {
      mime: "image/png",
      base64: "AAAB",
      url: "data:image/png;base64,AAAB",
      filename: "shot.png",
      path: "/workspace/.claxedo/attachments/abc-shot.png",
    }
    expect(cursorTurnPrompt({
      text: `look\nAttached file (image/png): ${attachment.path}`,
      attachments: [attachment],
    })).toEqual({
      text: `look\nAttached file (image/png): ${attachment.path}`,
      images: [{ data: "AAAB", mimeType: "image/png" }],
    })
  })

  test("leaves a video attachment to the path Cursor reads it from", () => {
    const attachment = {
      mime: "video/mp4",
      base64: "AAAC",
      url: "data:video/mp4;base64,AAAC",
      filename: "clip.mp4",
      path: "/workspace/.claxedo/attachments/def-clip.mp4",
    }
    expect(cursorTurnPrompt({
      text: `watch\nAttached file (video/mp4): ${attachment.path}`,
      attachments: [attachment],
    })).toBe(`watch\nAttached file (video/mp4): ${attachment.path}`)
  })

  test("admits Task lifecycle metadata before projecting a sanitized parent frame", async () => {
    const observed: unknown[] = []
    const ingested: unknown[][] = []
    const rebound: string[] = []
    const registrations: unknown[] = []
    const transcriptRegistrar = {
      register(input: unknown) {
        registrations.push(input)
        return Promise.resolve({ state: "ready" as const, handle: "transcript_opaque" })
      },
    }
    const input = {
      sessionId: "parent-session",
      observeSubagent(value: unknown) {
        observed.push(value)
        return Promise.resolve({ event: {} })
      },
      ingest(...value: unknown[]) {
        ingested.push(value)
      },
      rebindAgentSession(value: string) {
        rebound.push(value)
      },
    } as never

    await ingestCursorSdkMessage(input, {
      type: "tool_call",
      agent_id: "cursor-parent",
      run_id: "run-1",
      call_id: "task-1",
      name: "Task",
      status: "running",
      args: { description: "Review auth", subagentType: { name: "reviewer" } },
    }, transcriptRegistrar)
    await ingestCursorSdkMessage(input, {
      type: "tool_call",
      agent_id: "cursor-parent",
      run_id: "run-1",
      call_id: "task-1",
      name: "Task",
      status: "completed",
      args: { description: "Review auth", subagentType: { name: "reviewer" } },
      result: {
        status: "success",
        value: {
          agentId: "agent-final",
          isBackground: false,
          durationMs: 42,
          transcriptPath: "/provider/private/agent-final.jsonl",
          conversationSteps: [{ text: "private child transcript" }],
        },
      },
    }, transcriptRegistrar)

    expect(observed).toMatchObject([
      {
        observation: {
          toolCallId: "task-1",
          toolCallRole: "spawn",
          status: "running",
          transcript: { kind: "none" },
        },
        correlationKeys: ["task-1"],
      },
      {
        observation: {
          toolCallId: "task-1",
          toolCallRole: "spawn",
          providerId: "agent-final",
          status: "completed",
          transcript: { kind: "file", ref: "transcript_opaque" },
        },
        correlationKeys: ["task-1", "agent-final"],
      },
    ])
    expect(ingested.map((value) => value[2])).toEqual([{ kind: "parent" }, { kind: "parent" }])
    expect(rebound).toEqual(["cursor-parent", "cursor-parent"])
    expect(registrations).toEqual([{
      parentSessionId: "parent-session",
      providerKind: "cursor-agent",
      filePath: "/provider/private/agent-final.jsonl",
    }])
    expect(JSON.stringify({ observed, ingested })).not.toContain("/provider/private")
    expect(JSON.stringify({ observed, ingested })).not.toContain("private child transcript")
  })

  test("treats handle-free completion and error as valid lifecycle observations", async () => {
    const observed: unknown[] = []
    const ingested: unknown[][] = []
    const registrations: unknown[] = []
    const transcriptRegistrar = {
      register(input: unknown) {
        registrations.push(input)
        return Promise.resolve({ state: "unavailable" as const, reason: "outside-root" })
      },
    }
    const input = {
      sessionId: "parent-session",
      observeSubagent(value: unknown) {
        observed.push(value)
        return Promise.resolve({ event: {} })
      },
      ingest(...value: unknown[]) {
        ingested.push(value)
      },
      rebindAgentSession() {},
    } as never

    await ingestCursorSdkMessage(input, {
      type: "tool_call",
      agent_id: "cursor-parent",
      run_id: "run-1",
      call_id: "task-complete",
      name: "Task",
      status: "completed",
      args: { description: "Summarize" },
      result: {
        status: "success",
        value: { isBackground: true, transcriptPath: "/outside/cursor/session.jsonl" },
      },
    }, transcriptRegistrar)
    await ingestCursorSdkMessage(input, {
      type: "tool_call",
      agent_id: "cursor-parent",
      run_id: "run-1",
      call_id: "task-error",
      name: "Task",
      status: "error",
      args: { description: "Inspect" },
      result: {
        status: "error",
        error: {
          message: "child failed",
          transcriptPath: "/provider/private/error.jsonl",
          value: { agentId: "must-not-adopt" },
        },
      },
    }, transcriptRegistrar)
    await ingestCursorSdkMessage(input, {
      type: "tool_call",
      agent_id: "cursor-parent",
      run_id: "run-1",
      call_id: "task-uncharacterized",
      name: "Task",
      status: "completed",
      args: { description: "Inspect without a configured root" },
      result: {
        status: "success",
        value: { transcriptPath: "/provider/private/uncharacterized.jsonl" },
      },
    })

    expect(observed).toMatchObject([
      { observation: { toolCallId: "task-complete", status: "completed", transcript: { kind: "none" } } },
      { observation: { toolCallId: "task-error", status: "failed", transcript: { kind: "none" } } },
      { observation: { toolCallId: "task-uncharacterized", status: "completed", transcript: { kind: "none" } } },
    ])
    expect(JSON.stringify(observed)).not.toContain("must-not-adopt")
    expect(registrations).toEqual([{
      parentSessionId: "parent-session",
      providerKind: "cursor-agent",
      filePath: "/outside/cursor/session.jsonl",
    }])
    expect(JSON.stringify({ observed, ingested })).not.toContain("/provider/private")
    expect(JSON.stringify(ingested)).toContain("child failed")
  })

  test("does not serve the static catalog before Cursor SDK credentials exist", async () => {
    const savedKey = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    const driver = createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
    } as never)

    try {
      expect(driver.peekConfigOptions("gpt-5.5")).toEqual([])
      await expect(driver.configOptions("gpt-5.5")).rejects.toThrow(
        "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login.",
      )
    } finally {
      if (savedKey !== undefined) process.env.CURSOR_API_KEY = savedKey
    }
  })

  test("keeps an SDK-only local root inferred and action-ineligible", async () => {
    const descriptors: AgentProcessDescriptor[] = []
    const processObserver: AgentProcessObserver = {
      register(descriptor) {
        descriptors.push(descriptor)
        return { update: () => undefined, exit: () => undefined }
      },
    }
    const driver = createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      processObserver,
      bindSession() {},
    } as never)
    await driver.applyConfig({
      mcp: {
        local: {
          name: "local",
          source: "user",
          transport: "stdio",
          command: "node",
          args: ["secret"],
          env: { TOKEN: "secret" },
        },
      },
    })

    const handle = (driver as unknown as {
      observeAgent(directory: string, sessionId: string): { exit(input: { reason: "disposed" }): void }
    }).observeAgent("/safe/workspace", "session-safe")
    handle.exit({ reason: "disposed" })

    expect(descriptors).toMatchObject([
      {
        harnessId: "cursor",
        role: "harness",
        locality: "local-process",
        confidence: "inferred",
        capabilities: { resourceMetrics: "process", ownerActions: false },
        sessionId: "session-safe",
      },
      {
        harnessId: "cursor",
        role: "mcp",
        parentOwnerId: descriptors[0]?.ownerId,
      },
    ])
    expect(JSON.stringify(descriptors)).not.toContain("secret")
  })
})
