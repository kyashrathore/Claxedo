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
import { randomUUID } from "crypto"
import { createLiveModelSource } from "../../live-model-source"
import { modelConfigOption, type SdkModelEntry } from "../../sdk-model-catalog"
import {
  CURSOR_PERMISSION_MODES,
  PermissionModeSelection,
  cursorPermissionOptions,
} from "../shared/permission-modes"
import {
  extractTextFromParts,
  record,
  text,
  type SdkRuntimeAuth,
  type SdkRuntimeDriver,
  type SdkRuntimeDriverHost,
  type SdkRuntimeTurnInput,
} from "../shared/sdk-runtime-adapter"
import {
  observeAgentProcess,
  type AgentProcessObserverHandle,
} from "../../process-observer"

const CURSOR_PENDING_PREFIX = "cursor-sdk:"
type CursorEntry = {
  directory: string
  agent: CursorSDKAgent
  observation: AgentProcessObserverHandle
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
    const { Agent } = await import("@cursor/sdk")
    const model = cursorSdkModel(input.model)
    const observation = this.observeAgent(input.directory)
    try {
      const agent = await Agent.create({
        ...(model ? { model } : {}),
        ...(input.title ? { name: input.title } : {}),
        ...(Object.keys(this.currentMcp).length ? { mcpServers: cursorMcpServers(this.currentMcp) } : {}),
        ...(this.auth.cursor ? { apiKey: this.auth.cursor } : {}),
        local: {
          cwd: input.directory,
          // `sandboxOptions` and `autoReview` are LocalAgentOptions, read here by
          // Agent.create and nowhere else — LocalSendOptions carries only `force`
          // and `customTools`. Passing them to `send` instead compiles and does
          // nothing, which is why the mode's appliesFrom is "next-session".
          ...cursorPermissionOptions(this.permissionSelection.currentId(input.directory)),
        },
      })
      observation.update({ lifecycle: "ready" })
      this.agents.set(agent.agentId, { directory: input.directory, agent, observation })
      this.processError = null
      return agent.agentId
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
    } finally {
      observation.exit({ reason: "disposed" })
    }
  }

  private async ensureAgent(sessionId: string, agentSessionId: string, directory: string) {
    const existing = this.agents.get(agentSessionId)
    if (existing?.directory === directory) return existing.agent
    existing?.observation.exit({ reason: "disposed" })
    existing?.agent.close()
    const { Agent } = await import("@cursor/sdk")
    const observation = this.observeAgent(directory, sessionId)
    let agent: CursorSDKAgent
    try {
      agent = agentSessionId.startsWith(CURSOR_PENDING_PREFIX)
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
