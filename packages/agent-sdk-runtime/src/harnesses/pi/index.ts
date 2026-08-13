import { randomUUID } from "node:crypto"
import {
  buildAssistantMessage,
  buildUserMessage,
  messagePartUpdated,
  messageUpdated,
  sessionError,
  type CompatPart,
} from "../../compat-events"
import {
  harnessCapabilities,
  type HarnessCapabilities,
  type HarnessCapabilityContext,
} from "../../capabilities"
import {
  type AgentAgentRow,
  type AgentCommandRow,
  type AgentConfigOptionRow,
  type AgentMessageRow,
  type AgentPermissionRow,
  type AgentQuestionRow,
  type AgentRuntimeStreamEvent,
  type AgentSessionRow,
  type PromptInput,
  type RuntimeDirectory,
  type SessionConfig,
  type SessionConfigUpdate,
} from "../../index"
import type {
  AbortResult,
  AgentHarnessAdapter,
  AgentHarnessAdapterProcessOptions,
} from "../../adapter-contract"
import { createVirtualSessionEnv } from "../../virtual-session-env"
import type { RunStore, SessionEnv, SessionEnvFactory, SessionEnvFactoryInput } from "../../session-env"
import { createMemoryRunStore } from "../../session-env"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { firstTurnErrorData } from "../../first-turn-error"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { Agent, AgentTool } from "@mariozechner/pi-agent-core"
import type { Usage as PiUsage } from "@mariozechner/pi-ai"
import {
  createPiAgent,
  PiModelResolutionError,
  refreshPiAgent,
  runPiModelTurn,
  sessionEnvBashTool,
  type PiModelBackendResolver,
} from "./model-backend"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"

type PiSession = {
  id: string
  directory?: RuntimeDirectory
  parentID?: string
  title: string | null
  created: number
  updated: number
  env: SessionEnv
  config: SessionConfig
  messages: AgentMessageRow[]
  active?: AbortController
  /** Live pi Agent for model-backed turns; lazily created at first model turn. */
  agent?: Agent
  /** Backend extra tools captured at Agent creation; preserved across placement swaps. */
  agentExtraTools?: AgentTool[]
  processOwnerId: string
  processObservation: AgentProcessObserverHandle
}

export type PiAdapterOptions = AgentHarnessAdapterProcessOptions & {
  createEnv?: SessionEnvFactory
  defaultPlacement?: PiSessionPlacement | ((input: {
    sessionId: string
    directory: RuntimeDirectory
  }) => PiSessionPlacement | Promise<PiSessionPlacement>)
  runStore?: RunStore<AgentRuntimeStreamEvent>
  eventHub?: RuntimeEventHub
  /**
   * Optional model backend (real pi turns). Resolved lazily per turn so
   * credential rotation is picked up. When absent or resolving to undefined,
   * non-exec prompts keep the historical echo behavior.
   */
  modelBackend?: PiModelBackendResolver
  toolExtensionProvider?: PiToolExtensionProvider
}

export type PiToolExtensionProvider = {
  providesSubagentTool(input: { sessionId: string; model: NonNullable<SessionConfig["model"]> }): boolean
}

export type PiSessionPlacement = Omit<SessionEnvFactoryInput, "sessionId">

function text(input: unknown) {
  return typeof input === "string" && input.trim().length > 0 ? input : undefined
}

function promptText(parts: unknown[]) {
  return parts.flatMap((part) => {
    if (typeof part === "string") return [part]
    if (!part || typeof part !== "object") return []
    const row = part as Record<string, unknown>
    if (typeof row.text === "string") return [row.text]
    if (typeof row.content === "string") return [row.content]
    const resource = row.resource
    if (resource && typeof resource === "object" && typeof (resource as Record<string, unknown>).text === "string") {
      return [(resource as Record<string, string>).text]
    }
    return []
  }).join("\n\n").trim()
}

function notImplemented(feature: string) {
  return new Error(`${feature} is not implemented for Pi central sessions yet`)
}

function row(session: PiSession): AgentSessionRow {
  return {
    id: session.id,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    title: session.title,
    slug: session.id,
    version: "central",
    time: { created: session.created, updated: session.updated },
  }
}

function defaultConfig(): SessionConfig {
  return {
    harness: { id: "pi", access: "native" },
    model: { providerID: "pi", modelID: "virtual" },
    variant: null,
    agent: null,
  }
}

