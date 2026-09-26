import type { AgentCapabilities, HarnessConnectionCapabilities } from "@claxedo/agent-runtime-contract"
import type { TransportCapabilities } from "../contract/capabilities"
import type { HarnessTransport, TransportKind } from "../contract/transport"

export type WireOperations = Pick<HarnessTransport, "config" | "history" | "commands" | "fork">

export type WireCapabilityContext = {
  harness: string
  transport: TransportKind
  abort: boolean
}

const absentOperation = false

export function wireAgentCapabilities(capabilities: TransportCapabilities, operations: WireOperations, context: WireCapabilityContext): AgentCapabilities {
  return {
    harness: context.harness,
    modelSelection: capabilities.modelSelection,
    ...wireConnectionCapabilities(capabilities, operations, context),
  }
}

export function wireConnectionCapabilities(capabilities: TransportCapabilities, operations: WireOperations, context: WireCapabilityContext): HarnessConnectionCapabilities {
  if (typeof context.abort !== "boolean") throw new Error(`Capability projection for ${context.harness} has no abort fact`)
  return {
    abort: context.abort,
    reconnect: absentOperation,
    replay: capabilities.history === "store" || operations.history !== undefined,
    permissions: capabilities.requests.permissions,
    questions: capabilities.requests.questions,
    todos: capabilities.todos,
    commands: operations.commands !== undefined,
    fork: operations.fork !== undefined,
    revert: absentOperation,
    unrevert: absentOperation,
    configOptions: operations.config !== undefined,
    subagents: capabilities.subagents,
  }
}
