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
  let retirement: Promise<RetireOutcome> | undefined
  const process: OwnedProcess = { pid: 5_000_000, stdin, stdout, stderr, exited,
    retire: () => retirement ??= retire() }
  const clock: Clock = { now: Date.now, setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
  const diagnostics: ReturnType<typeof import("../../translate/unrecognized").unrecognizedEvent>[] = []
  return { stdin, stdout, exit, diagnostics, rpc: new PiRpc(process, clock, (event) => diagnostics.push(event)) }
}

async function command(stdin: PassThrough): Promise<{ id: string; type: string }> {
  return new Promise((resolve) => stdin.once("data", (chunk: Buffer) => resolve(JSON.parse(chunk.toString("utf8")))))
}

describe("Pi RPC wire", () => {
  test("reports malformed replies and waits for the real reply", async () => {
    const f = fixture()
    const sent = command(f.stdin)
    const answer = f.rpc.request("get_state")
    const request = await sent
    f.stdout.write(`${JSON.stringify({ type: "response", id: "other", command: "get_state", success: false })}\n`)
    f.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "prompt", success: false })}\n`)
    expect(f.diagnostics.map((event) => event.diagnostic.code)).toEqual(["unrecognized-event", "unrecognized-event"])
    expect(f.diagnostics.map((event) => event.diagnostic.method)).toEqual(["response.get_state", "response.prompt"])
    expect(f.rpc.alive).toBe(true)
    f.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "real" } })}\n`)
    expect(await answer).toEqual({ sessionId: "real" })
    f.exit({ code: 0, signal: null })
  })

  test("an unparseable record fails a pending request", async () => {
    const f = fixture()
    const answer = f.rpc.request("get_state")
    f.stdout.write("not-json\n")
    await expect(answer).rejects.toThrow("Invalid Pi RPC record")
    expect(f.rpc.alive).toBe(false)
    f.exit({ code: 0, signal: null })
  })

  test("reports a late reply after its request times out", async () => {
    const f = fixture()
    const sent = command(f.stdin)
    const answer = f.rpc.request("get_state", {}, 1)
    const request = await sent
    await expect(answer).rejects.toThrow("Pi get_state timed out")
    f.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true })}\n`)
    expect(f.diagnostics).toHaveLength(1)
    expect(f.rpc.alive).toBe(true)
    f.exit({ code: 0, signal: null })
  })

  test("splits only on LF and preserves Unicode separators", async () => {
    const f = fixture()
    const events: string[] = []
    f.rpc.onMessage((message) => events.push(String(message.text)))
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

  test("returns the first unsettled retirement result on later calls", async () => {
    let attempts = 0
    const f = fixture(async () => { attempts++; return { stopped: false, error: { code: "still-running", message: "Descendant alive" } } })
    const deadline = { at: Date.now() + 1_000, signal: new AbortController().signal }
    await expect(f.rpc.retire(deadline)).rejects.toThrow("Descendant alive")
    await expect(f.rpc.retire(deadline)).rejects.toThrow("Descendant alive")
    expect(attempts).toBe(1)
    f.exit({ code: 0, signal: null })
  })
})
