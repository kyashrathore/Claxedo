import type { InitializeResponse, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { NotApplied, StartInput } from "../../../contract"

const CLAUDE_AGENT_ACP = "@agentclientprotocol/claude-agent-acp"
const PLUGIN_OPTIONS_SINCE = [0, 10, 9]

export const ACP_PLUGINS_NOT_APPLIED = "this ACP agent accepts MCP servers only"

export type AcpLaunchExtras = { meta?: NewSessionRequest["_meta"]; notApplied: NotApplied[] }

function acceptsClaudePlugins(agent: InitializeResponse["agentInfo"]): boolean {
  if (agent?.name !== CLAUDE_AGENT_ACP) return false
  const version = agent.version.split(".").map(Number)
  if (version.length !== 3 || !version.every(Number.isInteger)) return false
  const differing = version.findIndex((part, index) => part !== PLUGIN_OPTIONS_SINCE[index])
  return differing === -1 || version[differing]! > PLUGIN_OPTIONS_SINCE[differing]!
}

export function claudeOptionsMeta(handshake: InitializeResponse, input: Pick<StartInput, "locality" | "projection">): AcpLaunchExtras {
  const roots = input.projection.pluginRoots
  if (input.locality === "remote" || roots.length === 0) return { notApplied: [] }
  if (!acceptsClaudePlugins(handshake.agentInfo)) {
    return { notApplied: roots.map((plugin) => ({ item: plugin.pluginInstanceId, reason: "unsupported-by-harness" })) }
  }
  return { meta: { claudeCode: { options: { plugins: roots.map((plugin) => ({ type: "local", path: plugin.root })) } } }, notApplied: [] }
}
