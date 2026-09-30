import { query, type EffortLevel, type McpServerConfig, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { HarnessServices, HarnessSession, SessionBroker, StartInput, TurnBroker } from "../../contract"
import { goalSessionStore } from "./goal-state"
import { claudeLaunchContext, type ClaudeSdkOptions } from "./launch-context"
import { permissionOptions } from "./permissions"
import { ClaudeProcess } from "./process"
import { askClaudeElicitation, askClaudePermission } from "./requests"
import type { ClaudeMirroredUsage } from "./mirrored-usage"
import { connectionGrantKeys, sessionMcpServers } from "../../contract"

const undeliveredWakeups = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"]

export type ClaudeLaunchTurn = { broker: TurnBroker; turnId: string }

type Launch = {
  session: HarnessSession
  input: StartInput
  broker: SessionBroker
  turn: () => ClaudeLaunchTurn | undefined
  prompt: AsyncIterable<SDKUserMessage>
  abort: AbortController
  processes: Set<ClaudeProcess>
  usage: Pick<ClaudeMirroredUsage, "observe">
  subagentCall?: (agentId: string) => string | undefined
  model?: string
  effort?: EffortLevel
  system?: string
  agent?: string
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
    const { input, session, broker, abort, processes } = spec
    const current = { ...input, config: broker.config() }
    const context = await claudeLaunchContext(input, this.options, input.sessionId)
    return this.runQuery({ prompt: spec.prompt, options: {
      ...context,
      ...permissionOptions(current.config, connectionGrantKeys(current.config.permissionState, session.binding.connectionId)),
      ...(session.binding.upstreamSessionId.startsWith("claude-sdk:") ? {} : { resume: session.binding.upstreamSessionId }),
      mcpServers: mcpServers(input, this.services), forwardSubagentText: true, abortController: abort, disallowedTools: undeliveredWakeups, perTaskStopAffordance: true,
      sessionStore: goalSessionStore(broker, abort.signal, spec.usage), sessionStoreFlush: "eager",
      ...(spec.model && (spec.model !== "default" || !spec.agent) ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.system ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: spec.system } } : {}),
      ...(spec.agent ? { agent: spec.agent } : {}),
      extraArgs: { "thinking-display": "summarized", "replay-user-messages": null }, includePartialMessages: true,
      canUseTool: (name, payload, options) => {
        const turn = spec.turn()
        return askClaudePermission(current, turn?.broker ?? { ask: (request, asked) => broker.ask(request, asked), signal: abort.signal }, name, payload, options, turn?.turnId, spec.subagentCall)
      },
      onElicitation: (request, options) => askClaudeElicitation(spec.turn()?.broker ?? broker, request, options.signal),
      spawnClaudeCodeProcess: (options) => {
        const child = new ClaudeProcess(this.services, options, input.sessionId)
        processes.add(child)
        return child
      },
    } })
  }
}
