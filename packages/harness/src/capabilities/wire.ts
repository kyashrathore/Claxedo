import type { AgentCapabilities, HarnessConnectionCapabilities } from "@claxedo/agent-runtime-contract"
import type { TransportCapabilities } from "../contract/capabilities"
import type { HarnessTransport, TransportKind } from "../contract/transport"

export type WireOperations = Pick<HarnessTransport, "config" | "history" | "commands" | "fork">

export type WireOperation = keyof WireOperations

export type WireCapabilityFacts = Pick<TransportCapabilities, "history" | "requests" | "todos" | "subagents">

export type WireCapabilityContext = {
  harness: string
  transport: TransportKind
  abort: boolean
}

const absentOperation = false

const wireOperations = ["config", "history", "commands", "fork"] as const satisfies readonly WireOperation[]

export function offeredOperations(operations: WireOperations): readonly WireOperation[] {
  return wireOperations.filter((operation) => operations[operation] !== undefined)
}

export function wireAgentCapabilities(capabilities: TransportCapabilities, operations: WireOperations, context: WireCapabilityContext): AgentCapabilities {
  return {
    harness: context.harness,
    modelSelection: capabilities.modelSelection,
    ...wireConnectionCapabilities(capabilities, offeredOperations(operations), context),
  }
}

export function wireConnectionCapabilities(facts: WireCapabilityFacts, offered: readonly WireOperation[], context: WireCapabilityContext): HarnessConnectionCapabilities {
  if (typeof context.abort !== "boolean") throw new Error(`Capability projection for ${context.harness} has no abort fact`)
  return {
    abort: context.abort,
    reconnect: absentOperation,
    replay: facts.history === "store" || offered.includes("history"),
    permissions: facts.requests.permissions,
    questions: facts.requests.questions || facts.requests.elicitation,
    todos: facts.todos,
    commands: offered.includes("commands"),
    fork: offered.includes("fork"),
    revert: absentOperation,
    unrevert: absentOperation,
    configOptions: offered.includes("config"),
    subagents: facts.subagents,
  }
}
