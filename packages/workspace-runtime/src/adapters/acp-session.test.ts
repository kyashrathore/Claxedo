import { describe, expect, it } from "bun:test"
import { blocks, extractAgents, init, merge, resume, sync, type ACPConn } from "./acp-session"
import type { PromptInput } from "./index"

function prompt(input?: Partial<PromptInput>): PromptInput {
  return {
    parts: [{ type: "text", text: "hello" }],
    assistantMessageId: "a1",
    agent: "plan",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    ...input,
  }
}

function conn(input?: {
  loadSession?: () => Promise<{ configOptions?: unknown[] | null; modes?: unknown; models?: unknown }>
  unstable_resumeSession?: () => Promise<{ configOptions?: unknown[] | null; modes?: unknown; models?: unknown }>
  setSessionConfigOption?: (params: { sessionId: string; configId: string; value?: string }) => Promise<{ configOptions: unknown[] }>
  setSessionMode?: (params: { sessionId: string; modeId: string }) => Promise<unknown>
  unstable_setSessionModel?: (params: { sessionId: string; modelId: string }) => Promise<unknown>
}) {
  const calls: Array<{ name: string; args: unknown }> = []
  const api = {
    loadSession: async (params: { sessionId: string; cwd: string; mcpServers: unknown[] }) => {
      calls.push({ name: "loadSession", args: params })
      return await (input?.loadSession?.() ?? { configOptions: null, modes: null, models: null })
    },
    unstable_resumeSession: async (params: { sessionId: string; cwd: string; mcpServers?: unknown[] }) => {
      calls.push({ name: "unstable_resumeSession", args: params })
      return await (input?.unstable_resumeSession?.() ?? { configOptions: null, modes: null, models: null })
    },
    setSessionConfigOption: async (params: { sessionId: string; configId: string; value?: string }) => {
      calls.push({ name: "setSessionConfigOption", args: params })
      return await (input?.setSessionConfigOption?.(params) ?? { configOptions: [] })
    },
    setSessionMode: async (params: { sessionId: string; modeId: string }) => {
      calls.push({ name: "setSessionMode", args: params })
      return await (input?.setSessionMode?.(params) ?? {})
    },
    unstable_setSessionModel: async (params: { sessionId: string; modelId: string }) => {
      calls.push({ name: "unstable_setSessionModel", args: params })
      return await (input?.unstable_setSessionModel?.(params) ?? {})
    },
  } satisfies ACPConn
  return { api, calls }
}