function textPart(input: { sessionId: string; messageId: string; text: string; suffix: string }): CompatPart {
  return {
    id: `${input.messageId}-${input.suffix}`,
    sessionID: input.sessionId,
    messageID: input.messageId,
    type: "text",
    text: input.text,
  }
}

function putMessage(session: PiSession, message: AgentMessageRow) {
  session.messages = [
    ...session.messages.filter((item) => item.info.id !== message.info.id),
    message,
  ]
}

function runtimeEvent(input: AgentRuntimeStreamEvent): input is AgentRuntimeEvent {
  return !("properties" in input)
}

export class PiHarnessAdapter implements AgentHarnessAdapter {
  private sessions = new Map<string, PiSession>()
  private createEnv: SessionEnvFactory
  private defaultPlacement: NonNullable<PiAdapterOptions["defaultPlacement"]> | undefined
  private runStore: RunStore<AgentRuntimeStreamEvent>
  private eventHub: RuntimeEventHub | undefined
  private modelBackend: PiModelBackendResolver | undefined
  private toolExtensionProvider: PiToolExtensionProvider | undefined
  private processObserver: AgentProcessObserver | undefined

  constructor(options: PiAdapterOptions = {}) {
    this.createEnv = options.createEnv ?? (() => createVirtualSessionEnv())
    this.defaultPlacement = options.defaultPlacement
    this.runStore = options.runStore ?? createMemoryRunStore()
    this.eventHub = options.eventHub
    this.modelBackend = options.modelBackend
    this.toolExtensionProvider = options.toolExtensionProvider
    this.processObserver = options.processObserver
  }

  /** Resolve the exact selected model and (re)build the session's live Agent. */
  private async resolveModelAgent(session: PiSession): Promise<Agent | undefined> {
    const configured = session.config.model
    const model = configured?.providerID === "pi" && configured.modelID === "virtual" ? undefined : configured
    if (!this.modelBackend) {
      if (model) {
        throw new PiModelResolutionError(
          "unavailable",
          `Pi model ${model.providerID}/${model.modelID} is unavailable because no model backend is configured`,
          model,
        )
      }
      return undefined
    }
    const backend = await this.modelBackend({ sessionId: session.id, ...(model ? { model } : {}) })
    if (!backend) {
      if (model) {
        throw new PiModelResolutionError(
          "missing_credentials",
          `Pi model ${model.providerID}/${model.modelID} has no available credentials`,
          model,
        )
      }
      return undefined
    }
    if (model && (backend.model.provider !== model.providerID || backend.model.id !== model.modelID)) {
      throw new PiModelResolutionError(
        "unsupported_model",
        `Pi selected ${model.providerID}/${model.modelID}, but the backend resolved ${backend.model.provider}/${backend.model.id}`,
        model,
      )
    }
    if (session.agent) {
      refreshPiAgent(session.agent, backend)
    } else {
      session.agent = createPiAgent({ sessionId: session.id, backend, env: session.env })
      session.agentExtraTools = backend.extraTools ?? []
    }
    return session.agent
  }

  async listSessions(directory: RuntimeDirectory) {
    return [...this.sessions.values()]
      .filter((session) => session.directory === directory)
      .map(row)
  }

  async getSession(id: string, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    return session ? row(session) : null
  }

  async createSession(directory: RuntimeDirectory, title?: string, id: string = randomUUID()) {
    return await this.bindSession({ id, title, directory })
  }

  async createHandoffSession(directory: RuntimeDirectory, title: string | undefined, id: string) {
    if (this.sessions.has(id)) await this.deleteSession(id, directory)
    return { ...await this.bindSession({ id, title, directory }), ownerKey: null }
  }

  async bindSession(input: { id: string; parentID?: string; title?: string | null; directory?: RuntimeDirectory; placement?: PiSessionPlacement }) {
    const existing = this.sessions.get(input.id)
    if (existing) {
      // Placement is applied only when the session env is first attached.
      // Re-binding an existing session is an idempotent metadata update.
      existing.title = input.title === undefined ? existing.title : input.title
      if (input.parentID) existing.parentID = input.parentID
      existing.updated = Date.now()
      return { id: existing.id }
    }
    const now = Date.now()
    const placement = await this.sessionEnvInput(input)
    const processOwnerId = `pi-session:${input.id}`
    const processObservation = observeAgentProcess(this.processObserver, {
      ownerId: processOwnerId,
      launchId: randomUUID(),
      harnessId: "pi",
      access: "native",
      role: "harness",
      label: "Pi in-process model runtime",
      locality: "in-process",
      confidence: "direct",
      capabilities: {
        resourceMetrics: "shared-process",
        ownerActions: false,
      },
      ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
      ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
      sessionId: input.id,
    })
    processObservation.update({ lifecycle: "ready" })
    this.sessions.set(input.id, {
      id: input.id,
      ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
      ...(input.parentID ? { parentID: input.parentID } : {}),
      title: input.title ?? null,
      created: now,
      updated: now,
      env: observePiSessionEnv(
        await this.createEnv(placement),
        {
          ownerId: processOwnerId,
          sessionId: input.id,
          ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
          ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
        },
        this.processObserver,
      ),
      config: defaultConfig(),
      messages: [],
      processOwnerId,
      processObservation,
    })
    return { id: input.id }
  }

