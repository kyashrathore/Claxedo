import { describe, expect, test } from "bun:test"
import { createLiveModelSource } from "./live-model-source"

describe("createLiveModelSource", () => {
  test("serves the live list and caches it within the TTL", async () => {
    let calls = 0
    const source = createLiveModelSource({
      fetchModels: async () => {
        calls++
        return [{ id: "gpt-5.6", name: "GPT-5.6" }]
      },
    })
    expect(await source.models("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
    expect(await source.models("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
    expect(calls).toBe(1)
    expect(source.peek("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
  })

  test("propagates model-list failures without synthesizing a catalog", async () => {
    const source = createLiveModelSource({
      fetchModels: async () => {
        throw new Error("harness unreachable")
      },
    })
    expect(source.peek("/work")).toEqual([])
    await expect(source.models("/work")).rejects.toThrow("harness unreachable")
  })

  test("preserves an authoritative empty model list", async () => {
    const source = createLiveModelSource({
      fetchModels: async () => [],
    })
    expect(await source.models()).toEqual([])
  })

  test("does not hide a failed refresh behind stale model data", async () => {
    let calls = 0
    const source = createLiveModelSource({
      ttlMs: 0,
      fetchModels: async () => {
        calls++
        if (calls === 1) return [{ id: "auto", name: "Auto" }]
        throw new Error("harness unreachable")
      },
    })
    expect(await source.models()).toEqual([{ id: "auto", name: "Auto" }])
    await expect(source.models()).rejects.toThrow("harness unreachable")
    expect(source.peek()).toEqual([{ id: "auto", name: "Auto" }])
  })

  test("isolates cached and in-flight lists by directory", async () => {
    const calls: Array<string | undefined> = []
    const source = createLiveModelSource({
      fetchModels: async (directory) => {
        calls.push(directory)
        return [{ id: directory ?? "central", name: directory ?? "Central" }]
      },
    })

    await expect(Promise.all([source.models("/one"), source.models("/two"), source.models("/one")])).resolves.toEqual([
      [{ id: "/one", name: "/one" }],
      [{ id: "/two", name: "/two" }],
      [{ id: "/one", name: "/one" }],
    ])
    expect(calls).toEqual(["/one", "/two"])
    expect(source.peek("/one")).toEqual([{ id: "/one", name: "/one" }])
    expect(source.peek("/two")).toEqual([{ id: "/two", name: "/two" }])
  })
})
