import { expect, test } from "bun:test"
import type { ServerRequest } from "./translate"
import type { TurnBroker, TurnRequest, RequestAnswer } from "../../contract"
import { answerCodexRequest } from "./requests"
import { CodexRequestRefusal } from "./errors"
import { codexAppServerAdapter } from "./translate/adapter"
import { translatorRuntime } from "../../test-support/translator-runtime"

const command = { method: "item/commandExecution/requestApproval", id: 0,
  params: { threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1, command: "echo hello", cwd: "/work" } } as ServerRequest

function broker(ask: (request: TurnRequest) => Promise<RequestAnswer>): TurnBroker {
  return { signal: new AbortController().signal, origin: { actor: { kind: "machine-owner" }, via: "loopback", reissued: false },
    ask, completeElicitation: async () => {}, observeSubagent: async () => undefined, associateChild: () => {} }
}

test("an unregistered dynamic tool request is refused and never projects an approval", async () => {
  const request = { method: "item/tool/call", id: 7, params: { threadId: "thread", tool: "unregistered" } }
  const failure = await answerCodexRequest(request, broker(async () => { throw new Error("unsupported request reached broker") }), "s1")
    .then(() => undefined, (error: unknown) => error)
  expect(failure).toBeInstanceOf(CodexRequestRefusal)
  expect((failure as CodexRequestRefusal).rpcCode).toBe(-32601)
  const runtime = translatorRuntime({ harness: "codex-app-server", threadId: "thread", adapter: codexAppServerAdapter(), clock: () => 0, createId: () => "id" })
  const events = runtime.ingest({ source: "codex.app-server", method: request.method, payload: request.params }).events
  expect(events.some((event) => event.type === "permission-request")).toBe(false)
  expect(events).toMatchObject([{ type: "diagnostic", diagnostic: { code: "codex_app_server.unmapped_event" } }])
})

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

test("Codex tells an MCP server a rejected elicitation was declined and a withdrawn one was cancelled", async () => {
  const elicitation = { method: "mcpServer/elicitation/request", id: 1,
    params: { threadId: "thread", turnId: "turn", serverName: "server", mode: "form", message: "Name", requestedSchema: { type: "object", properties: {} } } } as unknown as ServerRequest
  expect(await answerCodexRequest(elicitation, broker(async () => ({ kind: "rejected" })), "s1")).toMatchObject({ action: "decline" })
  expect(await answerCodexRequest(elicitation, broker(async () => ({ kind: "cancelled" })), "s1")).toMatchObject({ action: "cancel" })
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
