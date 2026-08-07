/**
 * Real-pi model backend for the Pi central harness.
 *
 * The Pi adapter historically executed only tool/exec prompts against the
 * SessionEnv (no LLM). This module adds the model leg: a per-session
 * `Agent` from @mariozechner/pi-agent-core whose model turns run on any pi-ai
 * provider — including the `openai-codex` ChatGPT-subscription OAuth provider —
 * while tool execution stays bridged to the SessionEnv (virtual or
 * workspace-runtime), NOT the server's own filesystem.
 *
 * The backend is resolved lazily per turn so credential refresh/rotation is
 * picked up without rebinding sessions.
 */
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@mariozechner/pi-agent-core"
import { getModel, type Api, type Model } from "@mariozechner/pi-ai"
import { Type } from "@sinclair/typebox"
import type { SessionEnv } from "../../session-env"
import type { AgentRuntimeStreamEvent, PromptModel } from "../../index"

export type PiModelBackend = {
  /** Resolved pi-ai model, e.g. `getModel("openai-codex", "gpt-5.1-codex-mini")`. */
  model: Model<Api>
  /**
   * Per-LLM-call API key resolution. OAuth-backed providers (openai-codex,
   * anthropic subscription) refresh + rotate here; the resolver owns persistence.
   */
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined
  /** System prompt for the central session. Defaults to a dispatch-oriented prompt. */
  systemPrompt?: string
  /** Test/proxy seam: overrides the LLM stream function on the Agent. */
  streamFn?: StreamFn
  /**
   * Extra AgentTools joined to the SessionEnv bash tool (e.g. the host's
   * native subagent dispatch tool). Applied at Agent creation and preserved
   * across placement swaps.
   */
  extraTools?: AgentTool[]
}

export type PiModelBackendResolverInput = {
  sessionId: string
  model?: PromptModel
}

export type PiModelResolutionErrorCode =
  | "missing_model"
  | "unsupported_model"
  | "missing_credentials"
  | "unavailable"

export class PiModelResolutionError extends Error {
  readonly code: PiModelResolutionErrorCode
  readonly model: PromptModel | undefined

  constructor(code: PiModelResolutionErrorCode, message: string, model?: PromptModel) {
    super(message)
    this.name = "PiModelResolutionError"
    this.code = code
    this.model = model
  }
}

export type PiModelBackendResolver = (
  input: PiModelBackendResolverInput,
) => Promise<PiModelBackend | undefined> | PiModelBackend | undefined

export function requirePiModel(model: PromptModel): Model<Api> {
  const resolved = getModel(
    model.providerID as Parameters<typeof getModel>[0],
    model.modelID as never,
  ) as Model<Api> | undefined
  if (resolved) {
    const baseUrl = model.providerID === "anthropic"
      ? process.env.ANTHROPIC_BASE_URL?.trim()
      : model.providerID === "openai"
        ? process.env.OPENAI_BASE_URL?.trim()
        : undefined
    return baseUrl ? { ...resolved, baseUrl } : resolved
  }
  throw new PiModelResolutionError(
    "unsupported_model",
    `Pi does not support model ${model.providerID}/${model.modelID}`,
    model,
  )
}

export type PiApiKeyBackendOptions = {
  loadApiKey: (input: {
    sessionId: string
    providerID: string
  }) => Promise<string | undefined> | string | undefined
  systemPrompt?: string
}

/** Exact-model resolver for credential owners that expose provider API keys. */
export function piApiKeyBackendResolver(options: PiApiKeyBackendOptions): PiModelBackendResolver {
  return async (input) => {
    if (!input.model) return undefined
    const model = requirePiModel(input.model)
    const apiKey = await options.loadApiKey({ sessionId: input.sessionId, providerID: input.model.providerID })
    if (!apiKey) return undefined
    return {
      model,
      getApiKey: (provider) => provider === input.model?.providerID
        ? options.loadApiKey({ sessionId: input.sessionId, providerID: provider })
        : undefined,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    }
  }
}

export const DEFAULT_PI_SYSTEM_PROMPT = [
  "You are Claxedo's central assistant session.",
  "You run on the control plane with a tools-only sandbox environment; use the bash tool for inspection or side effects.",
  "Understand the user's intent, answer concisely, and when work needs a real workspace, say what you would dispatch.",
].join(" ")

/**
 * A pi AgentTool that executes shell commands through the SessionEnv — the
 * session's tool sandbox (virtual env or a workspace runtime) — never the
 * host process's own cwd.
 */
