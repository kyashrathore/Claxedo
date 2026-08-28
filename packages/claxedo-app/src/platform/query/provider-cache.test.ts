import { describe, expect, test } from "bun:test"
import { loadProviderDetailsOnce, providerDetailCacheKey } from "./provider-cache"
import { normalizeProviderList, providerNeedsDetailHydration } from "./provider-list"
import { queryClient } from "./query-client"

describe("provider detail hydration", () => {
  test("connected index rows still need a detail fetch", () => {
    const cached = normalizeProviderList({
      all: [{ id: "opencode", name: "OpenCode Zen", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
    expect(providerNeedsDetailHydration(cached, "opencode")).toBe(true)
    expect(providerNeedsDetailHydration(cached, "opencode-go")).toBe(true)
  })

  test("fully hydrated connected providers skip detail fetch", () => {
    const cached = normalizeProviderList({
      all: [{
        id: "opencode",
        name: "OpenCode Zen",
        models: {
          "big-pickle": { id: "big-pickle", name: "Big Pickle" },
          "model-b": { id: "model-b", name: "Model B" },
        },
      }],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
    expect(providerNeedsDetailHydration(cached, "opencode")).toBe(false)
  })
})

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
    queryClient.setQueryData(queryKey, normalizeProviderList({
      all: [{
        id: "anthropic",
        name: "Anthropic",
        models: {
          sonnet: { id: "sonnet", name: "Sonnet" },
          opus: { id: "opus", name: "Opus" },
        },
      }],
      connected: ["anthropic"],
      default: { anthropic: "sonnet" },
    }))
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

  test("retries when the cache still holds an index-only connected row", async () => {
    const queryKey = ["controlPlane", "index-only-test", "providers"]
    queryClient.setQueryData(queryKey, normalizeProviderList({
      all: [{ id: "opencode", name: "OpenCode Zen", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    }))
    let requests = 0
    const load = async () => {
      requests += 1
      queryClient.setQueryData(queryKey, normalizeProviderList({
        all: [{
          id: "opencode",
          name: "OpenCode Zen",
          models: {
            "big-pickle": { id: "big-pickle", name: "Big Pickle" },
            "model-b": { id: "model-b", name: "Model B" },
          },
        }],
        connected: ["opencode"],
        default: { opencode: "big-pickle" },
      }))
    }

    await loadProviderDetailsOnce(queryKey, "opencode", load)
    expect(requests).toBe(1)
    await loadProviderDetailsOnce(queryKey, "opencode", load)
    expect(requests).toBe(1)

    queryClient.setQueryData(queryKey, normalizeProviderList({
      all: [{ id: "opencode", name: "OpenCode Zen", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    }))
    await loadProviderDetailsOnce(queryKey, "opencode", load)
    expect(requests).toBe(2)
    expect(providerDetailCacheKey(queryKey, "opencode")).toContain("opencode")
  })
})
