import { describe, expect, test } from "bun:test"
import type { Query } from "@anthropic-ai/claude-agent-sdk"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import type { SdkRuntimeDriverHost, SdkRuntimeTurnInput } from "../shared/sdk-runtime-driver"
import type { ClaudeSdkDriverOptions } from "./driver"
import { createClaudeTaskLedger } from "@claxedo/agent-event-runtime/harnesses/claude"
import {
  claudePluginConfigs,
  CLAUDE_FORWARD_SUBAGENT_TEXT,
  claudeSystemPrompt,
  claudeSpawnEnv,
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
