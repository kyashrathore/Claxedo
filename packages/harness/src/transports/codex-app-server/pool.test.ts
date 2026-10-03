import { expect, test } from "bun:test"
import type { Clock } from "../../contract"
import { CodexProcessPool, type PooledCodex } from "./pool"

function fakeClock() {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 0
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => { timers.set(++next, { at: now + ms, callback }); return next },
    clearTimeout: (handle) => { timers.delete(handle as number) },
  }
  const advance = async (ms: number) => {
    now += ms
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { clock, advance }
}

type FakeProcess = PooledCodex & { id: number; retired: boolean; exit(error: Error): void }

function harness(options: { idleMs?: number; capacity?: number } = {}) {
  const { clock, advance } = fakeClock()
  const created: FakeProcess[] = []
  const create = async () => {
    const failures = new Set<(error: Error) => void>()
    const process: FakeProcess = { id: created.length + 1, retired: false,
      rpc: { onFailure: (listener) => { failures.add(listener); return () => failures.delete(listener) }, retire: async () => { process.retired = true } },
      exit: (error) => { for (const listener of failures) listener(error) } }
    created.push(process)
    return process
  }
  const pool = new CodexProcessPool<FakeProcess>({ clock, log: { debug() {}, info() {}, warn() {}, error() {} }, ...options })
  return { pool, create, created, advance }
}

test("members of one key share a process, and it retires 30 s after the last member leaves", async () => {
  const { pool, create, created, advance } = harness()
  const a = await pool.acquire("owner-account", create)
  const b = await pool.acquire("owner-account", create)
  expect(a.process).toBe(b.process)
  await a.release()
  await advance(60_000)
  expect(created[0]!.retired).toBe(false)
  await b.release()
  await advance(29_999)
  expect(created[0]!.retired).toBe(false)
  await advance(1)
  expect(created[0]!.retired).toBe(true)
  const c = await pool.acquire("owner-account", create)
  expect(c.process).toBe(created[1]!)
  await pool.dispose()
})

test("a member joining within the idle window keeps the process", async () => {
  const { pool, create, created, advance } = harness()
  await (await pool.acquire("key", create)).release()
  await advance(20_000)
  const again = await pool.acquire("key", create)
  await advance(30_000)
  expect(again.process).toBe(created[0]!)
  expect(created[0]!.retired).toBe(false)
  await again.release()
  await again.release()
  await advance(30_000)
  expect(created[0]!.retired).toBe(true)
})

test("different keys never share, and a ninth member of one key opens a second process", async () => {
  const { pool, create, created } = harness()
  const leases = await Promise.all(Array.from({ length: 9 }, () => pool.acquire("key", create)))
  const other = await pool.acquire("other-account", create)
  expect(new Set(leases.map((lease) => lease.process)).size).toBe(2)
  expect(leases.filter((lease) => lease.process === created[0]!)).toHaveLength(8)
  expect(other.process).not.toBe(leases[0]!.process)
  await pool.dispose()
  expect(created.every((process) => process.retired)).toBe(true)
})

test("a process that fails is evicted, so the next member starts a new one", async () => {
  const { pool, create, created } = harness()
  const a = await pool.acquire("key", create)
  created[0]!.exit(new Error("exited"))
  const b = await pool.acquire("key", create)
  expect(b.process).toBe(created[1]!)
  await a.release()
  expect(created[0]!.retired).toBe(false)
  await pool.dispose()
})

test("a failed start rejects every waiting member and leaves no entry behind", async () => {
  const { pool, create, created } = harness()
  let fail = true
  const flaky = async () => {
    if (fail) throw new Error("initialize refused")
    return create()
  }
  await expect(Promise.all([pool.acquire("key", flaky), pool.acquire("key", flaky)])).rejects.toThrow("initialize refused")
  fail = false
  expect((await pool.acquire("key", flaky)).process).toBe(created[0]!)
  await pool.dispose()
  await expect(pool.acquire("key", create)).rejects.toThrow("disposed")
})

test("with no idle retention the last release retires the process before it resolves", async () => {
  const { pool, create, created } = harness({ idleMs: 0 })
  await (await pool.acquire("key", create)).release()
  expect(created[0]!.retired).toBe(true)
})
