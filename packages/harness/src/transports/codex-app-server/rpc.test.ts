import { expect, test } from "bun:test"
import type { ExitStatus } from "../../contract"
import { ScriptedProcess } from "../../test-support/scripted-process"
import { CodexRpc, type RpcMessage } from "./rpc"
import { CodexRequestRefusal } from "./errors"
import { startCodexTurn } from "./recovery"

function peer(answer?: (frame: RpcMessage, wire: ScriptedProcess<RpcMessage>) => void) {
  const wire = new ScriptedProcess<RpcMessage>((frame, process) => answer?.(frame, process))
  const rpc = new CodexRpc(wire.owned(), { now: Date.now, setTimeout, clearTimeout })
  return { rpc, wire, stdout: wire.stdout, frames: wire.received, exit: (status: ExitStatus) => wire.exit(status), retireCalls: () => wire.retirements }
}

test("Codex JSON-RPC request deadline is per call and a later request still answers", async () => {
  const { rpc, stdout, frames } = peer()
  await expect(rpc.request("never", {}, 10)).rejects.toMatchObject({ code: "protocol", message: "Codex never did not answer within 10ms" })
  const next = rpc.request("after", {}, 1000)
  const frame = frames[1] as { id: number }
  stdout.write(`${JSON.stringify({ id: frame.id, result: { ok: true } })}\n`)
  expect(await next).toEqual({ ok: true })
})

test("Codex failed request handler replies with JSON-RPC error and stays usable", async () => {
  const { rpc, stdout, frames } = peer()
  rpc.onRequest(async (message) => {
    if (message.method === "fail") throw new Error("storage failed")
    return { ok: true }
  })
  stdout.write(`${JSON.stringify({ id: 0, method: "fail", params: {} })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(frames[0]).toEqual({ id: 0, error: { code: -32603, message: "storage failed" } })
  stdout.write(`${JSON.stringify({ id: 1, method: "next", params: {} })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(frames[1]).toEqual({ id: 1, result: { ok: true } })
})

test("Codex typed request refusal stays distinct from an internal error", async () => {
  const { rpc, stdout, frames } = peer()
  rpc.onRequest(async () => { throw new CodexRequestRefusal(-32000, "Authentication unavailable") })
  stdout.write(`${JSON.stringify({ id: 0, method: "account/chatgptAuthTokens/refresh", params: {} })}\n`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(frames[0]).toMatchObject({ id: 0, error: { code: -32000 } })
})

test("a malformed Codex frame fails active requests and retires the owned process", async () => {
  const { rpc, stdout, retireCalls } = peer()
  const failure = new Promise<Error>((resolve) => rpc.onFailure(resolve))
  const pending = rpc.request("thread/start", {}, 1_000)
  stdout.write("{broken\n")
  await expect(pending).rejects.toThrow("Invalid Codex JSON-RPC frame")
  expect((await failure).message).toContain("Invalid Codex JSON-RPC frame")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(retireCalls()).toBe(1)
})

test("an exited app-server refuses a new request immediately without sending a frame", async () => {
  const { rpc, exit, frames } = peer()
  exit({ code: 1, signal: null })
  await Promise.resolve()
  await expect(rpc.request("thread/start", {}, 60_000)).rejects.toMatchObject({ code: "process" })
  expect(frames).toEqual([])
})

test("Codex retirement surfaces an owned process that did not stop and sends nothing after it", async () => {
  const { rpc, wire, frames, retireCalls } = peer()
  wire.retirement = { stopped: false, error: { code: "still-running", message: "Descendant alive" } }
  await expect(rpc.retire({ at: Date.now() + 1_000, signal: new AbortController().signal })).rejects.toMatchObject({ code: "process", message: "Descendant alive" })
  expect(retireCalls()).toBe(1)
  await expect(rpc.request("thread/start", {}, 60_000)).rejects.toMatchObject({ code: "process" })
  expect(frames).toEqual([])
})

function recoveringPeer(errors: string[], resumeError?: string) {
  const calls: (string | undefined)[] = []
  const { rpc } = peer((frame, wire) => {
    calls.push(frame.method)
    const error = frame.method === "turn/start" ? errors.shift() : resumeError
    wire.send({ id: frame.id, ...(error ? { error: { code: -32000, message: error } } : { result: { turn: { id: "recovered" } } }) })
  })
  return { calls, start: () => startCodexTurn(rpc, { threadId: "thread-1", input: [] }, { threadId: "thread-1" }) }
}

test.each(["thread not found: thread-1", "Thread not found: thread-1"])("recovers the native missing-thread error %s", async (message) => {
  const value = recoveringPeer([message])
  expect(await value.start()).toEqual({ turn: { id: "recovered" } })
  expect(value.calls).toEqual(["turn/start", "thread/resume", "turn/start"])
})

test("a clean turn starts once and never resumes", async () => {
  const value = recoveringPeer([])
  expect(await value.start()).toEqual({ turn: { id: "recovered" } })
  expect(value.calls).toEqual(["turn/start"])
})

test.each(["401 Unauthorized", "turn interrupted"])("an unrelated native error never resumes or retries: %s", async (message) => {
  const value = recoveringPeer([message])
  await expect(value.start()).rejects.toMatchObject({ code: "protocol", message })
  expect(value.calls).toEqual(["turn/start"])
})

test("a failed resume surfaces its error without another turn start", async () => {
  const value = recoveringPeer(["thread not found: thread-1"], "thread is not resumable")
  await expect(value.start()).rejects.toMatchObject({ code: "protocol", message: "thread is not resumable" })
  expect(value.calls).toEqual(["turn/start", "thread/resume"])
})

test("the second resume cycle recovers in exact start-resume order", async () => {
  const value = recoveringPeer(["thread not found: thread-1", "thread not found: thread-1"])
  expect(await value.start()).toEqual({ turn: { id: "recovered" } })
  expect(value.calls).toEqual(["turn/start", "thread/resume", "turn/start", "thread/resume", "turn/start"])
})

test("exhaustion classifies the session error after exactly three starts and two resumes", async () => {
  const value = recoveringPeer(Array.from({ length: 3 }, () => "thread not found: thread-1"))
  await expect(value.start()).rejects.toMatchObject({ transport: "codex", code: "session",
    message: "Codex session is gone: thread not found: thread-1", cause: { code: "protocol" } })
  expect(value.calls).toEqual(["turn/start", "thread/resume", "turn/start", "thread/resume", "turn/start"])
})
