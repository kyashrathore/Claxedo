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

test("the SDK grace signal retires only its owned process", async () => {
  let retired = 0
  const owned: OwnedProcess = { pid: 5_000_001, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: new Promise(() => {}), retire: async () => { retired++; return { stopped: true } } }
  const services = { spawn: async () => owned, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices
  const abort = new AbortController()
  const process = new ClaudeProcess(services, { command: "claude", args: [], env: {}, signal: abort.signal }, "s1")
  await process.started
  abort.abort()
  await process.retire({ at: Date.now() + 1000, signal: new AbortController().signal })
  expect(retired).toBe(1)
})

test("a stuck spawn has a bounded retirement and spawn failure is typed", async () => {
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  const stuck = new ClaudeProcess({ spawn: () => new Promise(() => {}), log } as unknown as HarnessServices,
    { command: "claude", args: [], env: {}, signal: new AbortController().signal }, "s1")
  await expect(stuck.retire({ at: Date.now() + 10, signal: new AbortController().signal }))
    .rejects.toMatchObject({ kind: "process" })
  const failed = new ClaudeProcess({ spawn: async () => { throw new Error("missing executable") }, log } as unknown as HarnessServices,
    { command: "claude", args: [], env: {}, signal: new AbortController().signal }, "s1")
  await expect(failed.started).rejects.toMatchObject({ kind: "process", message: "Claude Code spawn failed" })
})

test("a spawn that finishes after the caller's deadline still retires its own child", async () => {
  let release!: (owned: OwnedProcess) => void
  let retired = 0
  const started = new Promise<OwnedProcess>((resolve) => { release = resolve })
  const owned: OwnedProcess = { pid: 5_000_002, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: new Promise(() => {}), retire: async (deadline) => {
      expect(deadline.at).toBeGreaterThan(Date.now())
      retired++
      return { stopped: true }
    } }
  const services = { spawn: async () => started, log: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as HarnessServices
  const process = new ClaudeProcess(services, { command: "claude", args: [], env: {}, signal: new AbortController().signal }, "s1")
  await expect(process.retire({ at: Date.now() + 10, signal: new AbortController().signal })).rejects.toMatchObject({ kind: "process" })
  release(owned)
  await process.started
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(retired).toBe(1)
})
