import {
  createAgentEventRuntime,
  type AgentEventRuntime,
  type RuntimeGoalSnapshot,
} from "@claxedo/agent-event-runtime"
import {
  claudeChildCorrelationKey,
  claudeSdkAdapter,
  claudeSubagentObservations,
} from "@claxedo/agent-event-runtime/harnesses/claude"
import { randomUUID } from "crypto"
import { spawn } from "child_process"
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKActiveGoalMessage,
  type SDKMessage,
  type SessionStore,
  type SessionStoreEntry,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOption } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import { goalCapabilities } from "../../capabilities"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { createLiveModelSource } from "../../live-model-source"
import { modelConfigOption, resolveTurnEffort, thoughtLevelConfigOption, type SdkModelEntry } from "../../sdk-model-catalog"
import {
  errorMessage,
  extractTextFromParts,
  record,
  text,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import { createNativeGoalStore, nativeGoalCommand } from "../shared/native-goal-store"
import { claudeAuthEnv, claudeAuthValue } from "./auth"
import { requireClaudeExecutable } from "./executable"
import { harnessSpawnEnv } from "../shared/spawn-env"
import {
  CLAUDE_DENY_FLOOR,
  CLAUDE_PERMISSION_MODES,
  PermissionModeSelection,
} from "../shared/permission-modes"
import {
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"

const CLAUDE_PENDING_PREFIX = "claude-sdk:"
const MODEL_LIST_TIMEOUT_MS = 30_000

function idlePrompt(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<never>>(() => {}),
      }
    },
  }
}

// Child text is forwarded because the routed nested-turn contract admits it.
export const CLAUDE_FORWARD_SUBAGENT_TEXT = true

export function claudeSystemPrompt(system?: string) {
  return system
    ? { type: "preset" as const, preset: "claude_code" as const, append: system }
    : undefined
}

export function claudeGoalSnapshot(
  sessionId: string,
  message: SDKActiveGoalMessage,
): RuntimeGoalSnapshot | null {
  if (!message.value) return null
  const setAt = message.value.set_at < 1_000_000_000_000
    ? message.value.set_at * 1_000
    : message.value.set_at
  return {
    sessionId,
    objective: message.value.condition,
    status: "active",
    createdAt: setAt,
    updatedAt: Date.now(),
    iteration: message.value.iterations,
    ...(message.value.last_reason ? { lastReason: message.value.last_reason } : {}),
  }
}

/**
 * The single reader of Claude's Goal progress, and the only place coupled to
 * its format.
 *
 * FORMAT COUPLING: the SDK has no typed Goal-progress message. The CLI reports
 * every iteration by writing an UNTYPED `goal_status` attachment entry to the
 * session store — `{ type, met, condition, reason?, iterations? }` — so this
 * helper sniffs it out of `SessionStoreEntry.attachment`. Every field is read
 * defensively: it runs inside the SDK's `sessionStore.append`, where a throw
 * would fail the very turn that carries the Goal, so an entry shape that no
 * longer matches must degrade to "no Goal update" (`undefined`) instead.
 *
 * Returns the new snapshot, `null` when the Goal is met (clear it), or
 * `undefined` when the entry says nothing about a Goal.
 */
export function claudeTranscriptGoalSnapshot(
  sessionId: string,
  entry: SessionStoreEntry,
  previous?: RuntimeGoalSnapshot,
): RuntimeGoalSnapshot | null | undefined {
  const row = record(entry)
  if (!row || row.type !== "attachment") return undefined
  const attachment = record(row.attachment)
  if (text(attachment?.type) !== "goal_status") return undefined
  if (attachment?.met === true) return null
  if (attachment?.met !== false) return undefined
  const objective = text(attachment.condition)
  if (!objective) return undefined
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN
  const updatedAt = Number.isFinite(timestamp) ? timestamp : Date.now()
  return {
    sessionId,
    objective,
    status: "active",
    createdAt: previous?.objective === objective ? previous.createdAt : updatedAt,
    updatedAt,
    ...(typeof attachment.iterations === "number" ? { iteration: attachment.iterations } : {}),
    ...(text(attachment.reason) ? { lastReason: text(attachment.reason) } : {}),
  }
}

export type ClaudeSdkDriverOptions = {
  query?: typeof query
  executable?: () => string
}