  private async sessionEnvInput(input: { id: string; directory?: RuntimeDirectory; placement?: PiSessionPlacement }): Promise<SessionEnvFactoryInput> {
    const placement = input.placement
      ?? (typeof this.defaultPlacement === "function"
        ? await this.defaultPlacement({ sessionId: input.id, directory: input.directory })
        : this.defaultPlacement)
      ?? {
        mode: "hybrid" as const,
        host: "central" as const,
        toolSandbox: { kind: "virtual" as const, id: input.id },
      }
    return {
      sessionId: input.id,
      mode: placement.mode,
      host: placement.host,
      ...(placement.directory ? { directory: placement.directory } : input.directory ? { directory: input.directory } : {}),
      ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
      ...(placement.toolSandbox ? { toolSandbox: placement.toolSandbox } : {}),
    }
  }

  async updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    if (!session) return null
    session.title = updates.title ?? session.title
    session.updated = Date.now()
    return row(session)
  }

  async getSessionConfig(id: string, _directory: RuntimeDirectory) {
    return this.sessions.get(id)?.config ?? defaultConfig()
  }

  async updateSessionConfig(id: string, update: SessionConfigUpdate, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    if (!session) return defaultConfig()
    if (update.model !== undefined && session.active) {
      throw new Error("Start a new Pi session to use another model")
    }
    session.config = {
      harness: update.harness ?? session.config.harness,
      ...(update.model === undefined
        ? session.config.model ? { model: session.config.model } : {}
        : update.model ? { model: update.model } : {}),
      variant: update.variant === undefined ? session.config.variant ?? null : update.variant,
      agent: update.agent === undefined ? session.config.agent ?? null : update.agent,
    }
    return session.config
  }

  async deleteSession(id: string, _directory: RuntimeDirectory) {
    const session = this.sessions.get(id)
    await session?.env.dispose?.()
    session?.processObservation.exit({ reason: "disposed" })
    this.sessions.delete(id)
  }

  /**
   * Swap the session's tool placement MID-CONVERSATION (Demo B): dispose the
   * old SessionEnv, create one for the new placement, and re-point the live
   * Agent's tools at it. Conversation history is untouched. Refused while a
   * turn is active — a running tool call must never have its env ripped out.
   */
  async updateSessionPlacement(id: string, placement: PiSessionPlacement): Promise<{ ok: true }> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    if (session.active) throw new Error("Session has an active turn; placement can only change while idle")
    const envInput = await this.sessionEnvInput({ id, placement })
    const nextEnv = observePiSessionEnv(
      await this.createEnv(envInput),
      {
        ownerId: session.processOwnerId,
        sessionId: id,
        ...(envInput.workspaceId ? { workspaceId: envInput.workspaceId } : {}),
        ...(envInput.directory ? { directory: envInput.directory } : {}),
      },
      this.processObserver,
    )
    const previous = session.env
    session.env = nextEnv
    if (session.agent) {
      session.agent.state.tools = [sessionEnvBashTool(nextEnv), ...(session.agentExtraTools ?? [])]
    }
    session.updated = Date.now()
    await previous.dispose?.()
    return { ok: true }
  }

  async readHarnessCapabilities(_directory: RuntimeDirectory, context?: HarnessCapabilityContext): Promise<HarnessCapabilities> {
    const session = context?.sessionId ? this.sessions.get(context.sessionId) : undefined
    const model = session?.config.model
    const supportsSubagentTool = !!(
      session &&
      model &&
      !(model.providerID === "pi" && model.modelID === "virtual") &&
      this.modelBackend &&
      this.toolExtensionProvider?.providesSubagentTool({ sessionId: session.id, model })
    )
    const backend = supportsSubagentTool && session && model
      ? await this.modelBackend?.({ sessionId: session.id, model })
      : undefined
    const subagents = !!backend?.extraTools?.some((tool) => tool.name === "subagent")
    return harnessCapabilities({
      harness: "pi",
      abort: true,
      reconnect: true,
      replay: true,
      // Pi raises no permission requests, so the auto-accept command that gates
      // on this would toggle something with nothing to answer.
      permissions: false,
      questions: false,
      todos: false,
      commands: false,
      fork: false,
      revert: false,
      unrevert: false,
      configOptions: false,
      subagents,
    })
  }

  async *sendMessage(id: string, input: PromptInput, directory: RuntimeDirectory): AsyncIterable<AgentRuntimeStreamEvent> {
    const session = this.sessions.get(id)
    if (!session) {
      yield sessionError(`Session ${id} not found`, id)
      return
    }
    const abort = new AbortController()
    session.active = abort
    const scope = directory ?? id
    const emit = (event: AgentRuntimeStreamEvent) => {
      this.runStore.appendEvent({ runId: id, payload: event })
      if (runtimeEvent(event)) {
        this.eventHub?.publishRuntime({
          directory: scope,
          sessionId: id,
          assistantMessageId: input.assistantMessageId,
          payload: event,
        })
      }
      return event
    }
    let assistantText = ""
    let assistantError: string | undefined
    let assistantUsage: PiUsage | undefined
    const assistant = {
      id: input.assistantMessageId,
      sessionID: id,
      parentID: input.userMessageId ?? id,
      agent: input.agent,
      model: input.model,
      directory: scope,
      ...(input.variant ? { variant: input.variant } : {}),
    }
    try {
      if (input.userMessageId) {
        const prompt = promptText(input.parts)
        const user = {
          info: buildUserMessage({
          id: input.userMessageId,
          sessionID: id,
          agent: input.agent,
          model: input.model,
          ...(input.author ? { author: input.author } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.format ? { format: input.format } : {}),
          ...(input.system ? { system: input.system } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          }),
          parts: prompt ? [textPart({ sessionId: id, messageId: input.userMessageId, text: prompt, suffix: "input" })] : [],
        }
        putMessage(session, user)
        yield emit(messageUpdated(user.info))
        if (user.parts[0]) yield emit(messagePartUpdated(user.parts[0]))
      }
      const info = buildAssistantMessage(assistant)
      putMessage(session, { info, parts: [] })
      yield emit(messageUpdated(info))
      yield emit({ type: "session-status", status: "busy" })
      const executable = promptText(input.parts)
      const command = text(executable.match(/^\/?bash\s+([\s\S]+)/)?.[1]) ?? text(executable.match(/^exec:\s*([\s\S]+)/i)?.[1])
      if (command) {
        const result = await session.env.exec(command, { signal: abort.signal })
        const output = result.stdout || result.stderr || `exit ${result.exitCode}`
        if (output) {
          assistantText = output
          yield emit({ type: "text-delta", delta: output })
        }
      } else if (executable) {
        const agent = await this.resolveModelAgent(session)
        if (agent) {
          // Real pi model turn: LLM via the resolved backend (e.g. the
          // openai-codex subscription provider), tools via the SessionEnv.
          const turn = runPiModelTurn({ agent, prompt: executable, signal: abort.signal })
          while (true) {
            const next = await turn.next()
            if (next.done) {
              assistantText = next.value.text
              assistantUsage = next.value.usage
              if (next.value.error) throw new Error(next.value.error)
              break
            }
            yield emit(next.value)
          }
        } else {
          throw new Error("This legacy Pi session has no configured model. Start a new Pi session and choose a model.")
        }
      }
    } catch (cause) {
      assistantError = cause instanceof Error ? cause.message : String(cause)
    } finally {
      session.active = undefined
      session.updated = Date.now()
    }
    const completed = Date.now()
    if (input.userMessageId) {
      const prompt = promptText(input.parts)
      putMessage(session, {
        info: buildUserMessage({
          id: input.userMessageId,
          sessionID: id,
          agent: input.agent,
          model: input.model,
          ...(input.author ? { author: input.author } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.format ? { format: input.format } : {}),
          ...(input.system ? { system: input.system } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
        }),
        parts: prompt ? [textPart({ sessionId: id, messageId: input.userMessageId, text: prompt, suffix: "input" })] : [],
      })
    }
    if (assistantUsage) {
      yield emit({
        type: "usage",
        contextSize: assistantUsage.totalTokens,
        contextUsed: assistantUsage.totalTokens,
        observation: {
          kind: "cumulative",
          nativeSessionId: session.id,
          tokens: {
            input: assistantUsage.input,
            output: assistantUsage.output,
            reasoning: null,
            cache: { read: assistantUsage.cacheRead, write: assistantUsage.cacheWrite },
          },
        },
      })
    }
    const info = {
      ...buildAssistantMessage({
        ...assistant,
        completed,
        ...(assistantError
          ? { error: { name: "UnknownError", data: firstTurnErrorData(assistantError) } }
          : { finish: "stop" }),
      }),
      ...(assistantUsage
        ? {
            tokens: {
              input: assistantUsage.input,
              output: assistantUsage.output,
              reasoning: 0,
              cache: { read: assistantUsage.cacheRead, write: assistantUsage.cacheWrite },
            },
          }
        : {}),
    }
    putMessage(session, {
      info,
      parts: assistantText
        ? [textPart({ sessionId: id, messageId: input.assistantMessageId, text: assistantText, suffix: "text" })]
        : [],
    })
    yield emit(messageUpdated(info))
    if (assistantError) {
      yield emit({ type: "session-status", status: "error" })
      yield emit({ type: "error", error: assistantError })
      return
    }
    yield emit({ type: "session-status", status: "idle" })
    yield emit({ type: "finish", sessionId: id })
  }

  async getMessages(id: string, _directory: RuntimeDirectory) {
    return this.sessions.get(id)?.messages ?? []
  }

  async abort(id: string, _directory: RuntimeDirectory): Promise<AbortResult> {
    const session = this.sessions.get(id)
    if (!session?.active) return { ok: true, status: "already_idle" }
    session.active.abort()
    session.active = undefined
    return { ok: true, status: "cancelled" }
  }

  async revert() {
    throw notImplemented("Revert")
  }

  async unrevert() {
    throw notImplemented("Unrevert")
  }

  async forkSession(): Promise<{ id: string }> {
    throw notImplemented("Fork")
  }

  async executeCommand() {
    throw notImplemented("Commands")
  }

  async listCommands(): Promise<AgentCommandRow[]> {
    return []
  }

  async listAgents(): Promise<AgentAgentRow[]> {
    return []
  }

  async getTodos() {
    return []
  }

  /**
   * Pi never asks. Its tools run in `just-bash` over an `InMemoryFs` — see
   * `createVirtualSessionEnv` — so there is nothing to gate and no request to
   * raise. Both members stay because the port requires them.
   */
  async listPermissions(_directory?: RuntimeDirectory): Promise<AgentPermissionRow[]> {
    return []
  }

  async respondPermission(
    _permId: string,
    _decision: "allow_once" | "allow_always" | "deny" | "reject_always",
    _directory?: RuntimeDirectory,
  ) {}

  async listQuestions(): Promise<AgentQuestionRow[]> {
    return []
  }

  async replyQuestion() {}

  async rejectQuestion() {}

  async applyConfig() {}

  async probeConfigOptions(): Promise<AgentConfigOptionRow[]> {
    throw new Error("pi does not expose harness config options")
  }

  dispose() {
    for (const session of this.sessions.values()) {
      session.processObservation.exit({ reason: "disposed" })
      void session.env.dispose?.()
    }
    this.sessions.clear()
  }
}

function observePiSessionEnv(
  env: SessionEnv,
  input: {
    ownerId: string
    sessionId: string
    workspaceId?: string
    directory?: string
  },
  observer?: AgentProcessObserver,
): SessionEnv {
  return {
    ...env,
    async exec(command, options) {
      const handle = observeAgentProcess(observer, {
        ownerId: `pi-tool:${randomUUID()}`,
        launchId: randomUUID(),
        harnessId: "pi",
        access: "native",
        role: "tool",
        label: "Pi SessionEnv command",
        locality: env.kind === "workspace-runtime" ? "local-process" : "in-process",
        confidence: env.kind === "workspace-runtime" ? "inferred" : "direct",
        capabilities: {
          resourceMetrics: env.kind === "workspace-runtime" ? "process" : "shared-process",
          ownerActions: false,
        },
        parentOwnerId: input.ownerId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.directory ? { directory: input.directory } : {}),
        sessionId: input.sessionId,
      })
      try {
        const result = await env.exec(command, options)
        handle.exit({ reason: "exited", exitCode: result.exitCode })
        return result
      } catch (cause) {
        handle.exit({
          reason: options?.signal?.aborted ? "cancelled" : "error",
        })
        throw cause
      }
    },
  }
}
