import { describe, expect, test } from "bun:test"
import {
  resolveTerminalReloadFlag,
  terminalReloadStorageKey,
} from "./pty-key-migration"

// The caller treats this as a one-shot marker: reading it consumes the key.

function createFakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const calls: Array<{ op: "get" | "set" | "remove"; key: string; value?: string }> = []
  const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
    getItem: (key: string) => {
      calls.push({ op: "get", key })
      return data.has(key) ? (data.get(key) as string) : null
    },
    setItem: (key: string, value: string) => {
      calls.push({ op: "set", key, value })
      data.set(key, value)
    },
    removeItem: (key: string) => {
      calls.push({ op: "remove", key })
      data.delete(key)
    },
  }
  return { storage, data, calls }
}

describe("terminalReloadStorageKey", () => {
  test("builds the current claxedo.pty.{id}.reload key", () => {
    expect(terminalReloadStorageKey("abc123")).toBe("claxedo.pty.abc123.reload")
  })

})

describe("resolveTerminalReloadFlag", () => {
  test("reading the current marker consumes it exactly once", () => {
    const id = "pty-2"
    const { storage, data, calls } = createFakeStorage({
      [terminalReloadStorageKey(id)]: "1",
    })

    const isReload = resolveTerminalReloadFlag(storage, id)

    expect(isReload).toBe(true)
    expect(calls.some((c) => c.op === "set")).toBe(false)
    expect(data.has(terminalReloadStorageKey(id))).toBe(false)
    expect(resolveTerminalReloadFlag(storage, id)).toBe(false)
  })

  test("absent marker returns false and leaves storage empty", () => {
    const id = "pty-3"
    const { storage, data } = createFakeStorage()

    const isReload = resolveTerminalReloadFlag(storage, id)

    expect(isReload).toBe(false)
    expect(data.size).toBe(0)
  })

  test("unavailable reads return false but still attempt marker cleanup", () => {
    const removed: string[] = []
    expect(resolveTerminalReloadFlag({
      getItem: () => { throw new Error("read disabled") },
      setItem: () => { throw new Error("unexpected write") },
      removeItem: (key) => { removed.push(key) },
    }, "pty-read")).toBe(false)
    expect(removed).toEqual(["claxedo.pty.pty-read.reload"])
  })

  test("unavailable removal does not discard an already-read reload marker", () => {
    expect(resolveTerminalReloadFlag({
      getItem: () => "1",
      setItem: () => { throw new Error("unexpected write") },
      removeItem: () => { throw new Error("remove disabled") },
    }, "pty-remove")).toBe(true)
  })
})