export function createClaudeSdkDriver(
  host: SdkRuntimeDriverHost,
  options: ClaudeSdkDriverOptions = {},
): SdkRuntimeDriver {
  return new ClaudeSdkDriver(host, options)
}

class ClaudeSdkDriver implements SdkRuntimeDriver {
  readonly type = "claude" as const
  private readonly goalStore = createNativeGoalStore()
  readonly nativeGoal: NonNullable<SdkRuntimeDriver["nativeGoal"]> = {
    // Delete is NOT advertised: the Goal lives in the Claude CLI session and no
    // provider clear operation exists, so a resumed session would re-emit a
    // Goal that Claxedo claimed was deleted.
    capabilities: () => goalCapabilities({
      implemented: true,
      available: true,
      actions: [],
      recovery: "blocked",
      optionalFields: ["iteration", "lastReason"],
    }),
    read: (sessionId) => this.goalStore.read(sessionId),
    run: (input, objective, onGoal) => this.runQuery(input, nativeGoalCommand(objective), onGoal),
    stop: (sessionId) => this.goalStore.stop(sessionId),
  }
  private auth: SdkRuntimeAuth = {}
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private readonly modelSource = createLiveModelSource({
    fetchModels: (directory) => this.fetchModels(directory),
  })

  /**
   * `next-turn`: `permissionMode` is read when `query()` is called, and a turn
   * is one query, so a change is live from the next message. The SDK also has
   * `setPermissionMode()` for mid-turn changes, deliberately unused — it applies
   * to a streaming-input query this driver does not hold open between turns, so
   * calling it would mean keeping a handle alive purely to mutate it.
   */
  private readonly permissionSelection = new PermissionModeSelection(CLAUDE_PERMISSION_MODES, "next-turn")

  constructor(
    private readonly host: SdkRuntimeDriverHost,
    private readonly driverOptions: ClaudeSdkDriverOptions,
  ) {}

  permissionModes(sessionId: string) {
    return this.permissionSelection.state(sessionId)
  }

  async setPermissionMode(sessionId: string, modeId: string) {
    return this.permissionSelection.set(sessionId, modeId)
  }

  setAuth(keys: SdkRuntimeAuth) {
    const previous = this.auth.anthropic
    this.auth = {
      ...this.auth,
      ...(keys.anthropic !== undefined ? { anthropic: keys.anthropic || undefined } : {}),
    }
    if (this.auth.anthropic !== previous) this.modelSource.invalidate()
  }

  applyConfig(config: Record<string, unknown>) {
    const previous = this.auth.anthropic
    const auth = record(config.auth) as Record<string, string> | undefined
    this.auth = {
      anthropic: claudeAuthValue(auth),
    }
    this.currentMcp = (record(config.mcp) as Record<string, ResolvedMcpServer> | undefined) ?? {}
    if (this.auth.anthropic !== previous) this.modelSource.invalidate()
    // Held, not applied here: the SDK takes `effort` as a per-query option, so
    // it is read when the next session is created rather than pushed at the
    // running one. `undefined` means "let the model decide", which is not the
    // same as any named level and must survive a config apply that omits it.
    if ("effort" in config) {
      this.currentEffort = typeof config.effort === "string" ? config.effort : undefined
    }
  }

  /** Selected reasoning effort, echoed back through `configOptions`. */
  private currentEffort: string | undefined

  async createAgentSession() {
    return `${CLAUDE_PENDING_PREFIX}${randomUUID()}`
  }

  deleteAgentSession(sessionId: string) {
    this.goalStore.forget(sessionId)
  }

