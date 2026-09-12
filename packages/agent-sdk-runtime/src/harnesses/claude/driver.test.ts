import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { brokeredClaudeConfigDir } from "./config-dir"
import { SdkRuntimeAdapter } from "../shared/sdk-runtime-adapter"
import { createMemoryRuntimeStore } from "../../stores/memory"
import type { AgentExecutionBinding } from "@claxedo/agent-runtime-contract"
import { removeTestTempDir } from "../shared/test-temp-dir"
import type { ActiveTurn, SdkRuntimeDriverHost, SdkRuntimeTurnInput } from "../shared/sdk-runtime-driver"
import type { ClaudeSdkDriverOptions } from "./driver"
import { createClaudeTaskLedger } from "@claxedo/agent-event-runtime/harnesses/claude"
import {
  claudePluginConfigs,
  CLAUDE_FORWARD_SUBAGENT_TEXT,
  claudeSystemPrompt,
  claudeSpawnEnv,
  claudeTurnPrompt,
  createClaudeSdkDriver,
  ingestClaudeSdkMessage,
} from "./driver"

function driver() {
  return createClaudeSdkDriver({
    lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
  } as never)
}

describe("Claude SDK driver", () => {
  test("projects opaque harness launch roots into Claude local plugin configs", () => {
    expect(claudePluginConfigs({ pluginRoots: ["/plugins/one", "/plugins/one", "/plugins/two"] })).toEqual([
      { type: "local", path: "/plugins/one" },
      { type: "local", path: "/plugins/two" },
    ])
    expect(claudePluginConfigs({ pluginRoots: ["/plugins/one", 42] })).toEqual([
      { type: "local", path: "/plugins/one" },
    ])
  })

  test("writes a pasted image into the workspace and sends it as an image block", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "claude-attachment-"))
    try {
      const prompts: unknown[] = []
      const lifecycle = createSessionTurnLifecycle()
      const driver = createClaudeSdkDriver({
        lifecycle: () => lifecycle as never,
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        bindSession() {},
        getAgentSessionId: () => "claude-sdk:pending",
        getSessionForAgentSession: () => null,
        getSessionConfig: () => null,
        updatePermissionState() {},
        publishGoal() {},
        async runProviderTurn() { return true },
      } as never, {
        executable: () => "/fake/claude",
        query: ((request: { prompt: unknown }) => {
          prompts.push(request.prompt)
          const stream = (async function* () {})()
          return Object.assign(stream, { close() {} }) as unknown as Query
        }) as never,
      })
      await driver.runTurn({
        sessionId: "session-1",
        getAgentSessionId: () => "claude-sdk:pending",
        getSessionForAgentSession: () => null,
        input: {
          parts: [
            { type: "text", text: "what is wrong here" },
            { type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,AAAB" },
          ],
          userMessageId: "user-1",
          assistantMessageId: "assistant-1",
          agent: "build",
          model: { providerID: "claude", modelID: "sonnet" },
        },
        directory,
        abort: new AbortController(),
        ingest() {},
        associateChild() {},
        observeSubagent: async () => ({ event: {} }),
        rebindAgentSession() {},
        model: "sonnet",
      } as never)

      const written = fs.readdirSync(path.join(directory, ".claxedo", "attachments"))
        .filter((name) => name !== ".gitignore")
      expect(written).toHaveLength(1)
      const target = path.join(directory, ".claxedo", "attachments", written[0])
      expect(fs.readFileSync(target).toString("base64")).toBe("AAAB")

      const sent: Array<{ message: { content: Array<Record<string, unknown>> } }> = []
      for await (const message of prompts[0] as AsyncIterable<never>) sent.push(message)
      expect(sent[0]?.message.content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
        { type: "text", text: `what is wrong here\nAttached file (image/png): ${target}` },
      ])
    } finally {
      removeTestTempDir(directory)
    }
  })

  test("keeps the query's input stream open, so a prompt sent mid-turn reaches the same query", async () => {
    const prompts: unknown[] = []
    const lifecycle = createSessionTurnLifecycle<ActiveTurn>()
    let endTurn!: () => void
    const turnClosed = new Promise<void>((resolve) => { endTurn = resolve })
    const host = {
      lifecycle: () => lifecycle, pendingPermissions: new Map(), pendingQuestions: new Map(),
      bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
      getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
      getSessionConfig: () => ({ harness: { id: "claude", access: "native" } }),
      updatePermissionState() {},
    } as unknown as SdkRuntimeDriverHost
    const running = createClaudeSdkDriver(host, {
      executable: () => "/fake/claude",
      query: ((request: { prompt: unknown }) => {
        prompts.push(request.prompt)
        const stream = (async function* () { await turnClosed })()
        return Object.assign(stream, { close() {} }) as unknown as Query
      }) as never,
    }).runTurn({
      sessionId: "session-1",
      getAgentSessionId: () => "claude-sdk:session-1",
      input: { parts: [{ type: "text", text: "start the work" }], assistantMessageId: "assistant-1", agent: "build", model: { providerID: "claude", modelID: "opus" } },
      directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
      observeSubagent: async () => ({ event: {} }), rebindAgentSession() {}, model: "",
    } as unknown as SdkRuntimeTurnInput)

    const steer = await waitForSteer(lifecycle, "session-1")
    await steer({ parts: [{ type: "text", text: "also update the readme" }], assistantMessageId: "assistant-2", agent: "build", model: { providerID: "claude", modelID: "opus" } })

    const input = (prompts[0] as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]()
    expect(await promptedText(input)).toBe("start the work")
    expect(await promptedText(input)).toBe("also update the readme")
    endTurn()
    await running
  })

  test("keeps a prompt with no attachments a plain string", () => {
    expect(claudeTurnPrompt({ text: "run the tests", attachments: [] })).toBe("run the tests")
  })

  test("sends an image attachment as an image block before the text", async () => {
    const attachment = {
      mime: "image/png" as const,
      base64: "AAAB",
      url: "data:image/png;base64,AAAB",
      filename: "shot.png",
      path: "/workspace/.claxedo/attachments/abc-shot.png",
    }
    const text = `look\nAttached file (image/png): ${attachment.path}`
    const prompt = claudeTurnPrompt({ text, attachments: [attachment] })
    expect(typeof prompt).not.toBe("string")
    const sent = []
    for await (const message of prompt as AsyncIterable<unknown>) sent.push(message)
    expect(sent).toEqual([{
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
          { type: "text", text },
        ],
      },
    }])
  })

  test("sends a PDF attachment as a document block", async () => {
    const attachment = {
      mime: "application/pdf",
      base64: "JVBER",
      url: "data:application/pdf;base64,JVBER",
      filename: "spec.pdf",
      path: "/workspace/.claxedo/attachments/abc-spec.pdf",
    }
    const prompt = claudeTurnPrompt({ text: "read it", attachments: [attachment] })
    const sent: Array<{ message: { content: Array<Record<string, unknown>> } }> = []
    for await (const message of prompt as AsyncIterable<never>) sent.push(message)
    expect(sent[0]?.message.content).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
      { type: "text", text: "read it" },
    ])
  })

  test("leaves a video attachment to the path the text names", () => {
    const attachment = {
      mime: "video/mp4",
      base64: "AAAC",
      url: "data:video/mp4;base64,AAAC",
      filename: "clip.mp4",
      path: "/workspace/.claxedo/attachments/def-clip.mp4",
    }
    const text = `watch\nAttached file (video/mp4): ${attachment.path}`
    expect(claudeTurnPrompt({ text, attachments: [attachment] })).toBe(text)
  })

  test("appends a handoff transcript to Claude Code's canonical system prompt", () => {
    expect(claudeSystemPrompt("prior conversation")).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "prior conversation",
    })
    expect(claudeSystemPrompt()).toBeUndefined()
  })

  test("measures routed nested SDK frames below the forwarding thresholds", async () => {
    const childText = [
      "Inspecting authentication entry points.",
      "Reading the session middleware.",
      "Searching for token validation.",
      "Checking the failure path.",
      "Found one stale authorization branch.",
      "The child review is complete.",
    ]
    const parentMessages = Array.from({ length: 7 }, (_, index) => ({
      type: "assistant",
      uuid: `assistant-parent-${index}`,
      session_id: "sdk-session-measurement",
      parent_tool_use_id: null,
      message: {
        content: index === 0
          ? [{
              type: "tool_use",
              id: "tool-agent-measurement",
              name: "Agent",
              input: { description: "Review auth", subagent_type: "code-reviewer" },
            }]
          : [{ type: "text", text: `Parent progress ${index}` }],
      },
    }))
    const childMessages = childText.map((value, index) => ({
      type: "assistant",
      uuid: `assistant-child-${index}`,
      session_id: "sdk-session-measurement",
      parent_tool_use_id: "tool-agent-measurement",
      message: { content: [{ type: "text", text: value }] },
    }))
    const tasks = createClaudeTaskLedger()
    const ingested: unknown[][] = []
    const input = {
      observeSubagent() {
        return Promise.resolve({ event: {} })
      },
      ingest(...value: unknown[]) {
        ingested.push(value)
      },
      rebindAgentSession() {},
    } as never

    for (const message of [...parentMessages, ...childMessages]) {
      await ingestClaudeSdkMessage(input, message as never, tasks)
    }

    const parentFrames = ingested.filter((value) => (value[2] as { kind: string }).kind === "parent")
    const childFrames = ingested.filter((value) => (value[2] as { kind: string }).kind === "child")
    const forwardedBytes = childFrames.reduce((total, value) => {
      const payload = (value[0] as { payload: { message: { content: Array<{ text?: string }> } } }).payload
      return total + payload.message.content.reduce(
        (bytes, part) => bytes + new TextEncoder().encode(part.text ?? "").byteLength,
        0,
      )
    }, 0)

    expect(parentFrames).toHaveLength(7)
    expect(childFrames).toHaveLength(6)
    expect(childFrames.length / parentFrames.length).toBeLessThan(2)
    expect(forwardedBytes).toBeLessThan(5 * 1024 * 1024)
    expect(CLAUDE_FORWARD_SUBAGENT_TEXT).toBe(true)
  })

  test("admits tool and task observations before routing child-owned SDK messages", async () => {
    const tasks = createClaudeTaskLedger()
    const observed: unknown[] = []
    const ingested: unknown[][] = []
    const rebound: string[] = []
    const input = {
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

    await ingestClaudeSdkMessage(input, {
      type: "assistant",
      uuid: "assistant-parent-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use",
          id: "tool-agent-1",
          name: "Agent",
          input: { description: "Review auth", subagent_type: "code-reviewer" },
        }],
      },
    } as never, tasks)
    expect(observed).toMatchObject([{
      observation: {
        toolCallId: "tool-agent-1",
        toolCallRole: "spawn",
        status: "pending",
        transcript: { kind: "messages" },
      },
      correlationKeys: ["tool-agent-1"],
    }])
    expect(ingested[0]?.[2]).toEqual({ kind: "parent" })

    await ingestClaudeSdkMessage(input, {
      type: "system",
      subtype: "task_started",
      uuid: "task-start-1",
      session_id: "sdk-session-1",
      task_id: "task-1",
      tool_use_id: "tool-agent-1",
      description: "Review auth",
      subagent_type: "code-reviewer",
    } as never, tasks)
    expect(observed[1]).toMatchObject({
      observation: { stableCorrelationId: "task-1", toolCallId: "tool-agent-1", status: "running" },
      correlationKeys: ["task-1", "tool-agent-1"],
    })

    await ingestClaudeSdkMessage(input, {
      type: "assistant",
      uuid: "assistant-child-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: "tool-agent-1",
      message: { content: [{ type: "tool_use", id: "tool-read-1", name: "Read", input: {} }] },
    } as never, tasks)
    expect(ingested[2]?.[2]).toEqual({ kind: "child", correlationKey: "tool-agent-1" })
    expect(rebound).toEqual(["sdk-session-1", "sdk-session-1", "sdk-session-1"])
  })

  test("admits the structured Agent identity without parsing the tool-result text", async () => {
    const tasks = createClaudeTaskLedger()
    const observed: unknown[] = []
    await ingestClaudeSdkMessage({
      observeSubagent(value: unknown) {
        observed.push(value)
        return Promise.resolve({ event: {} })
      },
      ingest() {},
      rebindAgentSession() {},
    } as never, {
      type: "user",
      uuid: "agent-result-1",
      session_id: "sdk-session-1",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-agent-1", content: "opaque trailer" }],
      },
      tool_use_result: {
        status: "completed",
        agentId: "agent-42",
        content: [{ type: "text", text: "Review complete" }],
        totalTokens: 321,
      },
    } as never, tasks)

    expect(observed).toMatchObject([{
      observation: {
        toolCallId: "tool-agent-1",
        providerId: "agent-42",
        providerKind: "claude-agent",
        status: "completed",
      },
    }])
  })

  test("scrubs the local document installation secret from the child environment", () => {
    expect(claudeSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })

  test("offers no model until a live probe answers", () => {
    // `peek` never spawns the probe query. An unanswered harness has no model
    // list, and an empty picker beats one naming models it may not serve.
    expect(driver().peekConfigOptions("claude-from-a-future-release")).toEqual([])
  })

  test("marks the SDK's default row, so the picker shows the model an unset session runs", async () => {
    const options = await probedDriver().configOptions("", "/repo")
    expect(options[0]).toMatchObject({
      id: "model",
      currentValue: "default",
      selectOptions: [
        { id: "opus[1m]", name: "Opus (1M context)" },
        { id: "default", name: "Default (recommended)" },
        { id: "sonnet", name: "Sonnet" },
      ],
    })
  })

  test("sends the default row rather than letting the CLI resolve a model of its own", async () => {
    // Omitting `model` hands the choice to the CLI's settings chain, which can
    // name a model the picker never showed. `default` is a row the SDK serves.
    expect(await turnModelOption("default")).toBe("default")
    expect(await turnModelOption("opus[1m]")).toBe("opus[1m]")
  })
})

  test("carries one task ledger across the turn, so a backgrounded command opens no row and a departed agent settles", async () => {
    const turn = [
      {
        type: "system",
        subtype: "task_started",
        uuid: "task-start-bash",
        session_id: "sdk-session-1",
        task_id: "task-bash",
        tool_use_id: "bash-1",
        task_type: "local_bash",
        description: "npm run build",
      },
      {
        type: "system",
        subtype: "task_started",
        uuid: "task-start-agent",
        session_id: "sdk-session-1",
        task_id: "task-agent",
        tool_use_id: "tool-agent-1",
        description: "Review auth",
        subagent_type: "code-reviewer",
      },
      {
        type: "system",
        subtype: "background_tasks_changed",
        uuid: "background-1",
        session_id: "sdk-session-1",
        tasks: [
          { task_id: "task-bash", task_type: "local_bash", description: "npm run build" },
          { task_id: "task-agent", task_type: "local_agent", description: "Review auth" },
        ],
      },
      {
        type: "system",
        subtype: "task_notification",
        uuid: "task-done-bash",
        session_id: "sdk-session-1",
        task_id: "task-bash",
        tool_use_id: "bash-1",
        status: "completed",
        summary: "npm run build finished",
      },
      {
        type: "system",
        subtype: "background_tasks_changed",
        uuid: "background-2",
        session_id: "sdk-session-1",
        tasks: [{ task_id: "task-bash", task_type: "local_bash", description: "npm run build" }],
      },
    ]
    const observed: Array<{ stableCorrelationId?: string; status?: string }> = []
    const host = {
      lifecycle: () => createSessionTurnLifecycle(), pendingPermissions: new Map(), pendingQuestions: new Map(),
      bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
      getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
      getSessionConfig: () => ({ harness: { id: "claude", access: "native" } }),
      updatePermissionState() {},
    } as unknown as SdkRuntimeDriverHost

    await createClaudeSdkDriver(host, {
      query: () => Object.assign((async function* () {
        for (const message of turn) yield message
      })(), { close() {}, supportedModels: async () => PROBED_MODELS }) as unknown as Query,
      executable: () => "/fake/claude",
    }).runTurn({
      sessionId: "session-1",
      getAgentSessionId: () => "claude-sdk:session-1",
      input: { parts: [{ type: "text", text: "hi" }], assistantMessageId: "assistant-1", model: { providerID: "claude", modelID: "opus" } },
      directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
      observeSubagent: async (value: { observation: { stableCorrelationId?: string; status?: string } }) => {
        observed.push({ stableCorrelationId: value.observation.stableCorrelationId, status: value.observation.status })
        return { event: {} }
      },
      rebindAgentSession() {}, model: "",
    } as unknown as SdkRuntimeTurnInput)

    expect(observed).toEqual([
      { stableCorrelationId: "task-agent", status: "running" },
      { stableCorrelationId: "task-agent", status: "interrupted" },
    ])
  })


