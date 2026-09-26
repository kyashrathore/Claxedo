import { query, type EffortLevel, type McpServerConfig, type Query } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, HarnessSession, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { goalSessionStore } from "./goal-state"
import { claudeLaunchContext, type ClaudeSdkOptions } from "./launch-context"
import { permissionOptions } from "./permissions"
import { ClaudeProcess } from "./process"
import { askClaudePermission } from "./requests"
import type { claudeTranslator } from "./events"
import { connectionGrantKeys, sessionMcpServers } from "../../contract"

const protocolClaudePermissionMap = { deny: "deny" } as const

type Launch = {
  session: HarnessSession
  input: StartInput
  broker: SessionBroker
  turnBroker?: TurnBroker
  prompt: Parameters<typeof query>[0]["prompt"]
  abort: AbortController
  processes: Set<ClaudeProcess>
  runtime: ReturnType<typeof claudeTranslator>["runtime"]
  assistantMessageId: string
  turnId?: string
  clear?: boolean
  model?: string
  effort?: EffortLevel
  system?: string
  agent?: string
  partialMessages?: boolean
}

function mcpServers(input: StartInput, services: HarnessServices): Record<string, McpServerConfig> {
  const projected = sessionMcpServers(input, services, { includeFirstParty: input.locality === "local",
    duplicate: (name) => new Error(`Duplicate Claude MCP server ${name}`) })
  return Object.fromEntries(projected.map((server): [string, McpServerConfig] => server.kind === "stdio"
    ? [server.name, { type: "stdio", command: server.command, args: [...server.args ?? []], env: server.env ? { ...server.env } : undefined }]
    : [server.name, { type: server.kind, url: server.url, headers: server.headers ? { ...server.headers } : undefined }]))
}

export class ClaudeQueryLauncher {
  constructor(private readonly services: HarnessServices, private readonly options: ClaudeSdkOptions,
    private readonly runQuery: typeof query = query) {}

  async launch(spec: Launch): Promise<Query> {
    const { input, session, broker, turnBroker, abort, processes } = spec
    const current = { ...input, config: broker.config() }
    const context = await claudeLaunchContext(input, this.options, input.sessionId)
    return this.runQuery({ prompt: spec.prompt, options: {
      ...context,
      ...permissionOptions(current.config, connectionGrantKeys(current.config.permissionState, session.binding.connectionId)),
      ...(session.binding.upstreamSessionId.startsWith("claude-sdk:") ? {} : { resume: session.binding.upstreamSessionId }),
      mcpServers: mcpServers(input, this.services), forwardSubagentText: true, abortController: abort,
      ...(spec.clear ? { tools: [], maxTurns: 1 } : { sessionStore: goalSessionStore(broker, abort.signal, {
        runtime: spec.runtime, assistantMessageId: spec.assistantMessageId, directory: input.directory }), sessionStoreFlush: "eager" as const }),
      ...(spec.model && (spec.model !== "default" || !spec.agent) ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.system ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: spec.system } } : {}),
      ...(spec.agent ? { agent: spec.agent } : {}),
      ...(spec.partialMessages ? { includePartialMessages: true, extraArgs: { "replay-user-messages": null } } : {}),
      canUseTool: (name, payload, options) => spec.clear || !turnBroker
        ? Promise.resolve({ behavior: protocolClaudePermissionMap.deny, message: "Clearing the native Goal cannot run tools" })
        : askClaudePermission(current, turnBroker, name, payload, options, spec.turnId),
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, input.sessionId)
        processes.add(child)
        return child
      },
    } })
  }
}
