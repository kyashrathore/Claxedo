import {
  createAgentEventRuntime,
  type AgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { randomUUID } from "crypto"
import { spawn } from "child_process"
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOptionRow } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { createLiveModelSource } from "../../live-model-source"
import { modelConfigOption, type SdkModelEntry } from "../../sdk-model-catalog"
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
  observeAgentProcess,
  type AgentProcessObserver,
  type AgentProcessObserverHandle,
} from "../../process-observer"

const CLAUDE_PENDING_PREFIX = "claude-sdk:"
const MODEL_LIST_TIMEOUT_MS = 30_000

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

  constructor(private readonly host: SdkRuntimeDriverHost) {}

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
  }

  async createAgentSession() {
    return `${CLAUDE_PENDING_PREFIX}${randomUUID()}`
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

    const q: Query = query({
      prompt: extractTextFromParts(input.input.parts),
      options: {
        cwd: input.directory,
        // Spawn the user's / sandbox image's installed Claude Code, never a
        // bundled binary. Throws an actionable install error when absent.
        pathToClaudeCodeExecutable: requireClaudeExecutable(),
        includePartialMessages: true,
        abortController: input.abort,
        canUseTool: requestPermission,
        ...(input.input.agent ? { agent: input.input.agent } : {}),
        ...(turnModel(input.input.model.modelID, input.model) ? { model: turnModel(input.input.model.modelID, input.model) } : {}),
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
      const sdkSessionId = text(record(message)?.session_id)
      if (sdkSessionId) input.rebindAgentSession(sdkSessionId)
      input.ingest({
        source: "claude.sdk",
        method: `claude/${message.type}`,
        payload: message,
      }, {
        dir: "in",
        method: `claude.${message.type}`,
        frame: message,
      })
    }
  }

  readRuntimeHealth(): AgentHarnessAdapterHealth {
    return { status: "ok" }
  }

  async configOptions(currentModel: string, directory?: string): Promise<AgentConfigOptionRow[]> {
    return [modelConfigOption(await this.modelSource.models(directory), currentModel)]
  }

  peekConfigOptions(currentModel: string): AgentConfigOptionRow[] {
    return [modelConfigOption(this.modelSource.peek(), currentModel)]
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
      }))
    } finally {
      q.close()
      abort.abort()
    }
  }
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
