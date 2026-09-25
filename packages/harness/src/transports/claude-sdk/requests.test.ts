import { expect, test } from "bun:test"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { StartInput, TurnBroker, TurnRequest } from "../../contract"
import { askClaudePermission } from "./requests"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/workspace", locality: "local",
  owner: { kind: "person", userId: "owner" }, config: { harness: { id: "claude", access: "native" }, permissionMode: "default" },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" } }

test("Claude grant keys preserve the full request context and pass the SDK abort signal", async () => {
  const requests: TurnRequest[] = []
  const signals: (AbortSignal | undefined)[] = []
  const controller = new AbortController()
  const broker = { signal: new AbortController().signal, ask: async (request: TurnRequest, options?: { signal?: AbortSignal }) => {
    requests.push(request)
    signals.push(options?.signal)
    return { kind: "permission" as const, decision: "allow_always" as const }
  } } as TurnBroker
  const options = { signal: controller.signal, description: "first", blockedPath: "/blocked", agentID: "agent-a" } as Parameters<CanUseTool>[2]
  expect((await askClaudePermission(input, broker, "Bash", { command: "echo hello" }, options)).behavior).toBe("allow")
  await askClaudePermission(input, broker, "Bash", { command: "echo hello" }, { ...options, description: "second" })
  await askClaudePermission(input, broker, "Bash", { command: "echo hello" }, { ...options, blockedPath: "/other" })
  await askClaudePermission(input, broker, "Bash", { command: "echo hello" }, { ...options, agentID: "agent-b" })
  await askClaudePermission({ ...input, directory: "/other" }, broker, "Bash", { command: "echo hello" }, options)
  await askClaudePermission({ ...input, config: { ...input.config, permissionMode: "plan" } }, broker, "Bash", { command: "echo hello" }, options)
  await askClaudePermission(input, broker, "Read", { command: "echo hello" }, options)
  await askClaudePermission(input, broker, "Bash", { command: "echo changed" }, options)
  const keys = requests.map((request) => request.kind === "permission" ? request.grantKey : undefined)
  expect(new Set(keys).size).toBe(requests.length)
  expect(signals).toEqual(Array(requests.length).fill(controller.signal))
})
