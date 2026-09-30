import { describe, expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ChildSessionRef, TurnBroker } from "../../contract"
import { CodexChildren } from "./children"
import type { CodexRpc, RpcMessage } from "./rpc"
import { answerCodexToolCall, codexHostSubagentObservation, type SubagentHost } from "./subagents"

function scriptedRpc(options: { childOutcome?: "completed" | "failed" | "held"; startError?: string } = {}) {
  const listeners = new Set<(message: RpcMessage) => void>()
  const requests: { method: string; params: Record<string, unknown> }[] = []
  const emit = (message: RpcMessage) => { for (const listener of listeners) listener(message) }
  const completion = (status: string) => ({ method: "turn/completed", params: { threadId: "child-1",
    turn: { id: "child-turn", status, ...(status === "failed" ? { error: { message: "child exploded" } } : {}) } } })
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      if (method === "thread/start") return { thread: { id: "child-1" } }
      if (method === "turn/start") {
        if (options.startError) throw new Error(options.startError)
        if (options.childOutcome !== "held") queueMicrotask(() => emit(completion(options.childOutcome ?? "completed")))
        return { turn: { id: "child-turn" } }
      }
      if (method === "turn/interrupt") { queueMicrotask(() => emit(completion("interrupted"))); return {} }
      throw new Error(`Unexpected Codex request ${method}`)
    },
    onMessage: (listener: (message: RpcMessage) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    onFailure: () => () => {},
  } as unknown as CodexRpc
  return { rpc, requests, emit, listenerCount: () => listeners.size }
}

function host(rpc: CodexRpc, drained: () => Promise<void> = async () => {}): SubagentHost {
  return { rpc, directory: "/work", threadId: "parent-1", brokered: false, plugins: ["kit@claxedo-agent-plugins"], permissionMode: "full-access",
    settings: { model: "gpt-5.5", effort: "high", serviceTier: null }, children: new CodexChildren(() => {}), drained }
}

function broker(signal = new AbortController().signal) {
  const observations: SubagentObservation[] = []
  const associations: [string, ChildSessionRef][] = []
  const turnBroker = { signal, origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
    ask: async () => { throw new Error("No broker request expected") }, completeElicitation: async () => {},
    observeSubagent: async (observation: SubagentObservation) => { observations.push(observation); return { sessionId: "child-session", assistantMessageId: "child-a1", created: 1 } },
    associateChild: (key: string, child: ChildSessionRef) => { associations.push([key, child]) } } as TurnBroker
  return { turnBroker, observations, associations }
}

const call = (arguments_: unknown, tool = "spawn_agent") => ({ id: 7, method: "item/tool/call", params: { callId: "call-1", tool, arguments: arguments_ } })

test("spawn_agent starts a subagent thread under the parent's mode and settings and reports its completion", async () => {
  const { rpc, requests } = scriptedRpc()
  const { turnBroker, observations, associations } = broker()
  const subagents = host(rpc)
  expect(await answerCodexToolCall(subagents, turnBroker, call({ task_name: "review", message: "Inspect this" }))).toEqual({
    contentItems: [{ type: "inputText", text: "Subagent child-1 completed successfully." }], success: true })
  expect(subagents.children.get("child-1")).toMatchObject({ origin: "dynamic", state: "released", calls: new Set(["call-1"]) })
  expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"])
  expect(requests[0]?.params).toMatchObject({ cwd: "/work", threadSource: "subagent", approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-5.5",
    config: { plugins: { "kit@claxedo-agent-plugins": { enabled: true } } } })
  expect(requests[1]?.params).toMatchObject({ threadId: "child-1", model: "gpt-5.5", effort: "high", sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: "Inspect this" }] })
  expect(observations.map((row) => [row.status, row.toolCallId, row.providerId, row.label])).toEqual([
    ["running", "call-1", "child-1", "review"], ["completed", "call-1", "child-1", "review"]])
  expect(associations).toEqual([["child-1", { sessionId: "child-session", assistantMessageId: "child-a1", created: 1 }]])
  expect(subagents.children.has("child-1")).toBe(true)
})

test("a child's end is observed only after the parent turn has projected everything the child streamed before it", async () => {
  for (const childOutcome of ["completed", "failed"] as const) {
    const { rpc } = scriptedRpc({ childOutcome })
    const { turnBroker, observations } = broker()
    let drain!: () => void
    const drained = new Promise<void>((resolve) => { drain = resolve })
    const pending = answerCodexToolCall(host(rpc, () => drained), turnBroker, call({ task_name: "review", message: "Inspect this" }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(observations.map((row) => row.status)).toEqual(["running"])
    drain()
    await pending
    expect(observations.map((row) => row.status)).toEqual(["running", childOutcome])
  }
})

test("a failed child turn reports a failed observation and a failed tool result", async () => {
  const { rpc } = scriptedRpc({ childOutcome: "failed" })
  const { turnBroker, observations } = broker()
  expect(await answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "review", message: "Inspect this" }))).toEqual({
    contentItems: [{ type: "inputText", text: "Subagent failed: child exploded" }], success: false })
  expect(observations.map((row) => [row.status, row.label])).toEqual([["running", "review"], ["failed", "child exploded"]])
})

