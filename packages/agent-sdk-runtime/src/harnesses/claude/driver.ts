import {
  createAgentEventRuntime,
  type AgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"
import { randomUUID } from "crypto"
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfigOptionRow } from "../../index"
import type { AgentHarnessAdapterHealth } from "../../adapter-contract"
import type { ResolvedMcpServer } from "../../mcp-resolver"
import { requireSdkModelId, sdkModelConfigOption } from "../../sdk-model-catalog"
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
import { harnessSpawnEnv } from "../shared/spawn-env"

const CLAUDE_PENDING_PREFIX = "claude-sdk:"

export function createClaudeSdkDriver(host: SdkRuntimeDriverHost): SdkRuntimeDriver {
  return new ClaudeSdkDriver(host)
}

class ClaudeSdkDriver implements SdkRuntimeDriver {
  readonly type = "claude" as const
  private auth: SdkRuntimeAuth = {}
  private currentMcp: Record<string, ResolvedMcpServer> = {}

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

  configOptions(_currentModel: string): AgentConfigOptionRow[] {
    return [sdkModelConfigOption("claude", _currentModel)]
  }
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
  return requireSdkModelId("claude", value)
}

function sessionPermissionSuggestions(suggestions?: PermissionUpdate[]) {
  if (!suggestions?.length) return undefined
  return suggestions.map((item) => ({ ...item, destination: "session" as const }))
}
