import { describe, expect, test } from "vitest"
import { settledCompositionCache } from "./settled-composition-cache"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("settledCompositionCache", () => {
  test("builds per request until initialization settles, then reuses one instance", async () => {
    const key = {}
    const inits: Array<ReturnType<typeof deferred>> = []
    const get = settledCompositionCache(
      () => {
        const init = deferred()
        inits.push(init)
        return { init }
      },
      (value) => value.init.promise,
    )

    const first = get(key)
    const second = get(key)
    // A request that arrives while no instance has finished initializing gets
    // its OWN instance: sharing a pending init is exactly the wedge — the
    // promise lives on the first request's I/O context and a canceled first
    // request would hang every later caller.
    expect(second).not.toBe(first)

    inits[1]!.resolve()
    await flush()
    const third = get(key)
    expect(third).toBe(second)
    // The settled instance stays cached even after other candidates fail.
    inits[0]!.reject(new Error("constructor request canceled"))
    await flush()
    expect(get(key)).toBe(second)
  })

  test("never caches an instance whose initialization failed", async () => {
    const key = {}
    let built = 0
    const get = settledCompositionCache(
      () => ({ id: ++built }),
      () => Promise.reject(new Error("init died with its request")),
    )
    const first = get(key)
    await flush()
    const second = get(key)
    expect(second).not.toBe(first)
    expect(built).toBe(2)
  })

  test("keys are independent", async () => {
    const get = settledCompositionCache(
      () => ({}),
      () => Promise.resolve(),
    )
    const a = {}
    const b = {}
    const forA = get(a)
    await flush()
    expect(get(a)).toBe(forA)
    expect(get(b)).not.toBe(forA)
  })
})