// `default` is deliberately not first: the picker must find it by the harness's
// own marking, not by position.
const PROBED_MODELS = [
  { value: "opus[1m]", displayName: "Opus (1M context)", description: "", resolvedModel: "claude-opus-5[1m]" },
  { value: "default", displayName: "Default (recommended)", description: "", resolvedModel: "claude-opus-5[1m]" },
  { value: "sonnet", displayName: "Sonnet", description: "", resolvedModel: "claude-sonnet-5" },
]

function probeQuery(calls: Parameters<NonNullable<ClaudeSdkDriverOptions["query"]>>[0][] = []): NonNullable<ClaudeSdkDriverOptions["query"]> {
  return (input) => {
    calls.push(input)
    return Object.assign((async function* () {})(), {
      close() {},
      supportedModels: async () => PROBED_MODELS,
    }) as unknown as Query
  }
}

function probedDriver() {
  return createClaudeSdkDriver(
    { lifecycle: () => createSessionTurnLifecycle(), pendingPermissions: new Map(), pendingQuestions: new Map(), bindSession() {} } as never,
    { query: probeQuery(), executable: () => "/fake/claude" },
  )
}

async function turnModelOption(modelID: string) {
  const calls: Parameters<NonNullable<ClaudeSdkDriverOptions["query"]>>[0][] = []
  const host = {
    lifecycle: () => createSessionTurnLifecycle(), pendingPermissions: new Map(), pendingQuestions: new Map(),
    bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
    getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
    getSessionConfig: () => ({ harness: { id: "claude", access: "native" } }),
    updatePermissionState() {},
  } as unknown as SdkRuntimeDriverHost
  await createClaudeSdkDriver(host, { query: probeQuery(calls), executable: () => "/fake/claude" }).runTurn({
    sessionId: "session-1",
    getAgentSessionId: () => "claude-sdk:session-1",
    input: { parts: [{ type: "text", text: "hi" }], assistantMessageId: "assistant-1", model: { providerID: "claude", modelID } },
    directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
    observeSubagent: async () => ({ event: {} }), rebindAgentSession() {}, model: "",
  } as unknown as SdkRuntimeTurnInput)
  return calls.at(-1)!.options!.model
}