  createRuntime(threadId: string): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: claudeSdkAdapter(),
    })
  }

  async runTurn(input: SdkRuntimeTurnInput) {
    await this.runQuery(input, extractTextFromParts(input.input.parts))
  }

  private async runQuery(
    input: SdkRuntimeTurnInput,
    prompt: string,
    onGoal?: (goal: RuntimeGoalSnapshot | null) => void,
  ) {
    const applyGoal = (goal: RuntimeGoalSnapshot | null) => {
      this.goalStore.apply(input.sessionId, goal)
      onGoal?.(goal)
      this.host.publishGoal({ sessionId: input.sessionId, directory: input.directory, goal })
    }
    let goalSessionStore: SessionStore | undefined
    if (onGoal) {
      /**
       * A WRITE-ONLY observer, not a storage adapter: this store exists solely
       * because `append` is the only channel on which the CLI reports Goal
       * progress. It deliberately keeps nothing.
       *
       * Storing (or importing) a transcript here would be worse than useless.
       * The subprocess keeps writing its own complete local JSONL — this is a
       * secondary copy — and the SDK redirects resume at the store only when
       * `load()` answers with entries, which it materializes into a temporary
       * CLAUDE_CONFIG_DIR and resumes the CLI from INSTEAD of that local
       * transcript. Answering with nothing keeps the CLI on its own history;
       * answering with a mirror would cost an O(transcript) import per Goal
       * turn and, since ordinary turns run without a `sessionStore` and never
       * reach here, would eventually resume from a copy missing them.
       */
      goalSessionStore = {
        append: async (_key, entries) => {
          for (const entry of entries) {
            const goal = claudeTranscriptGoalSnapshot(
              input.sessionId,
              entry,
              this.goalStore.peek(input.sessionId),
            )
            if (goal !== undefined) applyGoal(goal)
          }
        },
        load: async () => null,
        listSessions: async () => [],
        listSubkeys: async () => [],
      }
    }
    const requestPermission: CanUseTool = async (toolName, toolInput, options) => {
      const requestId = randomUUID()
      input.ingest({
        source: "claude.sdk",
        method: "claude/can-use-tool",
        payload: {
          requestId,
          toolName,
          input: toolInput,
          suggestions: options.suggestions,
        },
      }, {
        dir: "in",
        method: "claude.canUseTool",
        frame: { toolName, toolInput },
      })
      const decision = await new Promise<"allow_once" | "allow_always" | "deny" | "reject_always">((resolve) => {
        this.host.pendingPermissions.set(requestId, {
          sessionId: input.sessionId,
          agentSessionId: input.getAgentSessionId(),
          method: "claude/can-use-tool",
          params: { toolName, input: toolInput, suggestions: options.suggestions },
          resolve,
        })
      })
      const result: PermissionResult = decision === "allow_once" || decision === "allow_always"
        ? {
            behavior: "allow",
            ...(decision === "allow_always" ? { updatedPermissions: sessionPermissionSuggestions(options.suggestions) } : {}),
          }
        : {
            behavior: "deny",
            message: "User denied the tool request",
            interrupt: decision === "reject_always",
          }
      return result
    }

    const turnEffort = resolveTurnEffort(
      this.modelSource.peek(input.directory),
      input.input.model.modelID,
      input.input.variant,
    )
    const systemPrompt = claudeSystemPrompt(input.input.system)
    const q: Query = (this.driverOptions.query ?? query)({
      prompt,
      options: {
        cwd: input.directory,
        ...(systemPrompt ? { systemPrompt } : {}),
        // Spawn the user's / sandbox image's installed Claude Code, never a
        // bundled binary. Throws an actionable install error when absent.
        pathToClaudeCodeExecutable: (this.driverOptions.executable ?? requireClaudeExecutable)(),
        includePartialMessages: true,
        ...(goalSessionStore ? { sessionStore: goalSessionStore, sessionStoreFlush: "eager" as const } : {}),
        forwardSubagentText: CLAUDE_FORWARD_SUBAGENT_TEXT,
        abortController: input.abort,
        // Both are passed together on purpose. `permissionMode` decides how much
        // runs unprompted; `canUseTool` only fires when the flow falls THROUGH to
        // a prompt, so under `bypassPermissions` it never runs at all. Policy that
        // must hold in every mode therefore cannot live in the callback — it lives
        // in the deny floor below.
        permissionMode: this.permissionSelection.currentId(input.sessionId) as PermissionMode | undefined,
        ...(this.permissionSelection.currentId(input.sessionId) === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true as const }
          : {}),
        settings: { permissions: { deny: [...CLAUDE_DENY_FLOOR] } },
        canUseTool: requestPermission,
        ...(input.input.agent ? { agent: input.input.agent } : {}),
        ...(turnModel(input.input.model.modelID, input.model) ? { model: turnModel(input.input.model.modelID, input.model) } : {}),
        // Reasoning effort rides the TURN, not a config push. A Claude turn is
        // exactly one `query()`, and the SDK takes `effort` as a per-query
        // option alongside `model` and `agent` above — so this is the same
        // shape opencode already uses, where the chosen level travels on the
        // prompt rather than being pushed at the process. `variant` is the
        // field that already carries it end to end (`PromptInput.variant`).
        ...(turnEffort ? { effort: turnEffort } : {}),
        ...(input.getAgentSessionId().startsWith(CLAUDE_PENDING_PREFIX)
          ? {}
          : { resume: input.getAgentSessionId() }),
        ...(Object.keys(this.currentMcp).length ? { mcpServers: claudeMcpServers(this.currentMcp) } : {}),
        env: claudeSpawnEnv({
          ...process.env,
          ...claudeAuthEnv(this.auth.anthropic),
          CLAUDE_AGENT_SDK_CLIENT_APP: "claxedo-workspace-runtime/0.1.0",
        }),
        spawnClaudeCodeProcess: (options) => spawnObservedClaudeCodeProcess({
          options,
          observer: this.host.processObserver,
          role: "harness",
          sessionId: input.sessionId,
          mcp: this.currentMcp,
        }),
      },
    })
    this.host.lifecycle().set(input.sessionId, {
      abort: input.abort,
      close: () => q.close(),
    })
    try {
      for await (const message of q as AsyncIterable<SDKMessage | SDKActiveGoalMessage>) {
        if (message.type === "active_goal") {
          applyGoal(claudeGoalSnapshot(input.sessionId, message))
          continue
        }
        await ingestClaudeSdkMessage(input, message)
      }
    } catch (cause) {
      // This query carried the Goal: if it died, no iteration is left to report
      // progress, so the Goal must not stay `active` — that state is what makes
      // the composer offer a Stop for work that is already gone.
      if (!onGoal) throw cause
      const settled = this.goalStore.settleUnfinished(
        input.sessionId,
        input.abort.signal.aborted
          ? { status: "paused" }
          : { status: "blocked", reason: errorMessage(cause) },
      )
      if (settled) applyGoal(settled)
      throw cause
    }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    return { status: "ok" }
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]> {
    return this.buildConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[] {
    return this.buildConfigOptions(this.modelSource.peek(directory), currentModel)
  }

  /**
   * Model first, then the selected model's effort levels when it has any. The
   * effort row is omitted rather than disabled for models without it — an inert
   * control that appears and disappears with the model reads as a glitch.
   */
  private buildConfigOptions(models: readonly SdkModelEntry[], currentModel: string): AgentConfigOption[] {
    if (models.length === 0) return []
    const effort = thoughtLevelConfigOption(models, currentModel, this.currentEffort)
    return effort
      ? [modelConfigOption(models, currentModel), effort]
      : [modelConfigOption(models, currentModel)]
  }

  /**
   * The SDK only answers `supportedModels()` over an initialized session, so
   * list models through a short-lived probe query that never sends a prompt.
   * The never-yielding prompt stream keeps the CLI idle until `close()`.
   */
  private async fetchModels(directory?: string): Promise<SdkModelEntry[]> {
    const abort = new AbortController()
    const q: Query = query({
        prompt: idlePrompt(),
      options: {
        cwd: directory ?? process.cwd(),
        pathToClaudeCodeExecutable: requireClaudeExecutable(),
        abortController: abort,
        env: claudeSpawnEnv({
          ...process.env,
          ...claudeAuthEnv(this.auth.anthropic),
          CLAUDE_AGENT_SDK_CLIENT_APP: "claxedo-workspace-runtime/0.1.0",
        }),
        spawnClaudeCodeProcess: (options) => spawnObservedClaudeCodeProcess({
          options,
          observer: this.host.processObserver,
          role: "probe",
          mcp: this.currentMcp,
        }),
      },
    })
    try {
      const models = await Promise.race([
        q.supportedModels(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`claude supportedModels timed out after ${MODEL_LIST_TIMEOUT_MS}ms`)), MODEL_LIST_TIMEOUT_MS).unref?.()
        }),
      ])
      return models.map((model) => ({
        id: model.value,
        name: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        // Model-specific effort metadata drives the harness config options.
        ...(model.supportsEffort ? { supportsEffort: true } : {}),
        ...(model.supportedEffortLevels?.length
          ? { supportedEffortLevels: [...model.supportedEffortLevels] }
          : {}),
      }))
    } finally {
      q.close()
      abort.abort()
    }
  }
}

