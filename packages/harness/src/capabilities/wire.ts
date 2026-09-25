import type { AgentCapabilities, HarnessConnectionCapabilities } from "@claxedo/agent-runtime-contract"
import type { TransportCapabilities } from "../contract/capabilities"
import type { TransportKind } from "../contract/transport"

export type WireCapabilityContext = {
  harness: string
  transport: TransportKind
  abort?: boolean
}

export function wireAgentCapabilities(capabilities: TransportCapabilities, context: WireCapabilityContext): AgentCapabilities {
  return {
    harness: context.harness,
    modelSelection: capabilities.modelSelection,
    ...wireConnectionCapabilities(capabilities, context),
  }
}

export function wireConnectionCapabilities(capabilities: TransportCapabilities, context: WireCapabilityContext): HarnessConnectionCapabilities {
  return {
    abort: context.abort ?? true,
    reconnect: false,
    replay: true,
    permissions: capabilities.requests.permissions,
    questions: capabilities.requests.questions,
    todos: capabilities.todos,
    commands: capabilities.commands,
    fork: capabilities.fork,
    revert: false,
    unrevert: false,
    configOptions: capabilities.configOwner === "harness",
    subagents: capabilities.subagents,
  }
}
