import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { HarnessServices, OwnedProcess } from "../../contract"
import { ClaudeProcess } from "./process"

test("Claude retirement delegates only to the owned launch after an SDK kill", async () => {
  const retired: number[] = []
  const owned: OwnedProcess = { pid: 5_000_000, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: new Promise(() => {}), retire: async () => { retired.push(5_000_000); return { stopped: true } } }
  const services = { spawn: async () => owned, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices
  const process = new ClaudeProcess(services, { command: "claude", args: [], env: {}, cwd: "/tmp", signal: new AbortController().signal }, "s1")
  await process.started
  expect(process.kill()).toBe(true)
  await process.retire({ at: Date.now() + 1000, signal: new AbortController().signal })
  expect(process.kill()).toBe(false)
  expect(retired).toEqual([5_000_000])
})
