import { describe, expect, test } from "bun:test"
import {
  legacyTerminalReloadStorageKey,
  resolveTerminalReloadFlag,
  terminalReloadStorageKey,
} from "./terminal-pty-key-migration"

// Behavior spec for the one-time `opencode.pty.{id}.reload` ->
// `claxedo.pty.{id}.reload` localStorage-key migration. The production
// caller (terminal.tsx) treats this as a one-shot marker: reading it always
// consumes (clears) both the legacy and current keys.

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

describe("terminalReloadStorageKey / legacyTerminalReloadStorageKey", () => {
  test("builds the current claxedo.pty.{id}.reload key", () => {
    expect(terminalReloadStorageKey("abc123")).toBe("claxedo.pty.abc123.reload")
  })

  test("builds the legacy opencode.pty.{id}.reload key", () => {
    expect(legacyTerminalReloadStorageKey("abc123")).toBe("opencode.pty.abc123.reload")
  })
})

describe("resolveTerminalReloadFlag", () => {
  test("legacy key present, current key absent: reload is honored, migrated to the new key, and the old key is removed", () => {
    const id = "pty-1"
    const { storage, data, calls } = createFakeStorage({
      [legacyTerminalReloadStorageKey(id)]: "1",
    })

    const isReload = resolveTerminalReloadFlag(storage, id)

    expect(isReload).toBe(true)
    expect(calls).toContainEqual({ op: "set", key: terminalReloadStorageKey(id), value: "1" })
    expect(data.has(legacyTerminalReloadStorageKey(id))).toBe(false)
    expect(data.has(terminalReloadStorageKey(id))).toBe(false)
  })

  test("current key present: reload is honored without touching the legacy key", () => {
    const id = "pty-2"
    const { storage, data, calls } = createFakeStorage({
      [terminalReloadStorageKey(id)]: "1",
    })

    const isReload = resolveTerminalReloadFlag(storage, id)

    expect(isReload).toBe(true)
    expect(calls.some((c) => c.op === "set")).toBe(false)
    expect(data.has(terminalReloadStorageKey(id))).toBe(false)
  })

  test("neither key present: returns false and leaves storage empty", () => {
    const id = "pty-3"
    const { storage, data } = createFakeStorage()

    const isReload = resolveTerminalReloadFlag(storage, id)

    expect(isReload).toBe(false)
    expect(data.size).toBe(0)
  })

  test("both keys present: current key wins, both are cleared, no redundant write", () => {
    const id = "pty-4"
    const { storage, data, calls } = createFakeStorage({
      [terminalReloadStorageKey(id)]: "1",
      [legacyTerminalReloadStorageKey(id)]: "1",
    })

    const isReload = resolveTerminalReloadFlag(storage, id)

    expect(isReload).toBe(true)
    expect(calls.some((c) => c.op === "set")).toBe(false)
    expect(data.size).toBe(0)
  })

  test("a getItem/setItem/removeItem throw is swallowed and does not crash the caller", () => {
    const id = "pty-5"
    const storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: () => {
        throw new Error("storage disabled")
      },
      setItem: () => {
        throw new Error("storage disabled")
      },
      removeItem: () => {
        throw new Error("storage disabled")
      },
    }

    expect(() => resolveTerminalReloadFlag(storage, id)).not.toThrow()
    expect(resolveTerminalReloadFlag(storage, id)).toBe(false)
  })
})
