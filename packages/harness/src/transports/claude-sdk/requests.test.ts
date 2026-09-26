import { expect, test } from "bun:test"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { StartInput, TurnBroker, TurnRequest } from "../../contract"
import { askClaudePermission } from "./requests"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/workspace", locality: "local",
  owner: { kind: "person", userId: "owner" }, config: { harness: { id: "claude", access: "native" }, permissionMode: "default" },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { providers: {}, secrets: {}, leaseGeneration: "g1" } }

test("Claude grants use identity fields, ignore display labels, and pass the SDK abort signal", async () => {
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
  expect(keys[0]).toBe(keys[1])
  expect(keys.slice(2, 6).every((key) => key !== keys[0])).toBe(true)
  expect(keys[6]).toBeUndefined()
  expect(keys[7]).not.toBe(keys[0])
  expect(signals).toEqual(Array(requests.length).fill(controller.signal))
})

test("a native ask rule has no reusable grant while a plain approval reason keeps one", async () => {
  const requests: TurnRequest[] = []
  const broker = { signal: new AbortController().signal, ask: async (request: TurnRequest) => {
    requests.push(request)
    return { kind: "permission" as const, decision: "allow_always" as const }
  } } as TurnBroker
  const signal = new AbortController().signal
  await askClaudePermission(input, broker, "Bash", { command: "echo safe" },
    { signal, blockedPath: "/work", matchedAskRule: { toolName: "Bash" } } as Parameters<CanUseTool>[2])
  await askClaudePermission(input, broker, "Bash", { command: "echo safe" },
    { signal, blockedPath: "/work", decisionReason: "This command requires approval" } as Parameters<CanUseTool>[2])
  const keys = requests.map((request) => request.kind === "permission" ? request.grantKey : undefined)
  expect(keys[0]).toBeUndefined()
  expect(keys[1]).toBeDefined()
})

test("Claude questions require text and one answer per question", async () => {
  const signal = new AbortController().signal
  const broker = { signal, ask: async () => ({ kind: "answers" as const, answers: [] }) } as unknown as TurnBroker
  await expect(askClaudePermission(input, broker, "AskUserQuestion", { questions: [{ question: "" }] },
    { signal } as Parameters<CanUseTool>[2])).rejects.toThrow("non-empty question")
  await expect(askClaudePermission(input, broker, "AskUserQuestion", { questions: [{ question: "What?" }] },
    { signal } as Parameters<CanUseTool>[2])).rejects.toThrow("answer each question")
})

test("Always allow keys the grant by the SDK's suggestions and returns them as session updates", async () => {
  const requests: TurnRequest[] = []
  const broker = { signal: new AbortController().signal, ask: async (request: TurnRequest) => {
    requests.push(request)
    return { kind: "permission" as const, decision: "allow_always" as const }
  } } as TurnBroker
  const suggestions = [{ type: "addRules" as const, behavior: "allow" as const, destination: "localSettings" as const,
    rules: [{ toolName: "Bash", ruleContent: "npm test" }] }]
  const options = { signal: new AbortController().signal, suggestions } as Parameters<CanUseTool>[2]
  const reply = await askClaudePermission(input, broker, "Bash", { command: "npm test" }, options)
  expect(reply).toMatchObject({ behavior: "allow", updatedPermissions: [{ ...suggestions[0], destination: "session" }] })
  const again = await askClaudePermission(input, broker, "Bash", { command: "npm test", description: "again" }, options)
  expect(again).toMatchObject({ behavior: "allow" })
  const keys = requests.map((request) => request.kind === "permission" ? request.grantKey : undefined)
  expect(keys[0]).toBeDefined()
  expect(keys[0]).toBe(keys[1])
  expect(JSON.parse(keys[0]!)).toEqual({ tool: "Bash", directory: "/workspace", updates: [{ ...suggestions[0], destination: "session" }] })
  const once = { signal: new AbortController().signal, suggestions } as Parameters<CanUseTool>[2]
  const onceBroker = { signal: once.signal, ask: async () => ({ kind: "permission" as const, decision: "allow_once" as const }) } as unknown as TurnBroker
  expect(await askClaudePermission(input, onceBroker, "Bash", { command: "npm test" }, once)).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } })
})

test("an ask-rule prompt with suggestions persists nothing", async () => {
  const requests: TurnRequest[] = []
  const broker = { signal: new AbortController().signal, ask: async (request: TurnRequest) => {
    requests.push(request)
    return { kind: "permission" as const, decision: "allow_always" as const }
  } } as TurnBroker
  const reply = await askClaudePermission(input, broker, "Bash", { command: "npm test" }, { signal: new AbortController().signal,
    matchedAskRule: { source: "user", toolName: "Bash" },
    suggestions: [{ type: "addRules", behavior: "allow", destination: "session", rules: [{ toolName: "Bash" }] }] } as Parameters<CanUseTool>[2])
  expect(reply).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } })
  expect(requests[0]?.kind === "permission" && requests[0].grantKey).toBeUndefined()
})
