import { afterEach, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { stopChild } from "../helpers/child-process"

const children = new Set<ChildProcess>()
afterEach(async () => {
  await Promise.all([...children].map((child) => stopChild(child, { graceMs: 10 })))
  children.clear()
})

test("stopping a running child resolves after its exit and repeated calls join", async () => {
  const child = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000); console.log("ready")'], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(child)
  await once(child.stdout, "data")
  const first = stopChild(child)
  expect(stopChild(child)).toBe(first)
  await first
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  await stopChild(child)
})

test.skipIf(process.platform === "win32")("an unresponsive child is killed and reaped before stop resolves", async () => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); console.log("ready")'], { stdio: ["ignore", "pipe", "pipe"] })
  children.add(child)
  await once(child.stdout, "data")
  await stopChild(child, { graceMs: 10 })
  expect(child.signalCode).toBe("SIGKILL")
})