test("unknown tools, calls without a message, and calls with no active turn are refused without a child thread", async () => {
  const { rpc, requests } = scriptedRpc()
  const { turnBroker, observations } = broker()
  expect(await answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "x", message: "y" }, "other_tool"))).toEqual({
    contentItems: [{ type: "inputText", text: "Dynamic tool other_tool is unavailable." }], success: false })
  expect(await answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "x" }))).toEqual({
    contentItems: [{ type: "inputText", text: "spawn_agent requires a message." }], success: false })
  expect(await answerCodexToolCall(undefined, undefined, call({ task_name: "x", message: "y" }))).toMatchObject({ success: false })
  expect(requests).toEqual([])
  expect(observations).toEqual([])
})

test("an aborted parent turn interrupts the running child turn, which reports interrupted, not success", async () => {
  const { rpc, requests } = scriptedRpc({ childOutcome: "held" })
  const controller = new AbortController()
  const { turnBroker, observations } = broker(controller.signal)
  const pending = answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "review", message: "Inspect this" }))
  while (!requests.some((request) => request.method === "turn/start")) await new Promise((resolve) => setTimeout(resolve, 1))
  controller.abort()
  expect(await pending).toEqual({ contentItems: [{ type: "inputText", text: "Subagent child-1 was interrupted before it finished." }], success: false })
  expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start", "turn/interrupt"])
  expect(requests[2]?.params).toEqual({ threadId: "child-1", turnId: "child-turn" })
  expect(observations.at(-1)?.status).toBe("interrupted")
})

test("a failed child turn start removes the child listener", async () => {
  const { rpc, listenerCount } = scriptedRpc({ startError: "turn start refused" })
  const { turnBroker, observations } = broker()
  expect(await answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "review", message: "Inspect this" })))
    .toEqual({ contentItems: [{ type: "inputText", text: "Subagent failed: turn start refused" }], success: false })
  expect(listenerCount()).toBe(0)
  expect(observations.map((row) => row.status)).toEqual(["running", "failed"])
})

test("a spawn_agent request without a callId is refused and starts no child, since its edge needs the call a part carries", async () => {
  const { rpc, requests } = scriptedRpc()
  const { turnBroker, observations } = broker()
  const request = call({ task_name: "review", message: "Inspect this" })
  expect(await answerCodexToolCall(host(rpc), turnBroker, { ...request, params: { tool: "spawn_agent", arguments: request.params.arguments } })).toEqual({
    contentItems: [{ type: "inputText", text: "spawn_agent requires a callId." }], success: false })
  expect(requests).toEqual([])
  expect(observations).toEqual([])
})

describe("a create_subagent item binds the host-minted child", () => {
  const binding = { kind: "claxedo.subagent", subagentKey: "subagent_host", sessionId: "child-9", status: "running" }
  const item = (id: string, overrides: Record<string, unknown> = {}) => ({ id, type: "mcpToolCall", server: "claxedo", tool: "create_subagent",
    status: "completed", arguments: { harness: "claude", prompt: "Consult" }, result: { content: [{ type: "text", text: JSON.stringify(binding) }] }, ...overrides })
  const completed = (threadId: string, value: Record<string, unknown>) => ({ threadId, turnId: "turn-1", item: value })
  const bound = { harnessExecutionId: "thread-1", subagentKey: "subagent_host", status: "running", providerId: "child-9", providerKind: "claxedo",
    childSessionId: "child-9", transcript: { kind: "live" } } as const

  test("as its spawn when the turn's own thread made the call", () => {
    expect(codexHostSubagentObservation("thread-1", completed("thread-1", item("mcp-spawn-1"))))
      .toEqual({ observationId: "codex:host-subagent:thread-1:mcp-spawn-1", toolCallId: "mcp-spawn-1", toolCallRole: "spawn", ...bound })
  })

  test("without a spawn edge when a child thread made the call, since the call is in the child's transcript", () => {
    expect(codexHostSubagentObservation("thread-1", completed("child-thread-2", item("mcp-spawn-2"))))
      .toEqual({ observationId: "codex:host-subagent:thread-1:mcp-spawn-2", toolCallId: "mcp-spawn-2", ...bound })
  })

  test("and no other item binds anything", () => {
    const observe = (value: Record<string, unknown>) => codexHostSubagentObservation("thread-1", completed("thread-1", value))
    expect(observe(item("a", { tool: "session_list" }))).toBeUndefined()
    expect(observe(item("a", { server: "other" }))).toBeUndefined()
    expect(observe(item("a", { result: null }))).toBeUndefined()
    expect(observe({ id: "a", type: "commandExecution", command: "ls" })).toBeUndefined()
  })
})
