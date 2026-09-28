import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { HarnessServices, HarnessSession, OwnedProcess } from "../../contract"
import { PiRpcTransport } from "./index"
import { PiRpc } from "./rpc"

function fixture(clear: "stall" | "reject" | "ok") {
  const commands: string[] = []
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const owned: OwnedProcess = { pid: 5_000_000, stdin, stdout, stderr: new PassThrough(), exited: new Promise(() => {}),
    retire: async () => ({ stopped: true }) }
  const clock = { now: Date.now, setTimeout, clearTimeout }
  const rpc = new PiRpc(owned, clock, () => {})
  stdin.on("data", (chunk: Buffer) => {
    const command = JSON.parse(chunk.toString())
    commands.push(command.type)
    if (command.type === "clear_queue" && clear === "stall") return
    stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type,
      success: command.type !== "clear_queue" || clear === "ok", error: "clear refused" })}\n`)
  })
  const transport = new PiRpcTransport({ clock } as unknown as HarnessServices, {} as never)
  const session = { binding: { sessionId: "s1" } } as HarnessSession
  const entry = { session, rpc, busy: true, prompted: true, settled: false }
  ;(transport as unknown as { entries: Map<string, typeof entry> }).entries.set("s1", entry)
  return { transport, session, commands, rpc, entry }
}
const turn = { turnId: "t1", assistantMessageId: "a1" }

test("Pi cancellation attempts abort despite stalled queue clearing and obeys the deadline", async () => {
  const f = fixture("stall")
  const deadline = { at: Date.now() + 20, signal: new AbortController().signal }
  try {
    const result = await Promise.race([f.transport.cancel(f.session, turn, deadline), new Promise((resolve) => setTimeout(() => resolve("deadline ignored"), 150))])
    expect(result).toMatchObject({ execution: "unknown", cleanup: "owned", error: { code: "cancellation_timeout" } })
    expect(f.commands).toEqual(["clear_queue", "abort"])
  } finally { await f.rpc.retire(deadline) }
})

test("Pi still aborts when clear_queue rejects", async () => {
  const f = fixture("reject")
  const result = await f.transport.cancel(f.session, turn, { at: Date.now() + 1000, signal: new AbortController().signal })
  expect(f.commands).toEqual(["clear_queue", "abort"])
  expect(result).toMatchObject({ execution: "unknown", cleanup: "owned", error: { message: "clear refused" } })
})

test("Pi cancellation observes the caller signal while awaiting replies", async () => {
  const f = fixture("stall")
  const controller = new AbortController()
  const deadline = { at: Date.now() + 1000, signal: controller.signal }
  const pending = f.transport.cancel(f.session, turn, deadline)
  controller.abort()
  try {
    const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("signal ignored"), 150))])
    expect(result).toMatchObject({ cleanup: "owned", error: { code: "cancellation_timeout" } })
  } finally { await f.rpc.retire(deadline) }
})

test("Pi sends nothing for an expired cancellation or an idle session", async () => {
  const f = fixture("ok")
  const deadline = { at: Date.now() - 1, signal: new AbortController().signal }
  expect(await f.transport.cancel(f.session, turn, deadline)).toMatchObject({ error: { code: "cancellation_timeout" } })
  f.entry.busy = false
  expect(await f.transport.cancel(f.session, turn, deadline)).toEqual({ execution: "terminal", cleanup: "unknown" })
  expect(f.commands).toEqual([])
})

test("Pi reports terminal only after the entry observes settlement", async () => {
  const f = fixture("ok")
  f.entry.settled = true
  expect(await f.transport.cancel(f.session, turn, { at: Date.now() + 1000, signal: new AbortController().signal }))
    .toEqual({ execution: "terminal", cleanup: "unknown" })
  expect(f.commands).toEqual(["clear_queue", "abort"])
})
