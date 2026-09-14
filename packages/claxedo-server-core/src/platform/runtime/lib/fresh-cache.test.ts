import { describe, expect, test, vi } from "vitest"
import { createFreshCache } from "./fresh-cache"

function deferred<V>() {
  const keys: string[] = []
  let release: (value: V) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const read = (key: string) => {
    keys.push(key)
    return new Promise<V>((resolve, reject) => {
      release = resolve
      fail = reject
    })
  }
  return { keys, read, release: (value: V) => release(value), fail: (error: Error) => fail(error) }
}

describe("createFreshCache", () => {
  test("callers that arrive together share one read, a fresh one included", async () => {
    const probe = deferred<string>()
    const cache = createFreshCache({ read: probe.read, freshForMs: 1_000 })

    const all = Promise.all([cache.read("k"), cache.read("k", { fresh: true }), cache.read("k")])
    probe.release("shared")

    expect(await all).toEqual(["shared", "shared", "shared"])
    expect(probe.keys).toEqual(["k"])
  })

  test("the answer stands for its window and is asked again after it", async () => {
    let clock = 1_000
    const read = vi.fn(async () => `at ${clock}`)
    const cache = createFreshCache({ read, freshForMs: 10_000, now: () => clock })

    expect(await cache.read("k")).toBe("at 1000")
    clock += 9_999
    expect(await cache.read("k")).toBe("at 1000")
    expect(read).toHaveBeenCalledTimes(1)

    clock += 1
    expect(await cache.read("k")).toBe("at 11000")
    expect(read).toHaveBeenCalledTimes(2)
  })

  test("a fresh read inside the window reaches the reader and tells it so", async () => {
    const read = vi.fn(async (_key: string, { fresh }: { fresh: boolean }) => (fresh ? "fresh" : "held"))
    const cache = createFreshCache({ read, freshForMs: 60_000, now: () => 0 })

    expect(await cache.read("k")).toBe("held")
    expect(await cache.read("k", { fresh: true })).toBe("fresh")
    expect(read).toHaveBeenNthCalledWith(1, "k", { fresh: false })
    expect(read).toHaveBeenNthCalledWith(2, "k", { fresh: true })
    expect(await cache.read("k")).toBe("fresh")
    expect(read).toHaveBeenCalledTimes(2)
  })

  test("each key is remembered on its own", async () => {
    const read = vi.fn(async (key: string) => key.toUpperCase())
    const cache = createFreshCache({ read, freshForMs: 60_000, now: () => 0 })

    expect(await cache.read("a")).toBe("A")
    expect(await cache.read("b")).toBe("B")
    expect(await cache.read("a")).toBe("A")
    expect(read.mock.calls.map(([key]) => key)).toEqual(["a", "b"])
  })

  test("a read that threw is asked again rather than remembered", async () => {
    const probe = deferred<string>()
    const cache = createFreshCache({ read: probe.read, freshForMs: 60_000, now: () => 0 })

    const failed = cache.read("k")
    probe.fail(new Error("keychain locked"))
    await expect(failed).rejects.toThrow("keychain locked")

    const again = cache.read("k")
    probe.release("answered")
    expect(await again).toBe("answered")
    expect(probe.keys).toEqual(["k", "k"])
  })
})
