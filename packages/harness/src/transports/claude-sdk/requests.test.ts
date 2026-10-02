import { expect, test } from "bun:test"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { StartInput, TurnBroker, TurnRequest } from "../../contract"
import { askClaudePermission } from "./requests"

const input: StartInput = { sessionId: "s1", workspaceId: "w1", directory: "/workspace", locality: "local",
  owner: { kind: "person", userId: "owner" }, config: { harness: { id: "claude", access: "native" }, permissionMode: "default" },
  projection: { generation: "g1", mcpServers: [], pluginRoots: [], notApplied: [] },
  credentials: { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" } }

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
  await askClaudePermission(input, broker, "Bash", { command: "echo hello", description: "Print a greeting" },
    { ...options, title: "Claude wants to run echo", displayName: "Run command", description: "second" })
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

test("Claude questions require text", async () => {
  const signal = new AbortController().signal
  const broker = { signal, ask: async () => ({ kind: "answers" as const, answers: [] }) } as unknown as TurnBroker
  await expect(askClaudePermission(input, broker, "AskUserQuestion", { questions: [{ question: "" }] },
    { signal } as Parameters<CanUseTool>[2])).rejects.toThrow("non-empty question")
})

test("Always allow keys the grant by the request identity and returns the SDK's suggestions as session updates", async () => {
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
  expect(JSON.parse(keys[0]!)).toEqual({ identity: expect.stringMatching(/^[0-9a-f]{64}$/), updates: [{ ...suggestions[0], destination: "session" }] })
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

test("an always-allow answer that moves Claude's mode stores the mode the query now runs under", async () => {
  const kept: unknown[] = []
  const broker = { signal: new AbortController().signal, ask: async () => ({ kind: "permission" as const, decision: "allow_always" as const }) } as unknown as TurnBroker
  const suggestions = [{ type: "setMode", mode: "acceptEdits", destination: "session" }] as Parameters<CanUseTool>[2]["suggestions"]
  const answer = await askClaudePermission({ ...input, permissionModeKept: async (mode) => { kept.push(mode) } }, broker, "Edit",
    { file_path: "/workspace/a.ts" }, { signal: new AbortController().signal, suggestions } as Parameters<CanUseTool>[2])
  expect(answer).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] })
  expect(kept).toEqual([{ modeId: "acceptEdits", label: "Accept edits" }])
})

test("a subagent's permission and question are asked for the child its first-level spawn call routes to, or its agentID before task_started names one", async () => {
  const requests: TurnRequest[] = []
  const broker = { signal: new AbortController().signal, ask: async (request: TurnRequest) => {
    requests.push(request)
    return request.kind === "question" ? { kind: "answers" as const, answers: [["yes"]] } : { kind: "permission" as const, decision: "allow_once" as const }
  } } as TurnBroker
  const options = { signal: new AbortController().signal, toolUseID: "toolu_bash", agentID: "a64191ef39c5ecd63" } as Parameters<CanUseTool>[2]
  const spawnCall = (agentId: string) => agentId === "a64191ef39c5ecd63" ? "toolu_agent" : undefined
  await askClaudePermission(input, broker, "Bash", { command: "ls" }, options, "t1", spawnCall)
  await askClaudePermission(input, broker, "AskUserQuestion", { questions: [{ question: "Proceed?" }] }, options, "t1", spawnCall)
  await askClaudePermission(input, broker, "Bash", { command: "ls" }, { ...options, agentID: undefined }, "t1", () => "toolu_agent")
  await askClaudePermission(input, broker, "Bash", { command: "ls" }, { ...options, agentID: "unknown" }, "t1", spawnCall)
  expect(requests.map((request) => request.child)).toEqual([{ correlationKey: "toolu_agent" }, { correlationKey: "toolu_agent" }, undefined,
    { correlationKey: "unknown" }])
  expect(requests.map((request) => request.kind === "permission" ? request.permission.metadata : {})).not.toContainEqual(expect.objectContaining({ subagent: expect.anything() }))
})

test("a subagent's request stays answerable after the parent turn it was asked in ends, while a parent's own request is cancelled", async () => {
  const turn = new AbortController()
  const broker = { signal: turn.signal, ask: async (request: TurnRequest) => {
    turn.abort()
    return request.kind === "permission" ? { kind: "permission" as const, decision: "allow_once" as const } : { kind: "cancelled" as const }
  } } as TurnBroker
  const options = { signal: new AbortController().signal, toolUseID: "toolu_bash", agentID: "a64191ef39c5ecd63" } as Parameters<CanUseTool>[2]
  expect(await askClaudePermission(input, broker, "Bash", { command: "ls" }, options, "t1", () => "toolu_agent")).toMatchObject({ behavior: "allow" })
  const parentTurn = new AbortController()
  const parent = { ...broker, signal: parentTurn.signal, ask: async () => { parentTurn.abort(); return { kind: "permission" as const, decision: "allow_once" as const } } } as TurnBroker
  expect(await askClaudePermission(input, parent, "Bash", { command: "ls" }, { ...options, agentID: undefined }, "t1")).toMatchObject({ behavior: "deny" })
})