async function waitForSteer(lifecycle: ReturnType<typeof createSessionTurnLifecycle<ActiveTurn>>, sessionId: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const steer = lifecycle.get(sessionId)?.steer
    if (steer) return steer
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("the turn never accepted steering")
}

async function promptedText(input: AsyncIterator<SDKUserMessage>) {
  const next: IteratorResult<SDKUserMessage> = await input.next()
  const content = next.value?.message.content
  if (typeof content === "string") return content
  const block = content?.find((part: { type: string }) => part.type === "text")
  return block?.type === "text" ? block.text : undefined
}

const brokerProjection = {
  baseUrl: "http://127.0.0.1:2595/bindings/2f6c1b9a",
  placeholder: "signed-runtime-placeholder",
  authMode: "api-key" as const,
  expiresAt: 1_800_000_000_000,
}

function turnHost() {
  return {
    lifecycle: () => createSessionTurnLifecycle(), pendingPermissions: new Map(), pendingQuestions: new Map(),
    bindSession() {}, getAgentSessionId: () => null, getSessionForAgentSession: () => null,
    getGoal: () => null, publishGoal() {}, runProviderTurn: async () => true,
    getSessionConfig: () => ({ harness: { id: "claude", access: "native" } }),
    updatePermissionState() {},
  } as unknown as SdkRuntimeDriverHost
}

