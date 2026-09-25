import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { OwnedProcess } from "../../contract"
import { CodexRpc } from "./rpc"
import { CodexRequestRefusal } from "./errors"

function peer() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exit!: (value: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
  let retireCalls = 0
  const process: OwnedProcess = { pid: 5_000_000, stdin, stdout, stderr: new PassThrough(), exited,
    retire: async () => { retireCalls++; exit({ code: 0, signal: null }); return { stopped: true } } }
  const rpc = new CodexRpc(process, { now: Date.now, setTimeout, clearTimeout })
  const frames: unknown[] = []
  stdin.on("data", (chunk) => { for (const line of String(chunk).trim().split("\n")) frames.push(JSON.parse(line)) })
  return { rpc, stdout, frames, exit, retireCalls: () => retireCalls }
}

test("Codex JSON-RPC request deadline is per call and a later request still answers", async () => {
  const { rpc, stdout, frames } = peer()
  await expect(rpc.request("never", {}, 10)).rejects.toThrow("did not answer")
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
  expect(frames[0]).toMatchObject({ id: 0, error: { code: -32603 } })
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