describe("acp-session", () => {
  it("prefers session resume over load when advertised", async () => {
    const ctx = conn({
      unstable_resumeSession: async () => ({
        configOptions: [{
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "general",
          options: [{ value: "general", name: "General" }],
        }],
        modes: { currentModeId: "general", availableModes: [{ id: "general", name: "General" }] },
        models: null,
      }),
    })
    const state = init({
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { embeddedContext: true, image: false, audio: false },
      mcpCapabilities: { http: false, sse: false },
    })

    const next = await resume(ctx.api, state, "s1", "/work")

    expect(next.kind).toBe("resume")
    expect(next.state.cfg?.[0]).toMatchObject({ id: "mode" })
    expect(next.state.modeIds).toEqual(["general"])
    expect(ctx.calls).toEqual([{
      name: "unstable_resumeSession",
      args: { sessionId: "s1", cwd: "/work", mcpServers: [] },
    }])
  })

  it("falls back to load when resume is unavailable", async () => {
    const ctx = conn()
    const state = init({
      loadSession: true,
      promptCapabilities: { embeddedContext: false, image: false, audio: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: {},
    })

    const next = await resume(ctx.api, state, "s1", "/work")

    expect(next.kind).toBe("load")
    expect(ctx.calls[0]).toEqual({
      name: "loadSession",
      args: { sessionId: "s1", cwd: "/work", mcpServers: [] },
    })
  })

  it("forwards resolved MCP servers when resuming sessions", async () => {
    const ctx = conn()
    const state = init({
      loadSession: true,
      promptCapabilities: { embeddedContext: false, image: false, audio: false },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { resume: {} },
    })
    const mcp = [{
      name: "claxedo-mcp",
      command: "node",
      args: ["server.js"],
      env: [{ name: "OPENCODE_API_URL", value: "http://localhost:3001" }],
    }]

    await resume(ctx.api, state, "s1", "/work", mcp as any)

    expect(ctx.calls[0]).toEqual({
      name: "unstable_resumeSession",
      args: { sessionId: "s1", cwd: "/work", mcpServers: mcp },
    })
  })

  it("prefers config options for mode and model when available", async () => {
    const ctx = conn({
      setSessionConfigOption: async (params) => ({
        configOptions: params.configId === "mode"
          ? [{
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "plan",
              options: [{ value: "general", name: "General" }, { value: "plan", name: "Plan" }],
            }, {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: "anthropic/claude-sonnet-4-6",
              options: [{ value: "anthropic/claude-sonnet-4-6/fast", name: "Claude Fast" }],
            }]
          : [{
              id: "mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "plan",
              options: [{ value: "general", name: "General" }, { value: "plan", name: "Plan" }],
            }, {
              id: "model",
              name: "Model",
              category: "model",
              type: "select",
              currentValue: params.value!,
              options: [{ value: "anthropic/claude-sonnet-4-6/fast", name: "Claude Fast" }],
            }],
      }),
    })
    const state = merge(init(null), {
      configOptions: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "general",
        options: [{ value: "general", name: "General" }, { value: "plan", name: "Plan" }],
      }, {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "anthropic/claude-sonnet-4-6",
        options: [{ value: "anthropic/claude-sonnet-4-6/fast", name: "Claude Fast" }],
      }],
    })

    const next = await sync(ctx.api, state, "s1", prompt({ variant: "fast" }))

    expect(next.cfg?.find((item) => item.id === "model")).toMatchObject({
      currentValue: "anthropic/claude-sonnet-4-6/fast",
    })
    expect(ctx.calls).toEqual([
      {
        name: "setSessionConfigOption",
        args: { sessionId: "s1", configId: "mode", value: "plan" },
      },
      {
        name: "setSessionConfigOption",
        args: { sessionId: "s1", configId: "model", value: "anthropic/claude-sonnet-4-6/fast" },
      },
    ])
  })

  it("falls back to legacy mode/model RPCs when config options are absent", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      modes: {
        currentModeId: "general",
        availableModes: [{ id: "general", name: "General" }, { id: "plan", name: "Plan" }],
      },
      models: { currentModelId: "anthropic/claude-sonnet-4-6", availableModels: [] },
    })

    await sync(ctx.api, state, "s1", prompt({ variant: "fast" }))

    expect(ctx.calls).toEqual([
      {
        name: "setSessionMode",
        args: { sessionId: "s1", modeId: "plan" },
      },
      {
        name: "unstable_setSessionModel",
        args: { sessionId: "s1", modelId: "claude-sonnet-4-6/fast" },
      },
    ])
  })

  it("skips setSessionMode when agent name does not match any available mode", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      modes: {
        currentModeId: "code",
        availableModes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
      },
      models: { currentModelId: "anthropic/claude-sonnet-4-6", availableModels: [] },
    })

    // "General" is not in available modes — setSessionMode should NOT be called
    await sync(ctx.api, state, "s1", prompt({ agent: "General" }))

    expect(ctx.calls).toEqual([
      {
        name: "unstable_setSessionModel",
        args: { sessionId: "s1", modelId: "claude-sonnet-4-6" },
      },
    ])
  })

  it("matches mode case-insensitively", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      modes: {
        currentModeId: "code",
        availableModes: [{ id: "code", name: "Code" }, { id: "plan", name: "Plan" }],
      },
      models: null,
    })

    // "Plan" (capitalized) should match "plan" mode
    await sync(ctx.api, state, "s1", prompt({ agent: "Plan" }))

    expect(ctx.calls).toEqual([
      {
        name: "setSessionMode",
        args: { sessionId: "s1", modeId: "plan" },
      },
    ])
  })

  it("skips mode setting entirely when modeIds is empty", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      modes: null,
      models: { currentModelId: "anthropic/claude-sonnet-4-6", availableModels: [] },
    })

    await sync(ctx.api, state, "s1", prompt())

    // Only model call, no mode call
    expect(ctx.calls).toEqual([
      {
        name: "unstable_setSessionModel",
        args: { sessionId: "s1", modelId: "claude-sonnet-4-6" },
      },
    ])
  })

  it("skips redundant model config option when currentValue already matches", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      configOptions: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "plan",
        options: [{ value: "general", name: "General" }, { value: "plan", name: "Plan" }],
      }, {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-sonnet-4-6",
        options: [{ value: "claude-sonnet-4-6", name: "Claude Sonnet" }],
      }],
    })

    await sync(ctx.api, state, "s1", prompt())

    // Both mode and model already match — no calls should be made
    expect(ctx.calls).toEqual([])
  })

  it("skips redundant unstable_setSessionModel on repeat sync", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      modes: null,
      models: { currentModelId: "anthropic/claude-sonnet-4-6", availableModels: [] },
    })

    // First sync sets the model
    const next = await sync(ctx.api, state, "s1", prompt())
    expect(ctx.calls).toHaveLength(1)

    // Second sync with same model — should skip
    ctx.calls.length = 0
    await sync(ctx.api, next, "s1", prompt())
    expect(ctx.calls).toEqual([])
  })

  it("sends unstable_setSessionModel when model changes between syncs", async () => {
    const ctx = conn()
    const state = merge(init(null), {
      modes: null,
      models: { currentModelId: "anthropic/claude-sonnet-4-6", availableModels: [] },
    })

    const next = await sync(ctx.api, state, "s1", prompt())
    ctx.calls.length = 0

    // Change model
    await sync(ctx.api, next, "s1", prompt({ model: { providerID: "anthropic", modelID: "claude-opus-4-6" } }))
    expect(ctx.calls).toEqual([
      {
        name: "unstable_setSessionModel",
        args: { sessionId: "s1", modelId: "claude-opus-4-6" },
      },
    ])
  })

  it("maps prompt parts through ACP content capabilities", () => {
    const out = blocks([
      { type: "text", text: "hello" },
      { type: "resource_link", uri: "file:///tmp/x.ts", name: "x.ts", mimeType: "text/plain" },
      { type: "resource", resource: { uri: "file:///tmp/spec.txt", text: "ctx" } },
    ], "sys", { embeddedContext: false, image: false, audio: false })

    expect(out).toEqual([
      { type: "text", text: "sys", annotations: { audience: ["assistant"] } },
      { type: "text", text: "hello" },
      { type: "resource_link", uri: "file:///tmp/x.ts", name: "x.ts", mimeType: "text/plain" },
      { type: "text", text: "ctx" },
    ])
  })

  it("rejects unsupported rich prompt content", () => {
    expect(() =>
      blocks([{ type: "image", mimeType: "image/png", data: "abc" }], undefined, {
        embeddedContext: false,
        image: false,
        audio: false,
      })
    ).toThrow("ACP agent does not support image prompt content")
  })
})

