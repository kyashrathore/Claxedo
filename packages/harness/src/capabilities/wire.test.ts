import { expect, test } from "bun:test"
import type { AgentCapabilities } from "@claxedo/agent-runtime-contract"
import type { TransportCapabilities } from "../contract/capabilities"
import type { TransportKind } from "../contract/transport"
import { wireAgentCapabilities, wireConnectionCapabilities, type WireOperation, type WireOperations } from "./wire"

function capabilities(input: { permissions: boolean; questions: boolean; elicitation?: boolean; todos: boolean; subagents: boolean;
  configOwner?: "harness" | "runtime"; history?: "store" | "harness" }): TransportCapabilities {
  return {
    modelSelection: { status: "optional" }, effortLevels: { status: "unsupported", models: [] }, instructionChannel: "prompt-prefix", configOwner: input.configOwner ?? "harness",
    requests: { permissions: input.permissions, questions: input.questions, elicitation: input.elicitation ?? false },
    subagents: input.subagents, goals: { implemented: false, available: false, unavailableReason: "none", actions: [], recovery: "blocked", optionalFields: [] },
    todos: input.todos, history: input.history ?? "store", titles: "none",
    pluginIntake: { mcp: "none", skills: "none" }, mcpTransports: { stdio: false, http: false, sse: false },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "next-session" },
  }
}

function operations(groups: readonly WireOperation[]): WireOperations {
  return Object.fromEntries(groups.map((group) => [group, {}])) as unknown as WireOperations
}

const declared: readonly [string, TransportKind, TransportCapabilities, readonly WireOperation[], AgentCapabilities][] = [
  ["claude", "claude-sdk", capabilities({ permissions: true, questions: true, todos: true, subagents: true, configOwner: "runtime" }), ["config", "commands"],
    { harness: "claude", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: true, commands: true, fork: false, revert: false, unrevert: false, configOptions: true, subagents: true }],
  ["codex", "codex-app-server", capabilities({ permissions: true, questions: true, todos: true, subagents: false, configOwner: "runtime" }), ["config"],
    { harness: "codex", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: true, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false }],
  ["cursor", "cursor-sdk", capabilities({ permissions: false, questions: false, todos: true, subagents: true, configOwner: "runtime" }), ["config"],
    { harness: "cursor", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: false, questions: false, todos: true, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: true }],
  ["acp-agent", "acp", capabilities({ permissions: true, questions: false, todos: false, subagents: false }), ["config", "commands", "fork"],
    { harness: "acp-agent", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: false, todos: false, commands: true, fork: true, revert: false, unrevert: false, configOptions: true, subagents: false }],
  ["pi", "pi-rpc", capabilities({ permissions: false, questions: true, todos: false, subagents: false, configOwner: "runtime" }), ["commands"],
    { harness: "pi", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: false, questions: true, todos: false, commands: true, fork: false, revert: false, unrevert: false, configOptions: false, subagents: false }],
  ["opencode", "opencode-sdk", capabilities({ permissions: true, questions: true, todos: false, subagents: false, configOwner: "runtime" }), ["config", "commands", "fork"],
    { harness: "opencode", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: false, commands: true, fork: true, revert: false, unrevert: false, configOptions: true, subagents: false }],
]

test.each(declared)("wire values for %s come from its capabilities and operation groups", (harness, transport, source, groups, expected) => {
  const context = { harness, transport, abort: true }
  expect(wireAgentCapabilities(source, operations(groups), context)).toEqual(expected)
  const { harness: _harness, modelSelection: _modelSelection, ...connection } = expected
  expect(wireConnectionCapabilities(source, groups, context)).toEqual(connection)
})

test("abort is the host's per-session fact: an ACP child reports it unavailable", () => {
  const source = capabilities({ permissions: true, questions: true, todos: false, subagents: false })
  expect(wireConnectionCapabilities(source, ["config"], { harness: "child", transport: "acp", abort: false }).abort).toBe(false)
})

test("abort requires the host's session-specific fact", () => {
  const source = capabilities({ permissions: true, questions: true, todos: false, subagents: false })
  expect(() => wireConnectionCapabilities(source, ["config"], { harness: "child", transport: "acp" } as never)).toThrow("abort")
})

test("runtime-owned config still advertises its options operation", () => {
  const source = capabilities({ permissions: false, questions: false, todos: true, subagents: false, configOwner: "runtime" })
  expect(wireConnectionCapabilities(source, ["config"], { harness: "claude", transport: "claude-sdk", abort: true }).configOptions).toBe(true)
  expect(wireConnectionCapabilities(source, [], { harness: "claude", transport: "claude-sdk", abort: true }).configOptions).toBe(false)
})

test("harness-owned history replays only when the transport serves it", () => {
  const stored = capabilities({ permissions: false, questions: false, todos: true, subagents: false, history: "store" })
  const owned = capabilities({ permissions: false, questions: false, todos: true, subagents: false, history: "harness" })
  const context = { harness: "opencode", transport: "opencode-sdk" as const, abort: true }
  expect(wireConnectionCapabilities(stored, [], context).replay).toBe(true)
  expect(wireConnectionCapabilities(owned, [], context).replay).toBe(false)
  expect(wireConnectionCapabilities(owned, ["history"], context).replay).toBe(true)
})

test("reconnect, revert and unrevert are false for every transport because the contract has no such operation", () => {
  for (const [harness, transport, source, groups] of declared) {
    const wire = wireConnectionCapabilities(source, groups, { harness, transport, abort: true })
    expect([wire.reconnect, wire.revert, wire.unrevert]).toEqual([false, false, false])
  }
})

test("an elicitation-only transport answers questions: elicitations reach clients as questions", () => {
  const source = capabilities({ permissions: true, questions: false, elicitation: true, todos: false, subagents: false })
  expect(wireConnectionCapabilities(source, [], { harness: "acp-agent", transport: "acp", abort: true }).questions).toBe(true)
  expect(wireConnectionCapabilities({ ...source, requests: { ...source.requests, elicitation: false } }, [], { harness: "acp-agent", transport: "acp", abort: true }).questions).toBe(false)
})
