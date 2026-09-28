import { expect, test } from "bun:test"
import type { SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ChildSessionRef, TurnBroker } from "../../contract"
import type { CodexEvents } from "./events"
import type { CodexRpc, RpcMessage } from "./rpc"
import { answerCodexToolCall, type SubagentHost } from "./subagents"

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

function host(rpc: CodexRpc): SubagentHost & { children: Map<string, CodexEvents> } {
  return { rpc, directory: "/work", threadId: "parent-1", brokered: false, permissionMode: "full-access",
    settings: { model: "gpt-5.5", effort: "high", serviceTier: null }, children: new Map() }
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
  expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"])
  expect(requests[0]?.params).toMatchObject({ cwd: "/work", threadSource: "subagent", approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-5.5" })
  expect(requests[1]?.params).toMatchObject({ threadId: "child-1", model: "gpt-5.5", effort: "high", sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: "Inspect this" }] })
  expect(observations.map((row) => [row.status, row.toolCallId, row.providerId, row.label])).toEqual([
    ["running", "call-1", "child-1", "review"], ["completed", "call-1", "child-1", "review"]])
  expect(associations).toEqual([["child-1", { sessionId: "child-session", assistantMessageId: "child-a1", created: 1 }]])
  expect(subagents.children.has("child-1")).toBe(true)
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

test("an aborted parent turn interrupts the running child turn", async () => {
  const { rpc, requests } = scriptedRpc({ childOutcome: "held" })
  const controller = new AbortController()
  const { turnBroker, observations } = broker(controller.signal)
  const pending = answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "review", message: "Inspect this" }))
  while (!requests.some((request) => request.method === "turn/start")) await new Promise((resolve) => setTimeout(resolve, 1))
  controller.abort()
  expect(await pending).toMatchObject({ success: true })
  expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start", "turn/interrupt"])
  expect(requests[2]?.params).toEqual({ threadId: "child-1", turnId: "child-turn" })
  expect(observations.at(-1)?.status).toBe("completed")
})

test("a failed child turn start removes the child listener", async () => {
  const { rpc, listenerCount } = scriptedRpc({ startError: "turn start refused" })
  const { turnBroker, observations } = broker()
  expect(await answerCodexToolCall(host(rpc), turnBroker, call({ task_name: "review", message: "Inspect this" })))
    .toEqual({ contentItems: [{ type: "inputText", text: "Subagent failed: turn start refused" }], success: false })
  expect(listenerCount()).toBe(0)
  expect(observations.map((row) => row.status)).toEqual(["running", "failed"])
})
