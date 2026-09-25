import { expect, test } from "bun:test"
import type { AgentCapabilities } from "@claxedo/agent-runtime-contract"
import type { TransportCapabilities } from "../contract/capabilities"
import type { TransportKind } from "../contract/transport"
import { wireAgentCapabilities, wireConnectionCapabilities } from "./wire"

function capabilities(input: { permissions: boolean; questions: boolean; todos: boolean; subagents: boolean; configOwner?: "harness" | "runtime" }): TransportCapabilities {
  return {
    modelSelection: { status: "optional" }, effortLevels: { status: "unsupported", models: [] }, instructionChannel: "prompt-prefix", configOwner: input.configOwner ?? "harness",
    requests: { permissions: input.permissions, questions: input.questions, elicitation: false }, steer: false,
    subagents: input.subagents, goals: { implemented: false, available: false, unavailableReason: "none", actions: [], recovery: "blocked", optionalFields: [] },
    fork: false, agents: false, commands: false, todos: input.todos, history: "store", titles: "none",
    pluginIntake: { mcp: "none", skills: "none" }, mcpTransports: { stdio: false, http: false, sse: false },
    timing: { model: "next-turn", effort: "next-turn", permissionMode: "next-turn", credentials: "next-session" },
  }
}

const oldValues: readonly [string, TransportKind, TransportCapabilities, AgentCapabilities][] = [
  ["claude", "claude-sdk", capabilities({ permissions: true, questions: true, todos: true, subagents: true }),
    { harness: "claude", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: true, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: true }],
  ["codex", "codex-app-server", capabilities({ permissions: true, questions: true, todos: true, subagents: true }),
    { harness: "codex", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: true, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: true }],
  ["cursor", "cursor-sdk", capabilities({ permissions: false, questions: false, todos: true, subagents: true }),
    { harness: "cursor", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: false, questions: false, todos: true, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: true }],
  ["acp-agent", "acp", capabilities({ permissions: true, questions: true, todos: false, subagents: false }),
    { harness: "acp-agent", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false }],
  ["pi", "pi-rpc", capabilities({ permissions: true, questions: true, todos: false, subagents: false }),
    { harness: "pi", modelSelection: { status: "optional" }, abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: false, commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false }],
]

test.each(oldValues)("wire values for %s match the old adapter", (harness, transport, source, expected) => {
  const context = { harness, transport }
  expect(wireAgentCapabilities(source, context)).toEqual(expected)
  const { harness: _harness, modelSelection: _modelSelection, ...connection } = expected
  expect(wireConnectionCapabilities(source, context)).toEqual(connection)
})

test("ACP child can report abort unavailable", () => {
  expect(wireConnectionCapabilities(capabilities({ permissions: true, questions: true, todos: false, subagents: false }), { harness: "child", transport: "acp", abort: false }).abort).toBe(false)
})

test("wire mapping does not retain OpenCode-only reconnect policy", () => {
  const source = capabilities({ permissions: false, questions: false, todos: true, subagents: false, configOwner: "runtime" })
  expect(wireConnectionCapabilities(source, { harness: "pending", transport: "opencode-v2" }).reconnect).toBe(false)
})
