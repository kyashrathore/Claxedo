import type { InitializeResponse, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { StartInput } from "../../../contract"
import { AcpTransportError } from "../errors"

const CLAUDE_AGENT_ACP = "@agentclientprotocol/claude-agent-acp"
const PLUGIN_OPTIONS_SINCE = [0, 10, 9]

function acceptsClaudePlugins(agent: InitializeResponse["agentInfo"]): boolean {
  if (agent?.name !== CLAUDE_AGENT_ACP) return false
  const version = agent.version.split(".").map(Number)
  if (version.length !== 3 || !version.every(Number.isInteger)) return false
  const differing = version.findIndex((part, index) => part !== PLUGIN_OPTIONS_SINCE[index])
  return differing === -1 || version[differing]! > PLUGIN_OPTIONS_SINCE[differing]!
}

export function claudeOptionsMeta(handshake: InitializeResponse, input: Pick<StartInput, "locality" | "projection">): NewSessionRequest["_meta"] | undefined {
  if (input.locality === "remote" || input.projection.pluginRoots.length === 0) return undefined
  if (!acceptsClaudePlugins(handshake.agentInfo)) {
    throw new AcpTransportError("configuration", "ACP agent does not accept Claude plugins")
  }
  return { claudeCode: { options: { plugins: input.projection.pluginRoots.map((plugin) => ({ type: "local", path: plugin.root })) } } }
}
