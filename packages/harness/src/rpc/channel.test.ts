import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"

import type { Clock, OwnedProcess } from "../contract"
import { NdjsonOwnedProcess } from "./channel"
import { StderrTail } from "./stderr-tail"

const clock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function fakeProcess() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let exit!: (status: { code: number | null; signal: string | null }) => void
  const process: OwnedProcess = {
    pid: 1,
    stdin: new PassThrough(),
    stdout,
    stderr,
    exited: new Promise((resolve) => { exit = resolve }),
    retire: async () => ({ stopped: true }),
  }
  return { process, stderr, exit }
}

describe("an NDJSON process exit", () => {
  test("is heard at once, and the failure read after stderr closes carries the whole stderr", async () => {
    const { process, stderr, exit } = fakeProcess()
    const tail = new StderrTail(process)
    const channel = new NdjsonOwnedProcess(process, clock, () => {}, (reason) => new Error(`${reason}: ${tail.value}`), () => {})
    const heard: string[] = []
    channel.onFailure((error) => heard.push(error.message))

    exit({ code: 1, signal: null })
    await new Promise((resolve) => setImmediate(resolve))
    expect(channel.alive).toBe(false)
    expect(heard).toEqual(["exit: "])
    expect(() => channel.send({})).toThrow("exit: ")
    const whole = channel.wholeFailure()

    stderr.end("config.toml: unknown field `sqlite_home`\n")
    expect((await whole)?.message).toBe("exit: config.toml: unknown field `sqlite_home`")
    expect(heard).toEqual(["exit: "])
  })
})
