import { describe, expect, test } from "vitest"
import { providerCatalogView } from "./provider-catalog-view"

const catalog = {
  all: [
    {
      id: "anthropic",
      name: "Anthropic",
      source: "env",
      options: { token: "large metadata" },
      models: {
        sonnet: { id: "sonnet", name: "Sonnet", context: 200_000 },
        opus: { id: "opus", name: "Opus", context: 200_000 },
      },
    },
    {
      id: "openai",
      name: "OpenAI",
      models: { gpt: { id: "gpt", name: "GPT" } },
    },
  ],
  connected: ["anthropic"],
  default: { anthropic: "sonnet", openai: "gpt" },
}

describe("providerCatalogView", () => {
  test("keeps only provider identity and a connected default model in the startup index", () => {
    expect(providerCatalogView(catalog)).toEqual({
      all: [
        { id: "anthropic", name: "Anthropic", models: { sonnet: catalog.all[0]!.models.sonnet } },
        { id: "openai", name: "OpenAI", models: {} },
      ],
      connected: ["anthropic"],
      default: catalog.default,
    })
  })

  test("returns full metadata and models only for the explicitly selected provider", () => {
    expect(providerCatalogView(catalog, "anthropic")).toEqual({
      all: [catalog.all[0]],
      connected: ["anthropic"],
      default: catalog.default,
    })
  })
})
