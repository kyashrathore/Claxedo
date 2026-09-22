import { describe, expect, test } from "bun:test"
import {
  catalogNeedsSearch,
  modelGroupKey,
  MODELS_PREVIEW_COUNT,
  MODELS_SEARCH_THRESHOLD,
  providerUsesInlineSearch,
  settingsCatalogProviders,
  visibleModelsForProvider,
} from "./settings-catalog-rules"

const models = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`,
    name: `Model ${index}`,
  }))

describe("Settings Models provider search", () => {
  test("inline search appears only when a provider exceeds the threshold and page search is off", () => {
    expect(providerUsesInlineSearch(MODELS_SEARCH_THRESHOLD, false)).toBe(false)
    expect(providerUsesInlineSearch(MODELS_SEARCH_THRESHOLD + 1, false)).toBe(true)
    expect(providerUsesInlineSearch(MODELS_SEARCH_THRESHOLD + 1, true)).toBe(false)
  })

  test("small providers show every model without search", () => {
    const items = models(5)
    expect(visibleModelsForProvider({ items, query: "", pageFilterActive: false })).toEqual(items)
    expect(providerUsesInlineSearch(items.length, false)).toBe(false)
  })

  test("large providers preview the first N models until the user searches", () => {
    const items = models(15)
    expect(visibleModelsForProvider({ items, query: "", pageFilterActive: false })).toEqual(
      items.slice(0, MODELS_PREVIEW_COUNT),
    )
  })

  test("large providers filter by name or id when the inline query is set", () => {
    const items = [
      ...models(12),
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    ]
    expect(
      visibleModelsForProvider({ items, query: "opus", pageFilterActive: false }).map((item) => item.id),
    ).toEqual(["claude-opus-4-8"])
    expect(
      visibleModelsForProvider({ items, query: "model-3", pageFilterActive: false }).map((item) => item.id),
    ).toEqual(["model-3"])
  })

  test("page-level search bypasses the per-provider preview cap", () => {
    const items = models(20)
    expect(visibleModelsForProvider({ items, query: "", pageFilterActive: true })).toEqual(items)
  })
})

describe("Settings catalog providers", () => {
  const provider = (id: string) => ({ id, name: id })
  const registry = [
    ...Array.from({ length: 40 }, (_, index) => provider(`filler-${index}`)),
    ...["opencode", "opencode-go", "anthropic", "openai", "google"].map(provider),
  ]
  const popularProviders = ["opencode", "opencode-go", "anthropic", "openai", "google"]

  test("a harness catalog small enough to read is shown whole, connected first", () => {
    const all = ["claude-sdk", "codex-app-server", "cursor-sdk"].map(provider)
    expect(settingsCatalogProviders({
      all,
      connectedIds: ["cursor-sdk"],
      popularProviders: ["anthropic", "openai"],
    }).map((item) => item.id)).toEqual(["cursor-sdk", "claude-sdk", "codex-app-server"])
    expect(catalogNeedsSearch(all.length)).toBe(false)
  })

  test("the registry shows connected providers then the popular ones, and the rest only by search", () => {
    expect(settingsCatalogProviders({
      all: registry,
      connectedIds: ["opencode-go"],
      popularProviders,
    }).map((item) => item.id)).toEqual(["opencode-go", "opencode", "anthropic", "openai", "google"])
    expect(catalogNeedsSearch(registry.length)).toBe(true)
  })

  test("a query reaches a provider the unsearched view leaves out", () => {
    expect(settingsCatalogProviders({
      all: registry,
      connectedIds: [],
      popularProviders,
      query: "filler-37",
    }).map((item) => item.id)).toEqual(["filler-37"])
  })
})

describe("model group keys", () => {
  test("a catalog provider answers under its own id", () => {
    expect(modelGroupKey({ providerId: "anthropic", sampleModelId: "claude-opus-5" })).toBe("anthropic")
  })

  test("a harness reporting many vendors answers per vendor", () => {
    expect(modelGroupKey({ providerId: "pi", sampleModelId: "amazon-bedrock/nova-lite" })).toBe("pi/amazon-bedrock")
    expect(modelGroupKey({ providerId: "pi", sampleModelId: "openai/gpt-5.4" })).toBe("pi/openai")
  })

  test("a group with no models falls back to the provider id", () => {
    expect(modelGroupKey({ providerId: "pi" })).toBe("pi")
  })
})
