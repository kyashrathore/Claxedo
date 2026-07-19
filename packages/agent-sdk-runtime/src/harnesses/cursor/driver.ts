import {
  createAgentEventRuntime,
  type AgentEventRuntime,
} from "@claxedo/agent-event-runtime"
import { cursorSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/cursor"
import type {
  McpServerConfig as CursorMcpServerConfig,
  SDKAgent as CursorSDKAgent,
} from "@cursor/sdk"
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

const CURSOR_PENDING_PREFIX = "cursor-sdk:"
type CursorEntry = {
  directory: string
  agent: CursorSDKAgent
}

export function createCursorSdkDriver(host: SdkRuntimeDriverHost): SdkRuntimeDriver {
  return new CursorSdkDriver(host)
}

class CursorSdkDriver implements SdkRuntimeDriver {
  readonly type = "cursor" as const
  private auth: SdkRuntimeAuth = {}
  private currentMcp: Record<string, ResolvedMcpServer> = {}
  private agents = new Map<string, CursorEntry>()
  private processError: string | null = null
  private readonly modelSource = createLiveModelSource({
    harness: "cursor",
    fetchModels: () => this.fetchModels(),
  })

  constructor(private readonly host: SdkRuntimeDriverHost) {}

  setAuth(keys: SdkRuntimeAuth) {
    this.auth = {
      ...this.auth,
      ...(keys.cursor !== undefined ? { cursor: keys.cursor || undefined } : {}),
    }
  }

  applyConfig(config: Record<string, unknown>) {
    const auth = record(config.auth) as Record<string, string> | undefined
    this.auth = {
      cursor: auth?.["cursor-sdk"],
    }
    this.currentMcp = (record(config.mcp) as Record<string, ResolvedMcpServer> | undefined) ?? {}
  }

  async createAgentSession(input: { directory: string; title?: string; model: string }) {
    const { Agent } = await import("@cursor/sdk")
    const model = cursorSdkModel(input.model)
    const agent = await Agent.create({
      ...(model ? { model } : {}),
      ...(input.title ? { name: input.title } : {}),
      ...(Object.keys(this.currentMcp).length ? { mcpServers: cursorMcpServers(this.currentMcp) } : {}),
      ...(this.auth.cursor ? { apiKey: this.auth.cursor } : {}),
      local: {
        cwd: input.directory,
      },
    })
    this.agents.set(agent.agentId, { directory: input.directory, agent })
    this.processError = null
    return agent.agentId
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
    const run = await agent.send(extractTextFromParts(input.input.parts), {
      ...(model ? { model } : {}),
      ...(Object.keys(this.currentMcp).length ? { mcpServers: cursorMcpServers(this.currentMcp) } : {}),
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
        const sdkSessionId = text(record(message)?.agent_id)
        if (sdkSessionId) input.rebindAgentSession(sdkSessionId)
        input.ingest({
          source: "cursor.sdk.message",
          method: `cursor/${message.type}`,
          payload: message,
        }, {
          dir: "in",
          method: `cursor.${message.type}`,
          frame: message,
        })
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

  deleteAgentSession(_sessionId: string, agentSessionId: string) {
    this.agents.get(agentSessionId)?.agent.close()
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
    for (const item of this.agents.values()) item.agent.close()
    this.agents.clear()
  }

  async configOptions(currentModel: string, _directory?: string): Promise<AgentConfigOptionRow[]> {
    return [modelConfigOption(await this.modelSource.models(), currentModel)]
  }

  peekConfigOptions(currentModel: string): AgentConfigOptionRow[] {
    return [modelConfigOption(this.modelSource.peek(), currentModel)]
  }

  /**
   * `Cursor.models.list` is a cloud catalog call (needs the cursor-sdk API key,
   * or CURSOR_API_KEY). "auto" is a selection mode rather than a catalog entry,
   * so it's pinned ahead of the listed models to keep the default selectable.
   */
  private async fetchModels(): Promise<SdkModelEntry[]> {
    const { Cursor } = await import("@cursor/sdk")
    const listed = await Cursor.models.list(this.auth.cursor ? { apiKey: this.auth.cursor } : undefined)
    const models: SdkModelEntry[] = listed.map((model) => ({
      id: model.id,
      name: model.displayName,
      ...(model.description ? { description: model.description } : {}),
    }))
    if (models.length > 0 && !models.some((model) => model.id === "auto")) {
      models.unshift({ id: "auto", name: "Auto", isDefault: true })
    }
    return models
  }

  private async ensureAgent(sessionId: string, agentSessionId: string, directory: string) {
    const existing = this.agents.get(agentSessionId)
    if (existing?.directory === directory) return existing.agent
    existing?.agent.close()
    const { Agent } = await import("@cursor/sdk")
    const agent = agentSessionId.startsWith(CURSOR_PENDING_PREFIX)
      ? await Agent.create({
          ...(this.auth.cursor ? { apiKey: this.auth.cursor } : {}),
          local: {
            cwd: directory,
          },
        })
      : await Agent.resume(agentSessionId, {
          ...(this.auth.cursor ? { apiKey: this.auth.cursor } : {}),
          local: {
            cwd: directory,
          },
        })
    this.agents.set(agent.agentId, { directory, agent })
    if (agent.agentId !== agentSessionId) {
      this.host.bindSession({ sessionId, directory, agentSessionId: agent.agentId })
    }
    this.processError = null
    return agent
  }
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