describe("extractAgents", () => {
  it("returns agents from config-based mode options", () => {
    const state = merge(init(null), {
      configOptions: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "code",
        options: [
          { value: "code", name: "Code" },
          { value: "plan", name: "Plan" },
          { value: "ask", name: "Ask" },
        ],
      }],
    })

    const agents = extractAgents(state)

    expect(agents).toEqual([
      { name: "code", description: "Code", mode: "primary" },
      { name: "plan", description: "Plan", mode: "primary" },
      { name: "ask", description: "Ask", mode: "primary" },
    ])
  })

  it("returns agents from legacy modeIds when no config options", () => {
    const state = merge(init(null), {
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "architect", name: "Architect" },
        ],
      },
    })

    const agents = extractAgents(state)

    expect(agents).toEqual([
      { name: "code", mode: "primary" },
      { name: "architect", mode: "primary" },
    ])
  })

  it("prefers config options over legacy modeIds", () => {
    const state = merge(init(null), {
      configOptions: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "code",
        options: [{ value: "code", name: "Code" }],
      }],
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "code", name: "Code" },
          { id: "plan", name: "Plan" },
        ],
      },
    })

    const agents = extractAgents(state)

    // Should use config options (1 mode), not legacy modeIds (2 modes)
    expect(agents).toEqual([
      { name: "code", description: "Code", mode: "primary" },
    ])
  })

  it("returns empty array when no modes available", () => {
    const state = init(null)
    expect(extractAgents(state)).toEqual([])
  })

  it("returns empty array when config has mode category but no options", () => {
    const state = merge(init(null), {
      configOptions: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "",
        options: [],
      }],
    })

    expect(extractAgents(state)).toEqual([])
  })

  it("handles grouped config options", () => {
    const state = merge(init(null), {
      configOptions: [{
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "code",
        options: [
          {
            group: "Primary",
            options: [
              { value: "code", name: "Code" },
              { value: "plan", name: "Plan" },
            ],
          },
          {
            group: "Secondary",
            options: [
              { value: "ask", name: "Ask" },
            ],
          },
        ],
      }],
    })

    const agents = extractAgents(state)

    expect(agents).toEqual([
      { name: "code", description: "Code", mode: "primary" },
      { name: "plan", description: "Plan", mode: "primary" },
      { name: "ask", description: "Ask", mode: "primary" },
    ])
  })
})
