import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import type { HarnessServices, OwnedProcess } from "../../contract"
import { CursorHostRegistry } from "./host-registry"

function fixture() {
  const launches: { signal: AbortSignal; resolve: (process: OwnedProcess) => void }[] = []
  const retired: number[] = []
  const services = {
    spawn: (_command: unknown, options: { signal: AbortSignal }) => new Promise<OwnedProcess>((resolve) => launches.push({ signal: options.signal, resolve })),
    clock: { now: Date.now, setTimeout, clearTimeout },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as HarnessServices
  const process = (pid: number): OwnedProcess => ({ pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exited: new Promise(() => {}), retire: async () => { retired.push(pid); return { stopped: true } } })
  return { registry: new CursorHostRegistry(services, { file: "node", args: ["cursor-worker.js"] }, {}, new AbortController().signal), launches, retired, process }
}
const key = { binding: "owner", home: "/tmp" }

test("concurrent acquisitions share one host and retain it until both releases", async () => {
  const f = fixture()
  const first = f.registry.acquire(key)
  const second = f.registry.acquire(key)
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

test("releasing a retired generation cannot retire its replacement", async () => {
  const f = fixture()
  const first = f.registry.acquire(key)
  f.launches[0]!.resolve(f.process(5_000_000))
  const a = await first
  await a.retire()
  const second = f.registry.acquire(key)
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
  const first = f.registry.acquire(key).then(() => "acquired", (error: Error) => error.message)
  const second = f.registry.acquire(key).then(() => "acquired", (error: Error) => error.message)
  await f.registry.dispose()
  const aborted = f.launches.every((launch) => launch.signal.aborted)
  expect(await first).toContain("disposed")
  expect(await second).toContain("disposed")
  expect(aborted).toBe(true)
  for (const [index, launch] of f.launches.entries()) launch.resolve(f.process(5_000_000 + index))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.retired).toEqual([5_000_000])
  await expect(f.registry.acquire(key)).rejects.toThrow("disposed")
})

test("different host keys can spawn concurrently", async () => {
  const f = fixture()
  const other = { ...key, binding: "other-owner" }
  const first = f.registry.acquire(key)
  const second = f.registry.acquire(other)
  expect(f.launches).toHaveLength(2)
  f.launches[1]!.resolve(f.process(5_000_001))
  const b = await second
  await f.registry.release(other, b)
  expect(f.retired).toEqual([5_000_001])
  f.launches[0]!.resolve(f.process(5_000_000))
  await f.registry.release(key, await first)
  await f.registry.dispose()
})
