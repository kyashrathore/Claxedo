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
    expect(source.peek()).toEqual([{ id: "gpt-5.6", name: "GPT-5.6" }])
  })

  test("falls back to the static catalog before any successful fetch", async () => {
    const source = createLiveModelSource({
      harness: "codex",
      fetchModels: async () => {
        throw new Error("harness unreachable")
      },
    })
    expect(source.peek()).toEqual(SDK_MODEL_CATALOG.codex)
    expect(await source.models("/work")).toEqual(SDK_MODEL_CATALOG.codex)
  })

  test("an empty live list never replaces the fallback", async () => {
    const source = createLiveModelSource({
      harness: "claude",
      fetchModels: async () => [],
    })
    expect(await source.models()).toEqual(SDK_MODEL_CATALOG.claude)
  })

  test("keeps serving the last good list when a refetch fails", async () => {
    let calls = 0
    const source = createLiveModelSource({
      harness: "cursor",
      ttlMs: 0,
      fetchModels: async () => {
        calls++
        if (calls === 1) return [{ id: "auto", name: "Auto" }]
        throw new Error("harness unreachable")
      },
    })
    expect(await source.models()).toEqual([{ id: "auto", name: "Auto" }])
    expect(await source.models()).toEqual([{ id: "auto", name: "Auto" }])
    expect(calls).toBe(2)
  })
})
