import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { HarnessServices, OwnedProcess } from "../../contract"
import { CursorHostLeases, CursorHostRegistry } from "./host-registry"

function fixture() {
  const launches: { signal: AbortSignal; resolve: (process: OwnedProcess) => void }[] = []
  const retired: number[] = []
  const spawn = ((_command: unknown, options: { signal: AbortSignal }) => new Promise<OwnedProcess>((resolve) => launches.push({ signal: options.signal, resolve }))) as HarnessServices["spawn"]
  const process = (pid: number): OwnedProcess => ({ pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: new Promise(() => {}), retire: async () => { retired.push(pid); return { stopped: true } } })
  const registry = new CursorHostRegistry({ now: Date.now, setTimeout, clearTimeout }, { debug() {}, info() {}, warn() {}, error() {} })
  const launch = { spawn, worker: { file: "node", args: ["cursor-worker.js"] }, env: {} }
  return { registry, launch, launches, retired, process, leases: () => new CursorHostLeases(registry, launch) }
}
const key = { binding: "owner", home: "/tmp" }

test("concurrent acquisitions share one host and retain it until both releases", async () => {
  const f = fixture()
  const first = f.registry.acquire(key, f.launch)
  const second = f.registry.acquire(key, f.launch)
  const count = f.launches.length
  for (const [index, launch] of f.launches.entries()) launch.resolve(f.process(5_000_000 + index))
  const [a, b] = await Promise.all([first, second])
  try {
    expect(count).toBe(1)
    expect(a).toBe(b)
    await f.registry.release(key, a)
    expect(f.retired).toEqual([])
    await f.registry.release(key, b)
    expect(f.retired).toEqual([5_000_000])
  } finally { await f.registry.dispose() }
})

test("two workspaces' transports share one host, and disposing one keeps it for the other", async () => {
  const f = fixture()
  const workspaceA = f.leases()
  const workspaceB = f.leases()
  const first = workspaceA.acquire(key)
  await Promise.resolve()
  f.launches[0]!.resolve(f.process(5_000_000))
  const a = await first
  const b = await workspaceB.acquire(key)
  expect(a).toBe(b)
  expect(f.launches).toHaveLength(1)
  await workspaceA.dispose()
  expect(f.retired).toEqual([])
  expect(b.failed).toBe(false)
  await workspaceB.dispose()
  expect(f.retired).toEqual([5_000_000])
  await f.registry.dispose()
})

test("a disposed transport releases an acquisition that completes after its disposal", async () => {
  const f = fixture()
  const workspace = f.leases()
  const pending = workspace.acquire(key).then(() => "acquired", (error: Error) => error.message)
  await workspace.dispose()
  await Promise.resolve()
  f.launches[0]!.resolve(f.process(5_000_000))
  expect(await pending).toContain("disposed")
  expect(f.retired).toEqual([5_000_000])
  await f.registry.dispose()
})

test("hosts differ by backend URL even when binding and home match", async () => {
  const f = fixture()
  const first = f.registry.acquire({ ...key, backendUrl: "http://one" }, f.launch)
  const second = f.registry.acquire({ ...key, backendUrl: "http://two" }, f.launch)
  expect(f.launches).toHaveLength(2)
  for (const [index, launch] of f.launches.entries()) launch.resolve(f.process(5_000_000 + index))
  expect(await first).not.toBe(await second)
  await f.registry.dispose()
})

test("releasing a retired generation cannot retire its replacement", async () => {
  const f = fixture()
  const first = f.registry.acquire(key, f.launch)
  f.launches[0]!.resolve(f.process(5_000_000))
  const a = await first
  await a.retire()
  const second = f.registry.acquire(key, f.launch)
  await new Promise((resolve) => setTimeout(resolve, 0))
  f.launches[1]!.resolve(f.process(5_000_001))
  const b = await second
  await f.registry.release(key, a)
  await f.registry.release(key, a)
  expect(b.failed).toBe(false)
  await f.registry.release(key, b)
  expect(f.retired).toEqual([5_000_000, 5_000_001])
  await f.registry.dispose()
})

test("dispose aborts pending acquisitions and retires a late spawn", async () => {
  const f = fixture()
  const first = f.registry.acquire(key, f.launch).then(() => "acquired", (error: Error) => error.message)
  const second = f.registry.acquire(key, f.launch).then(() => "acquired", (error: Error) => error.message)
  await f.registry.dispose()
  const aborted = f.launches.every((launch) => launch.signal.aborted)
  expect(await first).toContain("disposed")
  expect(await second).toContain("disposed")
  expect(aborted).toBe(true)
  for (const [index, launch] of f.launches.entries()) launch.resolve(f.process(5_000_000 + index))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.retired).toEqual([5_000_000])
  await expect(f.registry.acquire(key, f.launch)).rejects.toThrow("disposed")
})
