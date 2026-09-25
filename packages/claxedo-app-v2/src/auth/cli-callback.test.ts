import { describe, expect, test } from "bun:test"
import { CLI_CALLBACK_DOCUMENT, handOffCliCallback, localCallback, takeCliCallback } from "./cli-callback"

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

describe("the CLI callback handoff", () => {
  test("hands the callback to its own document once", () => {
    const tab = memoryStorage()
    const visited: string[] = []
    handOffCliCallback({ callback: "http://127.0.0.1:53111/callback", fields: { state: "s", access_token: "t" } }, (path) => visited.push(path), tab)
    expect(visited).toEqual([CLI_CALLBACK_DOCUMENT])
    expect(takeCliCallback(tab)).toEqual({ callback: "http://127.0.0.1:53111/callback", fields: { state: "s", access_token: "t" } })
    expect(takeCliCallback(tab)).toBeUndefined()
    expect(tab.length).toBe(0)
  })

  test("takes only a loopback http callback with text fields", () => {
    const tab = memoryStorage()
    for (const stored of [
      { callback: "https://127.0.0.1:53111/callback", fields: {} },
      { callback: "http://example.com/callback", fields: {} },
      { callback: "http://127.0.0.1:53111/callback", fields: { state: 1 } },
    ]) {
      handOffCliCallback(stored as never, () => undefined, tab)
      expect(takeCliCallback(tab)).toBeUndefined()
    }
  })

  test("a callback is http on a loopback host", () => {
    expect(localCallback("http://localhost:4000/x")).toBe("http://localhost:4000/x")
    expect(localCallback("http://[::1]:4000/x")).toBe("http://[::1]:4000/x")
    expect(localCallback("http://10.0.0.2:4000/x")).toBeUndefined()
    expect(localCallback("file:///etc/passwd")).toBeUndefined()
    expect(localCallback(null)).toBeUndefined()
  })
})
