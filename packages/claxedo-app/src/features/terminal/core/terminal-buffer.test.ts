import { describe, expect, test } from "bun:test"
import {
  MAX_PERSIST_BUFFER_BUDGET_BYTES,
  MAX_PERSIST_BUFFER_BYTES,
  MAX_RESTORE_BUFFER_BYTES,
  pickPersistBufferEvictions,
  preparePersistBuffer,
  prepareRestoreBuffer,
} from "./terminal-buffer"

describe("terminal buffer guards", () => {
  test("restore_buffer_trim_keeps_recent_tail", () => {
    const head = "a".repeat(MAX_RESTORE_BUFFER_BYTES)
    const tail = "tail"
    const value = `${head}${tail}`
    const result = prepareRestoreBuffer(value)
    expect(result.trimmed).toBe(true)
    expect(result.value?.endsWith(tail)).toBe(true)
    expect(result.value?.length).toBe(MAX_RESTORE_BUFFER_BYTES)
  })

  test("prepareRestoreBuffer trims oversized buffers to recent bytes", () => {
    const head = "a".repeat(MAX_RESTORE_BUFFER_BYTES)
    const tail = "b".repeat(128)
    const value = `${head}${tail}`
    const result = prepareRestoreBuffer(value)
    expect(result.value?.length).toBe(MAX_RESTORE_BUFFER_BYTES)
    expect(result.trimmed).toBe(true)
    expect(result.value?.endsWith(tail)).toBe(true)
  })

  test("preparePersistBuffer trims oversized buffers to recent bytes", () => {
    const head = "x".repeat(MAX_PERSIST_BUFFER_BYTES)
    const tail = "y".repeat(64)
    const value = `${head}${tail}`
    const result = preparePersistBuffer(value)
    expect(result.length).toBe(MAX_PERSIST_BUFFER_BYTES)
    expect(result.endsWith(tail)).toBe(true)
  })

  test("persist_then_restore_roundtrip_keeps_latest_tail_exactly", () => {
    const source = "h".repeat(MAX_PERSIST_BUFFER_BYTES + 1024) + "LATEST-TAIL"
    const persisted = preparePersistBuffer(source)
    const restored = prepareRestoreBuffer(persisted)
    expect(restored.trimmed).toBe(false)
    expect(restored.value?.length).toBe(MAX_RESTORE_BUFFER_BYTES)
    expect(restored.value?.endsWith("LATEST-TAIL")).toBe(true)
  })

  test("prepareRestoreBuffer_boundary_does_not_trim_at_exact_limit", () => {
    const value = "z".repeat(MAX_RESTORE_BUFFER_BYTES)
    const result = prepareRestoreBuffer(value)
    expect(result.trimmed).toBe(false)
    expect(result.value).toBe(value)
  })
})

describe("combined persisted snapshot budget", () => {
  const terminal = (id: string, kb: number) => ({ id, buffer: "x".repeat(kb * 1024) })
  const totalOf = (
    terminals: ReadonlyArray<{ id: string; buffer?: string }>,
    evicted: ReadonlyArray<string>,
  ) =>
    terminals
      .filter((item) => !evicted.includes(item.id))
      .reduce((sum, item) => sum + (item.buffer?.length ?? 0), 0)

  test("leaves an ordinary store untouched", () => {
    const terminals = [terminal("a", 200), terminal("b", 200), terminal("c", 200)]
    expect(pickPersistBufferEvictions({ terminals, keep: ["c"] })).toEqual([])
  })

  test("brings a store that outgrew the budget back under it", () => {
    // Twenty full-size snapshots is 5.1 MB — over the ~5 MB localStorage origin
    // budget on their own, before any other workspace or store.
    const terminals = Array.from({ length: 20 }, (_, i) =>
      terminal(`t${i}`, MAX_PERSIST_BUFFER_BYTES / 1024))
    const evicted = pickPersistBufferEvictions({ terminals, keep: ["t19"] })

    expect(evicted.length).toBeGreaterThan(0)
    expect(totalOf(terminals, evicted)).toBeLessThanOrEqual(MAX_PERSIST_BUFFER_BUDGET_BYTES)
    // Oldest first: the terminals created earliest give up their history first.
    expect(evicted[0]).toBe("t0")
  })

  test("never drops the snapshot just written or the active terminal's", () => {
    const terminals = Array.from({ length: 20 }, (_, i) =>
      terminal(`t${i}`, MAX_PERSIST_BUFFER_BYTES / 1024))
    const evicted = pickPersistBufferEvictions({ terminals, keep: ["t5", "t0"] })

    // Those two are the history most likely to be restored next, which is the
    // whole reason to persist it — t0 survives despite being the oldest.
    expect(evicted).not.toContain("t5")
    expect(evicted).not.toContain("t0")
    expect(totalOf(terminals, evicted)).toBeLessThanOrEqual(MAX_PERSIST_BUFFER_BUDGET_BYTES)
  })

  test("skips terminals that carry no snapshot", () => {
    const terminals = [
      { id: "empty-0" },
      { id: "empty-1", buffer: "" },
      terminal("big-0", MAX_PERSIST_BUFFER_BYTES / 1024),
      terminal("big-1", MAX_PERSIST_BUFFER_BYTES / 1024),
      terminal("big-2", MAX_PERSIST_BUFFER_BYTES / 1024),
      terminal("big-3", MAX_PERSIST_BUFFER_BYTES / 1024),
      terminal("big-4", MAX_PERSIST_BUFFER_BYTES / 1024),
    ]
    const evicted = pickPersistBufferEvictions({ terminals, keep: ["big-4"] })

    // Clearing a snapshot that does not exist frees nothing and would only
    // churn the store.
    expect(evicted).not.toContain("empty-0")
    expect(evicted).not.toContain("empty-1")
    expect(totalOf(terminals, evicted)).toBeLessThanOrEqual(MAX_PERSIST_BUFFER_BUDGET_BYTES)
  })

  test("stops as soon as the store fits rather than clearing everything", () => {
    const terminals = Array.from({ length: 8 }, (_, i) =>
      terminal(`t${i}`, MAX_PERSIST_BUFFER_BYTES / 1024))
    const evicted = pickPersistBufferEvictions({ terminals, keep: ["t7"] })

    expect(evicted.length).toBeLessThan(terminals.length - 1)
    expect(totalOf(terminals, evicted)).toBeLessThanOrEqual(MAX_PERSIST_BUFFER_BUDGET_BYTES)
  })
})