export async function ingestClaudeSdkMessage(
  input: Pick<SdkRuntimeTurnInput, "ingest" | "observeSubagent" | "rebindAgentSession">,
  message: SDKMessage,
) {
  const sdkSessionId = text(record(message)?.session_id)
  if (sdkSessionId) input.rebindAgentSession(sdkSessionId)
  await Promise.all(claudeSubagentObservations(message).map((observation) => input.observeSubagent({
    observation,
    correlationKeys: [observation.stableCorrelationId, observation.toolCallId]
      .filter((key): key is string => !!key),
    source: {
      dir: "in",
      method: `claude.${message.type}`,
      frame: message,
    },
  })))
  input.ingest({
    source: "claude.sdk",
    method: `claude/${message.type}`,
    payload: message,
  }, {
    dir: "in",
    method: `claude.${message.type}`,
    frame: message,
  }, claudeChildCorrelationKey(message)
    ? { kind: "child", correlationKey: claudeChildCorrelationKey(message) }
    : { kind: "parent" })
}

export function spawnObservedClaudeCodeProcess(input: {
  options: SpawnOptions
  observer?: AgentProcessObserver
  role: "harness" | "probe"
  sessionId?: string
  mcp?: Record<string, ResolvedMcpServer>
  spawnProcess?: typeof spawn
}): SpawnedProcess {
  const proc = (input.spawnProcess ?? spawn)(
    input.options.command,
    input.options.args,
    {
      ...(input.options.cwd ? { cwd: input.options.cwd } : {}),
      env: input.options.env,
      signal: input.options.signal,
      stdio: ["pipe", "pipe", "inherit"],
    },
  )
  const ownerId = `claude-${input.role}:${randomUUID()}`
  const handles = [
    observeAgentProcess(input.observer, {
      ownerId,
      launchId: randomUUID(),
      harnessId: "claude",
      access: "native",
      role: input.role,
      label: input.role === "probe" ? "Claude model probe" : "Claude Code",
      locality: "local-process",
      confidence: proc.pid ? "direct" : "inferred",
      capabilities: {
        resourceMetrics: "process",
        ownerActions: false,
      },
      ...(proc.pid ? { pid: proc.pid } : {}),
      ...(input.options.cwd ? { directory: input.options.cwd } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      executableBasename: input.options.command.split(/[\\/]/).at(-1) || "claude",
    }),
    ...Object.values(input.mcp ?? {}).map((server) => observeAgentProcess(input.observer, {
      ownerId: `claude-mcp:${randomUUID()}`,
      launchId: randomUUID(),
      harnessId: "claude",
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
      ...(input.options.cwd ? { directory: input.options.cwd } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      mcpName: server.name,
      transport: server.transport === "stdio" ? "stdio" as const : "streamable-http" as const,
      ...(server.transport === "stdio"
        ? { executableBasename: server.command.split(/[\\/]/).at(-1) || "mcp" }
        : {}),
    })),
  ]
  let exited = false
  const exit = (event: Parameters<AgentProcessObserverHandle["exit"]>[0]) => {
    if (exited) return
    exited = true
    handles.forEach((handle) => handle.exit(event))
  }
  proc.once("exit", (code) => exit({
    reason: "exited",
    ...(code !== null ? { exitCode: code } : {}),
  }))
  proc.once("error", () => exit({ reason: "error" }))
  handles.forEach((handle) => handle.update({ lifecycle: "ready" }))
  return proc
}

export function claudeSpawnEnv(input: Record<string, string | undefined>) {
  return harnessSpawnEnv(input)
}

function claudeMcpServers(input: Record<string, ResolvedMcpServer>): Record<string, McpServerConfig> {
  return Object.fromEntries(Object.entries(input).map(([name, server]): [string, McpServerConfig] => {
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

function turnModel(input: string | undefined, configuredModel: string) {
  const value = text(input) ?? text(configuredModel)
  if (!value || value === "default") return
  return value
}

function sessionPermissionSuggestions(suggestions?: PermissionUpdate[]) {
  if (!suggestions?.length) return undefined
  return suggestions.map((item) => ({ ...item, destination: "session" as const }))
}
