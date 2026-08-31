import { describe, expect, test } from "bun:test"
import { createLiveModelSource } from "./live-model-source"
import { SDK_MODEL_CATALOG } from "./sdk-model-catalog"

describe("createLiveModelSource", () => {
  test("serves the live list and caches it within the TTL", async () => {
    let calls = 0
    const source = createLiveModelSource({
      harness: "codex",
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

  test("keeps serving the last good list when a refetch fails", async () => {
    let calls = 0
    const source = createLiveModelSource({
      harness: "codex",
      ttlMs: 0,
      fetchModels: async () => {
        calls++
        if (calls === 1) return [{ id: "gpt-5.6", name: "GPT-5.6" }]
        throw new Error("harness unreachable")
      },
    })
    expect(await source.models("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
    expect(await source.models("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
    expect(await source.models("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
    // Each failure retries rather than parking behind a TTL the fetch never earned.
    expect(calls).toBe(3)
    expect(source.peek("/work")).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
  })

  test("an empty live list never replaces a cached list", async () => {
    let calls = 0
    const source = createLiveModelSource({
      harness: "claude",
      ttlMs: 0,
      fetchModels: async () => {
        calls++
        return calls === 1 ? [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }] : []
      },
    })
    expect(await source.models()).toEqual([{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }])
    expect(await source.models()).toEqual([{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }])
    expect(source.peek()).toEqual([{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }])
  })

  test("serves the static catalog while the harness has never answered", async () => {
    const source = createLiveModelSource({
      harness: "claude",
      fetchModels: async () => {
        throw new Error("harness unreachable")
      },
    })
    expect(source.peek()).toEqual([...SDK_MODEL_CATALOG.claude])
    expect(await source.models("/work")).toEqual([...SDK_MODEL_CATALOG.claude])
    expect(await createLiveModelSource({ harness: "codex", fetchModels: async () => [] }).models())
      .toEqual([...SDK_MODEL_CATALOG.codex])
  })

  test("propagates model-list failures without synthesizing a catalog when opted out", async () => {
    const source = createLiveModelSource({
      harness: "cursor",
      fallbackToCatalog: false,
      fetchModels: async () => {
        throw new Error("harness unreachable")
      },
    })
    expect(source.peek("/work")).toEqual([])
    await expect(source.models("/work")).rejects.toThrow("harness unreachable")
  })

  test("serves the last good list on failure even when opted out of the catalog", async () => {
    let calls = 0
    const source = createLiveModelSource({
      harness: "cursor",
      fallbackToCatalog: false,
      ttlMs: 0,
      fetchModels: async () => {
        calls++
        if (calls === 1) return [{ id: "auto", name: "Auto" }]
        throw new Error("harness unreachable")
      },
    })
    expect(await source.models()).toEqual([{ id: "auto", name: "Auto" }])
    expect(await source.models()).toEqual([{ id: "auto", name: "Auto" }])
    expect(source.peek()).toEqual([{ id: "auto", name: "Auto" }])
  })

  test("preserves an authoritative empty model list when opted out of the catalog", async () => {
    const source = createLiveModelSource({
      harness: "cursor",
      fallbackToCatalog: false,
      fetchModels: async () => [],
    })
    expect(await source.models()).toEqual([])
    expect(source.peek()).toEqual([])
  })

  test("isolates cached and in-flight lists by directory", async () => {
    const calls: Array<string | undefined> = []
    const source = createLiveModelSource({
      harness: "codex",
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

  test("invalidate drops cached lists so the next read refetches", async () => {
    let calls = 0
    const source = createLiveModelSource({
      harness: "cursor",
      fallbackToCatalog: false,
      fetchModels: async () => {
        calls++
        return [{ id: `model-${calls}`, name: `Model ${calls}` }]
      },
    })
    expect(await source.models("/work")).toEqual([{ id: "model-1", name: "Model 1" }])
    source.invalidate()
    expect(source.peek("/work")).toEqual([])
    expect(await source.models("/work")).toEqual([{ id: "model-2", name: "Model 2" }])
  })
})