export function sessionEnvBashTool(env: SessionEnv): AgentTool {
  return {
    name: "bash",
    label: "bash",
    description:
      "Execute a shell command in the session's sandbox environment. Returns combined stdout/stderr and the exit code.",
    parameters: Type.Object({
      command: Type.String({ description: "The shell command to execute" }),
    }),
    execute: async (_toolCallId, params, signal) => {
      const command = (params as { command: string }).command
      const result = await env.exec(command, signal ? { signal } : {})
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim() || `exit ${result.exitCode}`
      return {
        content: [{ type: "text", text: output }],
        details: result,
      }
    },
  } as AgentTool
}

/** Build (or refresh) the per-session pi Agent for a resolved backend. */
export function createPiAgent(input: {
  sessionId: string
  backend: PiModelBackend
  env: SessionEnv
}): Agent {
  return new Agent({
    initialState: {
      systemPrompt: input.backend.systemPrompt ?? DEFAULT_PI_SYSTEM_PROMPT,
      model: input.backend.model,
      tools: [sessionEnvBashTool(input.env), ...(input.backend.extraTools ?? [])],
    },
    sessionId: input.sessionId,
    getApiKey: input.backend.getApiKey,
    ...(input.backend.streamFn ? { streamFn: input.backend.streamFn } : {}),
  })
}

/** Re-point an existing Agent at a (possibly rotated) backend before a turn. */
export function refreshPiAgent(agent: Agent, backend: PiModelBackend): Agent {
  agent.state.model = backend.model
  agent.getApiKey = backend.getApiKey
  if (backend.streamFn) agent.streamFn = backend.streamFn
  return agent
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text
          : ""))
        .filter(Boolean)
        .join("\n")
      if (text) return text
    }
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function mapAgentEvent(event: AgentEvent): AgentRuntimeStreamEvent[] {
  switch (event.type) {
    case "message_update": {
      const update = event.assistantMessageEvent
      if (update.type === "text_delta") return [{ type: "text-delta", delta: update.delta }]
      if (update.type === "thinking_delta") return [{ type: "thinking-delta", delta: update.delta }]
      return []
    }
    case "tool_execution_start":
      return [
        { type: "tool-start", toolCallId: event.toolCallId, toolName: event.toolName },
        { type: "tool-input", toolCallId: event.toolCallId, input: event.args },
      ]
    case "tool_execution_end":
      return [
        event.isError
          ? { type: "tool-error", toolCallId: event.toolCallId, error: toolResultText(event.result) }
          : { type: "tool-output", toolCallId: event.toolCallId, output: toolResultText(event.result) },
      ]
    default:
      return []
  }
}

export type PiModelTurnResult = {
  /** Concatenated assistant text for message-row persistence. */
  text: string
  /** Set when the turn failed (LLM/provider error); callers surface it. */
  error?: string
}

/**
 * Run one model turn on the session's Agent, yielding runtime stream events as
 * they arrive. The generator's RETURN value carries the final text/error for
 * message-row persistence.
 */
export async function* runPiModelTurn(input: {
  agent: Agent
  prompt: string
  signal: AbortSignal
}): AsyncGenerator<AgentRuntimeStreamEvent, PiModelTurnResult> {
  const { agent, prompt, signal } = input
  const queue: AgentRuntimeStreamEvent[] = []
  let notify: (() => void) | undefined
  let done = false
  let text = ""

  const push = (events: AgentRuntimeStreamEvent[]) => {
    if (events.length === 0) return
    queue.push(...events)
    notify?.()
  }
  const unsubscribe = agent.subscribe((event) => {
    const mapped = mapAgentEvent(event)
    for (const item of mapped) {
      if (item.type === "text-delta") text += item.delta
    }
    push(mapped)
  })
  const onAbort = () => agent.abort()
  signal.addEventListener("abort", onAbort, { once: true })

  let runError: string | undefined
  const run = agent
    .prompt(prompt)
    .catch((cause: unknown) => {
      runError = cause instanceof Error ? cause.message : String(cause)
    })
    .finally(() => {
      done = true
      notify?.()
    })

  try {
    while (true) {
      while (queue.length > 0) yield queue.shift()!
      if (done) break
      await new Promise<void>((resolve) => {
        notify = resolve
      })
      notify = undefined
    }
    await run
  } finally {
    unsubscribe()
    signal.removeEventListener("abort", onAbort)
  }

  const stateError = agent.state.errorMessage
  const error = runError ?? (typeof stateError === "string" && stateError.length > 0 ? stateError : undefined)
  return { text, ...(error ? { error } : {}) }
}
