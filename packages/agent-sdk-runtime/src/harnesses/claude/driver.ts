import {
  createAgentEventRuntime,
  type AgentEventRuntime,
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
  type SDKMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOptionRow } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { createLiveModelSource } from "../../live-model-source"
import { modelConfigOption, resolveTurnEffort, thoughtLevelConfigOption, type SdkModelEntry } from "../../sdk-model-catalog"
import {
  extractTextFromParts,
  record,
  text,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
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

// The routed nested-turn fixture measures forwarded child frames and bytes
// against the contract thresholds before this option is enabled.
export const CLAUDE_FORWARD_SUBAGENT_TEXT = true

export function claudeSystemPrompt(system?: string) {
  return system
    ? { type: "preset" as const, preset: "claude_code" as const, append: system }
    : undefined
}

export function createClaudeSdkDriver(host: SdkRuntimeDriverHost): SdkRuntimeDriver {
  return new ClaudeSdkDriver(host)
}

class ClaudeSdkDriver implements SdkRuntimeDriver {
  readonly type = "claude" as const
  private auth: SdkRuntimeAuth = {}
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private readonly modelSource = createLiveModelSource({
    harness: "claude",
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

  constructor(private readonly host: SdkRuntimeDriverHost) {}

  permissionModes(sessionId: string) {
    return this.permissionSelection.state(sessionId)
  }

  async setPermissionMode(sessionId: string, modeId: string) {
    return this.permissionSelection.set(sessionId, modeId)
  }

  setAuth(keys: SdkRuntimeAuth) {
    this.auth = {
      ...this.auth,
      ...(keys.anthropic !== undefined ? { anthropic: keys.anthropic || undefined } : {}),
    }
  }

  applyConfig(config: Record<string, unknown>) {
    const auth = record(config.auth) as Record<string, string> | undefined
    this.auth = {
      anthropic: claudeAuthValue(auth),
    }
    this.currentMcp = (record(config.mcp) as Record<string, ResolvedMcpServer> | undefined) ?? {}
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

  deleteAgentSession() {
    // Claude's pending resume id owns no provider or process resource until a
    // turn starts, so a prepared handoff has nothing external to release.
  }

  createRuntime(threadId: string): AgentEventRuntime {
    return createAgentEventRuntime({
      harness: this.type,
      threadId,
      adapter: claudeSdkAdapter(),
    })
  }

  async runTurn(input: SdkRuntimeTurnInput) {
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
      this.modelSource.peek(),
      input.input.model.modelID,
      input.input.variant,
    )
    const systemPrompt = claudeSystemPrompt(input.input.system)
    const q: Query = query({
      prompt: extractTextFromParts(input.input.parts),
      options: {
        cwd: input.directory,
        ...(systemPrompt ? { systemPrompt } : {}),
        // Spawn the user's / sandbox image's installed Claude Code, never a
        // bundled binary. Throws an actionable install error when absent.
        pathToClaudeCodeExecutable: requireClaudeExecutable(),
        includePartialMessages: true,
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
    for await (const message of q) {
      await ingestClaudeSdkMessage(input, message)
    }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    return { status: "ok" }
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOptionRow[]> {
    return this.buildConfigOptions(await this.modelSource.models(directory), currentModel)
  }

  peekConfigOptions(currentModel: string): AgentConfigOptionRow[] {
    return this.buildConfigOptions(this.modelSource.peek(), currentModel)
  }

  /**
   * Model first, then the selected model's effort levels when it has any. The
   * effort row is omitted rather than disabled for models without it — an inert
   * control that appears and disappears with the model reads as a glitch.
   */
  private buildConfigOptions(models: readonly SdkModelEntry[], currentModel: string): AgentConfigOptionRow[] {
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
      prompt: (async function* () {
        await new Promise<never>(() => {})
      })() as AsyncIterable<never>,
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
        // Effort capability is per model and already on the wire here — it was
        // being dropped one line after being fetched, which is why the composer
        // could never offer a thinking level for this harness.
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

function turnModel(input: string | undefined, fallback: string) {
  const value = text(input) ?? text(fallback)
  if (!value || value === "default") return
  return value
}

function sessionPermissionSuggestions(suggestions?: PermissionUpdate[]) {
  if (!suggestions?.length) return undefined
  return suggestions.map((item) => ({ ...item, destination: "session" as const }))
}