async function spawnEnvFor(projection: typeof brokerProjection | { authMode: "bearer" } & Omit<typeof brokerProjection, "authMode">) {
  const calls: Parameters<NonNullable<ClaudeSdkDriverOptions["query"]>>[0][] = []
  const driver = createClaudeSdkDriver(turnHost(), { query: probeQuery(calls), executable: () => "/fake/claude" })
  void driver.applyConfig({ auth: { "claude-sdk": projection }, mcp: {} })
  await driver.runTurn({
    sessionId: "session-env",
    getAgentSessionId: () => "claude-sdk:session-env",
    input: { parts: [{ type: "text", text: "hi" }], assistantMessageId: "assistant-env", model: { providerID: "claude", modelID: "auto" } },
    directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
    observeSubagent: async () => ({ event: {} }), rebindAgentSession() {}, model: "",
  } as unknown as SdkRuntimeTurnInput)
  return calls.at(-1)!.options!.env as Record<string, string | undefined>
}

describe("Claude spawns against the broker, never a credential", () => {
  test("the spawn env carries the base URL and the placeholder", async () => {
    const env = await spawnEnvFor(brokerProjection)

    expect(env.ANTHROPIC_BASE_URL).toBe(brokerProjection.baseUrl)
    expect(env.ANTHROPIC_API_KEY).toBe(brokerProjection.placeholder)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test("an operator's own credentials in this process do not reach the spawned harness", async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-operator-own"
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-operator-own"
    try {
      const env = await spawnEnvFor({ ...brokerProjection, authMode: "bearer" })

      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(brokerProjection.placeholder)
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(JSON.stringify(env)).not.toContain("operator-own")
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved.key
      if (saved.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oauth
    }
  })

  test("an auth map that is not projections is refused rather than run on nothing", () => {
    const driver = createClaudeSdkDriver(turnHost(), { query: probeQuery(), executable: () => "/fake/claude" })

    expect(() => driver.applyConfig({ auth: { "claude-sdk": "sk-ant-api03-plaintext" }, mcp: {} }))
      .toThrow("not provider projections")
  })
})

/**
 * The broker answers a withdrawn binding with 403 and the vendor answers a bad
 * credential with 401. Either way the CLI exits on an API error, and the turn
 * has to reach the session as a named failure — a turn that merely stops is the
 * hang this path exists to prevent.
 */
describe("a 4xx from the broker base URL ends the turn", () => {
  for (const failure of [
    'Claude Code process exited with code 1: API Error: 403 {"error":"binding_unavailable"}',
    "Claude Code process exited with code 1: API Error: 401 authentication_error",
  ]) {
    test(failure.slice(failure.indexOf("API Error")), async () => {
      const store = createMemoryRuntimeStore()
      const adapter = new SdkRuntimeAdapter({
        store,
        driver: (host) => createClaudeSdkDriver(host, {
          executable: () => "/fake/claude",
          query: () => Object.assign((async function* (): AsyncGenerator<never> { throw new Error(failure) })(), {
            close() {},
            supportedModels: async () => [],
          }) as unknown as Query,
        }),
      })
      void adapter.applyConfig({ auth: { "claude-sdk": brokerProjection }, mcp: {} })
      const session = await adapter.createSession("/repo", undefined, "session-403")
      const binding = {
        workspaceId: "workspace",
        directory: "/repo",
        sessionId: session.id,
        upstreamSessionId: store.getAgentSessionId(session.id)!,
        connectionId: "native:claude",
      } as AgentExecutionBinding

      const events: Array<{ type: string; properties?: Record<string, unknown> }> = []
      for await (const event of adapter.executeTurn(binding, {
        parts: [{ type: "text", text: "Reply with OK" }],
        agent: "build",
        assistantMessageId: "assistant-403",
        model: { providerID: "claude", modelID: "auto" },
      })) events.push(event as { type: string })

      expect(events.at(-1)).toMatchObject({
        type: "session.error",
        properties: { error: { data: { message: failure, firstTurnErrorClass: "credential" } } },
      })
      expect(store.getMessages(session.id).at(-1)).toMatchObject({
        info: { error: { data: { message: failure, firstTurnErrorClass: "credential" } } },
      })
      await adapter.dispose()
    })
  }
})

describe("a brokered turn withholds the operator's Claude account", () => {
  function configDirs() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-config-"))
    const source = path.join(base, "home")
    fs.mkdirSync(path.join(source, "plugins"), { recursive: true })
    fs.writeFileSync(path.join(source, "settings.json"), '{"model":"opus"}')
    fs.writeFileSync(path.join(source, "CLAUDE.md"), "operator memory")
    fs.writeFileSync(path.join(source, ".claude.json"), '{"oauthAccount":{"emailAddress":"operator@example.test"}}')
    fs.writeFileSync(path.join(source, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"operator-own-token"}}')
    return { base, source, root: path.join(base, "brokered") }
  }

  test("the mirrored config dir carries configuration and no account", () => {
    const dirs = configDirs()
    try {
      const root = brokeredClaudeConfigDir({ root: dirs.root, source: dirs.source })

      expect(fs.readdirSync(root).sort()).toEqual(["CLAUDE.md", "plugins", "settings.json"])
      expect(fs.readFileSync(path.join(root, "settings.json"), "utf8")).toBe('{"model":"opus"}')
      expect(fs.existsSync(path.join(root, ".claude.json"))).toBe(false)
      expect(fs.existsSync(path.join(root, ".credentials.json"))).toBe(false)
    } finally {
      fs.rmSync(dirs.base, { recursive: true, force: true })
    }
  })

  test("state Claude Code wrote into the dir survives, a stale mirror does not", () => {
    const dirs = configDirs()
    try {
      brokeredClaudeConfigDir({ root: dirs.root, source: dirs.source })
      fs.writeFileSync(path.join(dirs.root, ".claude.json"), '{"projects":{}}')
      fs.rmSync(path.join(dirs.source, "CLAUDE.md"))

      const root = brokeredClaudeConfigDir({ root: dirs.root, source: dirs.source })

      expect(fs.readFileSync(path.join(root, ".claude.json"), "utf8")).toBe('{"projects":{}}')
      expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(false)
    } finally {
      fs.rmSync(dirs.base, { recursive: true, force: true })
    }
  })

  test("the spawn env points at it only while a projection is held", async () => {
    const dirs = configDirs()
    try {
      const calls: Parameters<NonNullable<ClaudeSdkDriverOptions["query"]>>[0][] = []
      const driver = createClaudeSdkDriver(turnHost(), {
        query: probeQuery(calls),
        executable: () => "/fake/claude",
        brokeredConfigDir: { root: dirs.root, source: dirs.source },
      })
      const turn = () => driver.runTurn({
        sessionId: "session-config", getAgentSessionId: () => "claude-sdk:session-config",
        input: { parts: [{ type: "text", text: "hi" }], assistantMessageId: "assistant-config", model: { providerID: "claude", modelID: "auto" } },
        directory: "/repo", abort: new AbortController(), ingest() {}, associateChild() {},
        observeSubagent: async () => ({ event: {} }), rebindAgentSession() {}, model: "",
      } as unknown as SdkRuntimeTurnInput)

      void driver.applyConfig({ auth: { "claude-sdk": brokerProjection }, mcp: {} })
      await turn()
      expect((calls.at(-1)!.options!.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(dirs.root)

      void driver.applyConfig({ auth: {}, mcp: {} })
      await turn()
      expect((calls.at(-1)!.options!.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBeUndefined()
    } finally {
      fs.rmSync(dirs.base, { recursive: true, force: true })
    }
  })
})
