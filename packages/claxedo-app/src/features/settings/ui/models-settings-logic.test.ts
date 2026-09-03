import { describe, expect, test } from "bun:test"
import {
  MODELS_PREVIEW_COUNT,
  MODELS_SEARCH_THRESHOLD,
  providerUsesInlineSearch,
  settingsModelCatalogProviders,
  visibleModelsForProvider,
} from "./models-settings-logic"

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

describe("Settings Models catalog providers", () => {
  const provider = (id: string) => ({ id })

  test("a harness catalog small enough to read is shown whole", () => {
    const all = ["claude-sdk", "codex-app-server", "cursor-sdk"].map(provider)
    expect(settingsModelCatalogProviders({
      all,
      connectedIds: ["cursor-sdk"],
      popularProviders: ["anthropic", "openai"],
    }).map((item) => item.id)).toEqual(["cursor-sdk", "claude-sdk", "codex-app-server"])
  })

  test("the models.dev registry shows connected providers plus a small popular preview", () => {
    const all = [
      ...Array.from({ length: 40 }, (_, index) => provider(`filler-${index}`)),
      ...["opencode", "opencode-go", "anthropic", "openai", "google"].map(provider),
    ]
    expect(settingsModelCatalogProviders({
      all,
      connectedIds: ["opencode-go", "opencode"],
      popularProviders: ["opencode", "opencode-go", "anthropic", "openai", "google"],
      previewDisconnectedCount: 2,
    }).map((item) => item.id)).toEqual(["opencode", "opencode-go", "anthropic", "openai"])
  })
})
