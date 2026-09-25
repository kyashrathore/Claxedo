import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { Clock, ExitStatus, OwnedProcess, RetireOutcome } from "../../contract"
import { PiRpc } from "./rpc"

function fixture(retire: () => Promise<RetireOutcome> = async () => ({ stopped: true })) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let exit!: (status: ExitStatus) => void
  const exited = new Promise<ExitStatus>((resolve) => { exit = resolve })
  const process: OwnedProcess = { pid: 42, stdin, stdout, stderr, exited, retire }
  const clock: Clock = { now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  return { stdin, stdout, exit, rpc: new PiRpc(process, clock) }
}

async function command(stdin: PassThrough): Promise<{ id: string; type: string }> {
  return new Promise((resolve) => stdin.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString("utf8")))))
}

describe("Pi RPC wire", () => {
  test.each(["wrong id", "wrong command"])("refuses a response with %s", async (fault) => {
    const f = fixture()
    const sent = command(f.stdin)
    const answer = f.rpc.request("get_state")
    const request = await sent
    const response = { type: "response", id: fault === "wrong id" ? "other" : request.id,
      command: fault === "wrong command" ? "prompt" : request.type, success: true, data: {} }
    f.stdout.write(`${JSON.stringify(response)}\n`)
    await expect(answer).rejects.toThrow()
    expect(f.rpc.alive).toBe(false)
    expect(f.rpc.exited).toBe(false)
    f.exit({ code: 0, signal: null })
    await f.rpc.process.exited
    expect(f.rpc.exited).toBe(true)
  })

  test("splits only on LF and preserves Unicode separators", async () => {
    const f = fixture()
    const events: string[] = []
    f.rpc.onEvent((message) => events.push(String(message.text)))
    f.stdout.write('{"type":"notice","text":"one\u2028two\u2029three"}\n')
    expect(events).toEqual(["one\u2028two\u2029three"])
    f.exit({ code: 0, signal: null })
  })

  test("retirement does not claim OS exit before observation", async () => {
    const f = fixture()
    await f.rpc.retire({ at: Date.now() + 1_000, signal: new AbortController().signal })
    expect(f.rpc.alive).toBe(false)
    expect(f.rpc.exited).toBe(false)
    f.exit({ code: 0, signal: null })
    await f.rpc.process.exited
    expect(f.rpc.exited).toBe(true)
  })

  test("retries an unsettled retirement until the owned process stops", async () => {
    let attempts = 0
    const f = fixture(async () => ++attempts === 1
      ? { stopped: false, error: { code: "still-running", message: "Descendant alive" } }
      : { stopped: true })
    const deadline = { at: Date.now() + 1_000, signal: new AbortController().signal }
    await expect(f.rpc.retire(deadline)).rejects.toThrow("Descendant alive")
    await f.rpc.retire(deadline)
    expect(attempts).toBe(2)
    f.exit({ code: 0, signal: null })
  })
})
