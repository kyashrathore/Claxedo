import { describe, expect, test } from "bun:test"
import { memoizeSuccessfulLoad } from "./retry"

describe("memoizeSuccessfulLoad", () => {
  test("shares an in-flight load and retries on the next use after rejection", async () => {
    let attempts = 0
    const value = { ready: true }
    const load = memoizeSuccessfulLoad(async () => {
      attempts += 1
      if (attempts === 1) throw new Error("chunk unavailable")
      return value
    })

    const first = load()
    expect(load()).toBe(first)
    await expect(first).rejects.toThrow("chunk unavailable")
    expect(attempts).toBe(1)

    const recovered = load()
    expect(await recovered).toBe(value)
    expect(load()).toBe(recovered)
    expect(attempts).toBe(2)
  })
})
