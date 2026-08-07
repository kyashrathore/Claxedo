import { describe, expect, test } from "bun:test"
import { loadProviderDetailsOnce } from "./provider-cache"

describe("provider detail loading", () => {
  test("shares one provider detail request across consumers and remembers success", async () => {
    const queryKey = ["controlPlane", "dedupe-test", "providers"]
    let requests = 0
    let resolve!: () => void
    const load = () => {
      requests += 1
      return new Promise<void>((done) => {
        resolve = done
      })
    }

    const first = loadProviderDetailsOnce(queryKey, "anthropic", load)
    const second = loadProviderDetailsOnce(queryKey, "anthropic", load)
    await Promise.resolve()

    expect(requests).toBe(1)
    expect(second).toBe(first)
    resolve()
    await first
    await loadProviderDetailsOnce(queryKey, "anthropic", load)
    expect(requests).toBe(1)
  })

  test("allows a failed provider detail request to retry", async () => {
    const queryKey = ["controlPlane", "retry-test", "providers"]
    let requests = 0
    const load = async () => {
      requests += 1
      if (requests === 1) throw new Error("offline")
    }

    await expect(loadProviderDetailsOnce(queryKey, "anthropic", load)).rejects.toThrow("offline")
    await loadProviderDetailsOnce(queryKey, "anthropic", load)
    expect(requests).toBe(2)
  })
})
