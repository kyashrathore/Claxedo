import {
  createAgentEventRuntime,
  type AgentEventRuntime,
  type RuntimeGoalSnapshot,
} from "@claxedo/agent-event-runtime"
import {
  cursorRuntimeMessage,
  cursorSdkAdapter,
  cursorSubagentObservations,
} from "@claxedo/agent-event-runtime/harnesses/cursor"
import type {
  McpServerConfig as CursorMcpServerConfig,
  SDKAgent as CursorSDKAgent,
  SDKMessage,
  SDKUserMessage as CursorSDKUserMessage,
} from "@cursor/sdk"
import type { AgentConfigOption } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import { goalCapabilities } from "../../capabilities"
import { resolvedMcpServers, type ResolvedMcpServer } from "../../mcp-resolver"
import { firstPartyMcpProvider, type FirstPartyMcpProvider } from "../../first-party-mcp"
import { randomUUID } from "crypto"
import { createLiveModelSource } from "../../live-model-source"
import { modelConfigOption, type SdkModelEntry } from "../../sdk-model-options"
import {
  CURSOR_PERMISSION_MODES,
  PermissionModeSelection,
  cursorPermissionOptions,
} from "../shared/permission-modes"
import { asRecord } from "@claxedo/helpers/guards"
import {
  errorMessage,
  text,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTranscriptRegistrar,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import {
  isProviderUnavailable,
  providerBinding,
  providerProjectionRecord,
  type ProviderProjection,
} from "../../provider-projection"
import {
  applyCursorBackendUrl,
  CursorBackendUrlFrozenError,
  freezeCursorBackendUrl,
  frozenCursorBackendUrl,
} from "./auth"
import { harnessProjection } from "../../harness-projection"
import { createNativeGoalStore, nativeGoalCommand } from "../shared/native-goal-store"
import {
  deliverPromptAttachments,
  promptImageAttachments,
  type PromptDelivery,
} from "../shared/prompt-attachments"
import {
  observeAgentProcess,
  type AgentProcessObserverHandle,
} from "../../process-observer"

const CURSOR_PENDING_PREFIX = "cursor-sdk:"
const CURSOR_SDK_AUTH_ERROR =
  "Cursor SDK requires an explicit cursor-sdk API key. Cursor ACP can use the local Cursor login."
type CursorEntry = {
  directory: string
  agent: CursorSDKAgent
  observation: AgentProcessObserverHandle
}

/**
 * The Agent Plugins launch payload names the plugin roots materialized on disk
 * for this workspace. Cursor reads them through its own `plugins` setting
 * source, so the driver only has to name the roots and turn the source on.
 */
export function cursorPluginRoots(launch: unknown) {
  const roots = asRecord(asRecord(launch)?.config)?.pluginRoots ?? asRecord(launch)?.pluginRoots
  if (roots === undefined) return []
  if (!Array.isArray(roots)) {
    throw new Error("Cursor Agent Plugins launch config requires pluginRoots to be an array of non-empty paths")
  }
  const paths = roots.filter((root): root is string => typeof root === "string" && root.trim().length > 0)
  if (paths.length !== roots.length) {
    throw new Error("Cursor Agent Plugins launch config requires pluginRoots to be an array of non-empty paths")
  }
  return [...new Set(paths)]
}

export function cursorPluginLocalOptions(pluginRoots: readonly string[]) {
  return pluginRoots.length ? { settingSources: ["plugins" as const] } : {}
}

type CursorSdkModule = Pick<typeof import("@cursor/sdk"), "Agent" | "Cursor">

export type CursorSdkDriverOptions = {
  /**
   * Injects the whole `@cursor/sdk` surface this driver touches. The model
   * catalog probe needs `Cursor`, so only this form can stand in for it.
   */
  loadSdk?: () => Promise<CursorSdkModule>
  /** The narrower form, for callers that only exercise agent creation. */
  loadAgent?: () => Promise<Pick<typeof import("@cursor/sdk"), "Agent">>
}

export function createCursorSdkDriver(
  host: SdkRuntimeDriverHost,
  options: CursorSdkDriverOptions = {},
): SdkRuntimeDriver {
  return new CursorSdkDriver(host, options)
}

/**
 * The message `Agent.send` receives.
 *
 * A text-only turn stays a plain string. An image attachment rides the
 * message's `images` array as bytes, while the text still names the workspace
 * path it was written to; Cursor has no input for any other attachment type, so
 * those reach it through their path line alone.
 */
export function cursorTurnPrompt(delivery: PromptDelivery, system?: string): string | CursorSDKUserMessage {
  const text = system ? `${system}\n\n${delivery.text}` : delivery.text
  const images = promptImageAttachments(delivery)
    .map((attachment) => ({ data: attachment.base64, mimeType: attachment.mime }))
  return images.length ? { text, images } : text
}

/**
 * The machine's own key: the ambient fallback a workspace with no Cursor account
 * bound runs on, and the variable `AGENT_HARNESS_DEFINITIONS` already names for
 * this harness.
 */
function ambientCursorApiKey() {
  return process.env.CURSOR_API_KEY?.trim() || undefined
}

class CursorSdkDriver implements SdkRuntimeDriver {
  readonly type = "cursor" as const
  readonly interactions = { permissions: false, questions: false } as const
  private readonly goalStore = createNativeGoalStore()
  readonly nativeGoal: NonNullable<SdkRuntimeDriver["nativeGoal"]> = {
    capabilities: () => {
      const available = this.hasCursorAuth()
      return goalCapabilities({
        implemented: true,
        available,
        ...(!available ? { unavailableReason: CURSOR_SDK_AUTH_ERROR } : {}),
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      })
    },
    read: (sessionId) => this.goalStore.read(sessionId),
    run: (input, objective, onGoal) => this.runGoal(input, objective, onGoal),
    stop: (sessionId) => this.goalStore.stop(sessionId),
    // Deleting drops Claxedo's record of the Goal. Cursor Goal snapshots are
    // synthesized locally around the run, so no provider state re-emits a
    // forgotten Goal.
    delete: async (sessionId) => {
      const had = !!this.goalStore.peek(sessionId)
      this.goalStore.forget(sessionId)
      return had
    },
  }
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private firstPartyMcp: FirstPartyMcpProvider | undefined
  private currentPluginRoots: string[] = []
  private agents = new Map<string, CursorEntry>()
  private processError: string | null = null
  private readonly modelSource = createLiveModelSource({
    harness: "cursor",
    fetchModels: () => this.fetchModels(),
  })

  private auth: ProviderProjection | undefined

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly driverOptions: CursorSdkDriverOptions = {},
  ) {}

  private replaceAuth(projection: ProviderProjection | undefined) {
    this.auth = projection
    applyCursorBackendUrl(projection)
    this.modelSource.invalidate()
  }

  /** The key every SDK call carries: the binding's placeholder, else the machine's own. */
  private cursorApiKey() {
    return providerBinding("cursor", this.auth)?.placeholder ?? ambientCursorApiKey()
  }

  /** Whether a turn could authenticate at all, asked where throwing would be wrong. */
  private hasCursorAuth() {
    if (this.auth) return !isProviderUnavailable(this.auth)
    return !!ambientCursorApiKey()
  }

  applyConfig(config: Record<string, unknown>) {
    const auth = providerProjectionRecord(config.auth)
    if (config.auth !== undefined && !auth) {
      throw new Error("cursor harness received an auth map that is not provider projections")
    }
    this.replaceAuth(harnessProjection(auth, "cursor"))
    this.currentMcp = resolvedMcpServers(config.mcp) ?? {}
    this.firstPartyMcp = firstPartyMcpProvider(config)
    // Plugin roots are read by `Agent.create`, so a changed set only reaches
    // Cursor through a new agent — the live ones are disposed to force it.
    const nextPluginRoots = cursorPluginRoots(config.launch)
    if (JSON.stringify(nextPluginRoots) !== JSON.stringify(this.currentPluginRoots)) {
      for (const item of this.agents.values()) {
        item.observation.exit({ reason: "disposed" })
        item.agent.close()
      }
      this.agents.clear()
      this.currentPluginRoots = nextPluginRoots
    }
  }

  /**
   * `Agent.create` runs before a Claxedo session id exists, so it carries the
   * user's servers only; every `send` names the session and adds the
   * first-party entry.
   */
  private mcpServersFor(sessionId: string): { mcpServers?: Record<string, CursorMcpServerConfig> } {
    const firstParty = this.firstPartyMcp?.server(sessionId)
    const mcpServers = {
      ...cursorMcpServers(this.currentMcp),
      ...(firstParty ? { [firstParty.name]: { type: "http" as const, url: firstParty.url, headers: firstParty.headers } } : {}),
    }
    return Object.keys(mcpServers).length ? { mcpServers } : {}
  }

  /**
   * Keyed by DIRECTORY, not session id — the one place in this file that departs
   * from how the other drivers store this.
   *
   * Forced by where the options are read: `Agent.create` consumes them, and it
   * runs before a Claxedo session id exists to key on. Keying by directory also
   * matches what the setting can actually promise — "the next Cursor agent in
   * this workspace" — rather than implying it is scoped to a conversation it
   * cannot reach.
   */
  private readonly permissionSelection = new PermissionModeSelection(CURSOR_PERMISSION_MODES, "next-session")

  permissionModes(_sessionId: string, directory: string) {
    return this.permissionSelection.state(directory)
  }

  async setPermissionMode(_sessionId: string, modeId: string, directory: string) {
    return this.permissionSelection.set(directory, modeId)
  }

  async createAgentSession(input: { directory: string; title?: string; model: string }) {
    const { Agent } = await this.loadAgent()
    const model = cursorSdkModel(input.model)
    const apiKey = this.cursorApiKey()
    const observation = this.observeAgent(input.directory)
    try {
      const agent = await Agent.create({
        ...(model ? { model } : {}),
        ...(input.title ? { name: input.title } : {}),
        ...(Object.keys(this.currentMcp).length ? { mcpServers: cursorMcpServers(this.currentMcp) } : {}),
        ...(apiKey ? { apiKey } : {}),
        local: {
          cwd: input.directory,
          ...cursorPluginLocalOptions(this.currentPluginRoots),
          // Cursor reads permission policy while creating the local agent, so
          // mode changes apply to the next session.
          ...cursorPermissionOptions(this.permissionSelection.currentId(input.directory)),
        },
      })
      observation.update({ lifecycle: "ready" })
      this.agents.set(agent.agentId, { directory: input.directory, agent, observation })
      this.processError = null
      return { id: agent.agentId }
    } catch (cause) {
      observation.exit({ reason: "error" })
      throw cause
    }
  }

  createRuntime(threadId: string): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: cursorSdkAdapter(),
    })
  }

  async runTurn(input: SdkRuntimeTurnInput) {
    const agent = await this.ensureAgent(input.sessionId, input.getAgentSessionId(), input.directory)
    const model = cursorSdkModel(text(input.input.model.modelID) ?? text(input.model))
    const delivery = await deliverPromptAttachments({ parts: input.input.parts, directory: input.directory })
    const run = await agent.send(cursorTurnPrompt(delivery, input.input.system), {
      ...(model ? { model } : {}),
      ...this.mcpServersFor(input.sessionId),
      ...(input.input.agent === "plan" ? { mode: "plan" as const } : {}),
      local: {
        force: false,
      },
    })
    const onAbort = () => run.cancel().catch(() => {})
    input.abort.signal.addEventListener("abort", onAbort, { once: true })
    this.host.lifecycle().set(input.sessionId, {
      abort: input.abort,
      turnId: run.id,
      close: () => run.cancel().catch(() => {}),
    })
    try {
      for await (const message of run.stream()) {
        await ingestCursorSdkMessage(input, message, this.host.transcriptRegistrar)
      }
      const result = await run.wait()
      input.ingest({
        source: "cursor.local-run-stream",
        method: "result",
        payload: {
          type: "result",
          agentId: agent.agentId,
          runId: run.id,
          status: result.status,
          ...(result.result ? { result: result.result } : {}),
        },
      }, {
        dir: "in",
        method: "cursor.result",
        frame: result,
      })
    } finally {
      input.abort.signal.removeEventListener("abort", onAbort)
    }
  }

  private async runGoal(
    input: SdkRuntimeTurnInput,
    objective: string,
    onGoal: (goal: RuntimeGoalSnapshot | null) => void,
  ) {
    const applyGoal = (goal: RuntimeGoalSnapshot) => {
      this.goalStore.apply(input.sessionId, goal)
      onGoal(goal)
      this.host.publishGoal({ sessionId: input.sessionId, directory: input.directory, goal })
    }
    const agent = await this.ensureAgent(input.sessionId, input.getAgentSessionId(), input.directory)
    const model = cursorSdkModel(text(input.input.model.modelID) ?? text(input.model))
    const run = await agent.send(nativeGoalCommand(objective), {
      ...(model ? { model } : {}),
      ...this.mcpServersFor(input.sessionId),
      local: { force: false },
    })
    const now = Date.now()
    applyGoal({
      sessionId: input.sessionId,
      objective,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    const onAbort = () => run.cancel().catch(() => {})
    input.abort.signal.addEventListener("abort", onAbort, { once: true })
    this.host.lifecycle().set(input.sessionId, {
      abort: input.abort,
      turnId: run.id,
      close: () => run.cancel().catch(() => {}),
    })
    try {
      for await (const message of run.stream()) {
        await ingestCursorSdkMessage(input, message, this.host.transcriptRegistrar)
      }
      const result = await run.wait()
      const current = this.goalStore.peek(input.sessionId)
      const status = result.status === "finished"
        ? "complete"
        : result.status === "cancelled"
        ? "paused"
        : "blocked"
      if (current) applyGoal({ ...current, status, updatedAt: Date.now() })
    } catch (cause) {
      // The run carried the Goal: if it died, nothing is left to advance it, so
      // the Goal must not stay `active` and unstoppable. A cancelled run settles
      // the same way `run.wait()` reports one.
      const settled = this.goalStore.settleUnfinished(
        input.sessionId,
        input.abort.signal.aborted
          ? { status: "paused" }
          : { status: "blocked", reason: errorMessage(cause) },
      )
      if (settled) applyGoal(settled)
      throw cause
    } finally {
      input.abort.signal.removeEventListener("abort", onAbort)
    }
  }

  deleteAgentSession(sessionId: string, agentSessionId: string) {
    this.goalStore.forget(sessionId)
    const entry = this.agents.get(agentSessionId)
    entry?.observation.exit({ reason: "disposed" })
    entry?.agent.close()
    this.agents.delete(agentSessionId)
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    if (!this.processError) return { status: "ok" }
    return {
      status: "degraded",
      reason: "harness_process_lost",
      message: this.processError,
    }
  }

  dispose() {
    for (const item of this.agents.values()) {
      item.observation.exit({ reason: "disposed" })
      item.agent.close()
    }
    this.agents.clear()
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    this.requireCursorSdkAuth()
    const models = await this.modelSource.models(directory)
    if (models.length === 0) throw new Error(CURSOR_SDK_AUTH_ERROR)
    return [modelConfigOption(models, currentModel)]
  }

  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[] {
    if (!this.hasCursorAuth()) return []
    const models = this.modelSource.peek(directory)
    if (models.length === 0) return []
    return [modelConfigOption(models, currentModel)]
  }

  private requireCursorSdkAuth() {
    if (!this.cursorApiKey()) throw new Error(CURSOR_SDK_AUTH_ERROR)
  }

  /**
   * `Cursor.models.list` is a cloud catalog call (needs the cursor-sdk API key,
   * or CURSOR_API_KEY). "auto" is a selection mode rather than a catalog entry,
   * so it's pinned ahead of the listed models to keep the default selectable.
   */
  private async fetchModels(): Promise<SdkModelEntry[]> {
    this.requireCursorSdkAuth()
    const observation = observeAgentProcess(this.host.processObserver, {
      ownerId: `cursor-probe:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "cursor",
      access: "native",
      role: "probe",
      label: "Cursor model catalog probe",
      locality: "remote",
      confidence: "not-process-backed",
      capabilities: {
        resourceMetrics: "none",
        ownerActions: false,
      },
    })
    observation.update({ lifecycle: "ready" })
    try {
      const { Cursor } = await this.loadSdk()
      const apiKey = this.cursorApiKey()
      const listed = await Cursor.models.list(apiKey ? { apiKey } : undefined)
      const models: SdkModelEntry[] = listed.map((model) => ({
        id: model.id,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
      }))
      if (models.length > 0 && !models.some((model) => model.id === "auto")) {
        models.unshift({ id: "auto", name: "Auto", isDefault: true })
      }
      return models
    } finally {
      observation.exit({ reason: "disposed" })
    }
  }

  private async ensureAgent(sessionId: string, agentSessionId: string, directory: string) {
    const existing = this.agents.get(agentSessionId)
    if (existing?.directory === directory) return existing.agent
    existing?.observation.exit({ reason: "disposed" })
    existing?.agent.close()
    const { Agent } = await this.loadAgent()
    const apiKey = this.cursorApiKey()
    const observation = this.observeAgent(directory, sessionId)
    let agent: CursorSDKAgent
    try {
      agent = agentSessionId.startsWith(CURSOR_PENDING_PREFIX)
        ? await Agent.create({
            ...(apiKey ? { apiKey } : {}),
            local: {
              cwd: directory,
              ...cursorPluginLocalOptions(this.currentPluginRoots),
            },
          })
        : await Agent.resume(agentSessionId, {
            ...(apiKey ? { apiKey } : {}),
            local: {
              cwd: directory,
              ...cursorPluginLocalOptions(this.currentPluginRoots),
            },
          })
    } catch (cause) {
      observation.exit({ reason: "error" })
      throw cause
    }
    observation.update({ lifecycle: "ready" })
    this.agents.set(agent.agentId, { directory, agent, observation })
    if (agent.agentId !== agentSessionId) {
      this.host.bindSession({ sessionId, directory, agentSessionId: agent.agentId })
    }
    this.processError = null
    return agent
  }

  /**
   * Everything `Agent.create`/`Agent.resume` needs; the narrow injection wins.
   *
   * The backend URL is captured at the same moment, because the module freezes
   * it as it loads and a binding that names a different one can never be spent
   * through this process again.
   */
  private async loadAgent() {
    // Before the injection branch: the freeze is what the SDK's module scope
    // does as it loads, so a driver handed a loaded module has to record it
    // too or the mismatch guard reads an empty freeze and passes everything.
    freezeCursorBackendUrl()
    const loaded = await (this.driverOptions.loadAgent?.() ?? this.loadSdk())
    const required = providerBinding("cursor", this.auth)?.baseUrl
    const frozen = frozenCursorBackendUrl()
    // Both directions of one mismatch: a binding the frozen value cannot reach,
    // and a frozen binding this workspace no longer selects — which would send
    // the machine's own key to the broker.
    if (frozen && frozen.value !== required && (required || frozen.binding)) {
      throw new CursorBackendUrlFrozenError(frozen.value, required)
    }
    return loaded
  }

  /** The full module, required by the `Cursor.models.list` catalog probe. */
  private loadSdk(): Promise<CursorSdkModule> {
    freezeCursorBackendUrl()
    return this.driverOptions.loadSdk?.() ?? import("@cursor/sdk")
  }

  private observeAgent(directory: string, sessionId?: string): AgentProcessObserverHandle {
    const ownerId = `cursor-agent:${randomUUID()}`
    const handles = [
      observeAgentProcess(this.host.processObserver, {
        ownerId,
        launchId: randomUUID(),
        harnessId: "cursor",
        access: "native",
        role: "harness",
        label: "Cursor local agent",
        locality: "local-process",
        confidence: "inferred",
        capabilities: {
          resourceMetrics: "process",
          ownerActions: false,
        },
        directory,
        ...(sessionId ? { sessionId } : {}),
        executableBasename: "cursor-agent",
      }),
      ...Object.values(this.currentMcp).map((server) => observeAgentProcess(this.host.processObserver, {
        ownerId: `cursor-mcp:${randomUUID()}`,
        launchId: randomUUID(),
        harnessId: "cursor",
        access: "native",
        role: "mcp" as const,
        label: `MCP ${server.name}`,
        locality: server.transport === "stdio" ? "local-process" as const : "remote" as const,
        confidence: server.transport === "stdio" ? "inferred" as const : "not-process-backed" as const,
        capabilities: {
          resourceMetrics: server.transport === "stdio" ? "process" as const : "none" as const,
          ownerActions: false,
        },
        parentOwnerId: ownerId,
        directory,
        ...(sessionId ? { sessionId } : {}),
        mcpName: server.name,
        transport: server.transport === "stdio" ? "stdio" as const : "streamable-http" as const,
        ...(server.transport === "stdio"
          ? { executableBasename: server.command.split(/[\\/]/).at(-1) || "mcp" }
          : {}),
      })),
    ]
    let exited = false
    return {
      update(event) {
        handles.forEach((handle) => handle.update(event))
      },
      exit(event) {
        if (exited) return
        exited = true
        handles.forEach((handle) => handle.exit(event))
      },
    }
  }
}

export async function ingestCursorSdkMessage(
  input: Pick<SdkRuntimeTurnInput, "sessionId" | "ingest" | "observeSubagent" | "rebindAgentSession">,
  message: SDKMessage,
  transcriptRegistrar?: SdkRuntimeTranscriptRegistrar,
) {
  const sdkSessionId = text(asRecord(message)?.agent_id)
  if (sdkSessionId) input.rebindAgentSession(sdkSessionId)
  const frame = cursorRuntimeMessage(message)
  const observations = cursorSubagentObservations(message)
  const transcript = observations.length
    ? await cursorTranscript(input.sessionId, message, transcriptRegistrar)
    : { kind: "none" as const }
  await Promise.all(observations.map((observation) => input.observeSubagent({
    observation: { ...observation, transcript },
    correlationKeys: [observation.toolCallId, observation.providerId]
      .filter((key): key is string => !!key),
    source: {
      dir: "in",
      method: `cursor.${message.type}`,
      frame,
    },
  })))
  input.ingest({
    source: "cursor.sdk.message",
    method: `cursor/${message.type}`,
    payload: frame,
  }, {
    dir: "in",
    method: `cursor.${message.type}`,
    frame,
  }, { kind: "parent" })
}

function cursorTranscript(
  parentSessionId: string,
  message: SDKMessage,
  registrar?: SdkRuntimeTranscriptRegistrar,
) {
  const filePath = cursorTaskTranscriptPath(message)
  if (!registrar || !filePath) return Promise.resolve({ kind: "none" } as const)
  return registrar.register({
    parentSessionId,
    providerKind: "cursor-agent",
    filePath,
  }).then(
    (result) => result.state === "ready"
      ? { kind: "file" as const, ref: result.handle }
      : { kind: "none" as const },
    () => ({ kind: "none" as const }),
  )
}

function cursorTaskTranscriptPath(message: SDKMessage) {
  if (message.type !== "tool_call" || message.name.toLowerCase() !== "task" || message.status !== "completed") return undefined
  const result = asRecord(message.result)
  if (result?.status !== "success") return undefined
  return text(asRecord(result.value)?.transcriptPath)
}

function cursorMcpServers(input: Record<string, ResolvedMcpServer>): Record<string, CursorMcpServerConfig> {
  return Object.fromEntries(Object.entries(input).map(([name, server]): [string, CursorMcpServerConfig] => {
    if (server.transport === "stdio") {
      return [name, {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
      }]
    }
    return [name, {
      type: "http",
      url: server.url,
      headers: server.headers,
    }]
  }))
}

function cursorSdkModel(model: string | undefined) {
  const value = text(model)
  if (!value || value === "default") return { id: "auto" }
  return { id: value }
}
