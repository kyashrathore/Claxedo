import { expect, test } from "bun:test"
import type { ServerRequest } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { TurnBroker, TurnRequest, RequestAnswer } from "../../contract"
import { answerCodexRequest } from "./requests"

const command = { method: "item/commandExecution/requestApproval", id: 0,
  params: { threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1, command: "echo hello", cwd: "/work" } } as ServerRequest

function broker(ask: (request: TurnRequest) => Promise<RequestAnswer>): TurnBroker {
  return { signal: new AbortController().signal, origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
    ask, completeElicitation: async () => {}, observeSubagent: async () => undefined, associateChild: () => {} }
}

test("Codex approval waits for durable broker answer before replying", async () => {
  let release!: (answer: RequestAnswer) => void
  const requests: TurnRequest[] = []
  const requestBroker = broker((request) => { requests.push(request); return new Promise((resolve) => { release = resolve }) })
  let settled = false
  const pending = answerCodexRequest(command, requestBroker, "s1").then((answer) => { settled = true; return answer })
  await Promise.resolve()
  expect(requests[0]?.kind).toBe("permission")
  expect(settled).toBe(false)
  release({ kind: "permission", decision: "allow_always" })
  expect(await pending).toEqual({ decision: "acceptForSession" })
})

test("Codex approval persistence failure yields no allow response", async () => {
  const failure = new Error("durable store failed")
  await expect(answerCodexRequest(command, broker(async () => { throw failure }), "s1")).rejects.toBe(failure)
})

test("Codex cancellation never allows a command", async () => {
  const answer = await answerCodexRequest(command, broker(async () => ({ kind: "cancelled" })), "s1")
  expect(answer).toEqual({ decision: "cancel" })
})

test("Codex approval keys include the command and cwd", async () => {
  const keys: string[] = []
  const ask = broker(async (request) => {
    if (request.kind === "permission" && request.grantKey) keys.push(request.grantKey)
    return { kind: "permission", decision: "deny" }
  })
  await answerCodexRequest(command, ask, "s1")
  await answerCodexRequest({ ...command, params: { ...command.params, cwd: "/other" } } as ServerRequest, ask, "s1")
  await answerCodexRequest({ ...command, id: 9, params: { ...command.params, turnId: "another", itemId: "another", startedAtMs: 99 } } as ServerRequest, ask, "s1")
  expect(keys).toHaveLength(3)
  expect(keys[0]).not.toBe(keys[1])
  expect(keys[0]).toBe(keys[2])
})

test("Codex dynamic tool calls receive the protocol's failed tool result", async () => {
  const answer = await answerCodexRequest({ id: 3, method: "item/tool/call", params: { tool: "spawn_agent" } },
    broker(async () => { throw new Error("No broker request expected") }), "s1")
  expect(answer).toEqual({ contentItems: [{ type: "inputText", text: "Dynamic tool spawn_agent is unavailable." }], success: false })
})
