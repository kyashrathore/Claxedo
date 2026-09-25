import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { OwnedProcess } from "../../contract"
import { CodexRpc } from "./rpc"

function peer() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let exit!: (value: { code: number | null; signal: string | null }) => void
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { exit = resolve })
  const process: OwnedProcess = { pid: 5_000_000, stdin, stdout, stderr: new PassThrough(), exited,
    retire: async () => { exit({ code: 0, signal: null }); return { stopped: true } } }
  const rpc = new CodexRpc(process, { now: Date.now, setTimeout, clearTimeout })
  const frames: unknown[] = []
  stdin.on("data", (chunk) => { for (const line of String(chunk).trim().split("\n")) frames.push(JSON.parse(line)) })
  return { rpc, stdout, frames, exit }
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
