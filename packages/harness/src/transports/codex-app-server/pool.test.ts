import { expect, test } from "bun:test"
import type { Clock } from "../../contract"
import { ScriptedProcess } from "../../test-support/scripted-process"
import type { CodexProcess } from "./launch"
import { CodexProcessPool } from "./pool"
import { CodexRouter } from "./router"
import { CodexRpc } from "./rpc"

const silent = { debug() {}, info() {}, warn() {}, error() {} }

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

function harness(idleMs?: number) {
  const { clock, advance } = fakeClock()
  const wires: ScriptedProcess<unknown>[] = []
  const create = async (): Promise<CodexProcess> => {
    const wire = new ScriptedProcess<unknown>(() => {})
    wires.push(wire)
    const rpc = new CodexRpc(wire.owned(), clock)
    return { rpc, router: new CodexRouter(rpc, clock, silent), version: "0.159.2" }
  }
  const pool = new CodexProcessPool(clock, silent, idleMs)
  const retired = (index: number) => wires[index]!.retirements > 0
  return { pool, create, wires, retired, advance }
}

test("members of one key share a process, and it retires 30 s after the last member leaves", async () => {
  const { pool, create, wires, retired, advance } = harness()
  const a = await pool.acquire("owner-account", create)
  const b = await pool.acquire("owner-account", create)
  expect(a.process).toBe(b.process)
  await a.release()
  await advance(60_000)
  expect(retired(0)).toBe(false)
  await b.release()
  await advance(29_999)
  expect(retired(0)).toBe(false)
  await advance(1)
  expect(retired(0)).toBe(true)
  await pool.acquire("owner-account", create)
  expect(wires).toHaveLength(2)
  await pool.dispose()
})

test("a member joining within the idle window keeps the process", async () => {
  const { pool, create, wires, retired, advance } = harness()
  const first = await pool.acquire("key", create)
  await first.release()
  await advance(20_000)
  const again = await pool.acquire("key", create)
  await advance(30_000)
  expect(again.process).toBe(first.process)
  expect(retired(0)).toBe(false)
  await again.release()
  await again.release()
  await advance(30_000)
  expect(retired(0)).toBe(true)
  expect(wires).toHaveLength(1)
})

test("different keys never share, and a ninth member of one key opens a second process", async () => {
  const { pool, create, wires, retired } = harness()
  const leases = await Promise.all(Array.from({ length: 9 }, () => pool.acquire("key", create)))
  const other = await pool.acquire("other-account", create)
  expect(new Set(leases.map((lease) => lease.process)).size).toBe(2)
  expect(leases.filter((lease) => lease.process === leases[0]!.process)).toHaveLength(8)
  expect(other.process).not.toBe(leases[0]!.process)
  await pool.dispose()
  expect(wires.map((_, index) => retired(index))).toEqual([true, true, true])
})

test("a process that exits is evicted, so the next member starts a new one", async () => {
  const { pool, create, wires, retired } = harness()
  const a = await pool.acquire("key", create)
  wires[0]!.exit({ code: 1, signal: null })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const b = await pool.acquire("key", create)
  expect(b.process).not.toBe(a.process)
  await a.release()
  expect(retired(0)).toBe(false)
  await pool.dispose()
})

test("a failed start rejects every waiting member and leaves no entry behind", async () => {
  const { pool, create, wires } = harness()
  let fail = true
  const flaky = async () => {
    if (fail) throw new Error("initialize refused")
    return create()
  }
  await expect(Promise.all([pool.acquire("key", flaky), pool.acquire("key", flaky)])).rejects.toThrow("initialize refused")
  fail = false
  await pool.acquire("key", flaky)
  expect(wires).toHaveLength(1)
  await pool.dispose()
  await expect(pool.acquire("key", create)).rejects.toThrow("disposed")
})

test("with no idle retention the last release retires the process before it resolves", async () => {
  const { pool, create, retired } = harness(0)
  await (await pool.acquire("key", create)).release()
  expect(retired(0)).toBe(true)
})
