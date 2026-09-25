import { describe, expect, test } from "vitest"
import { ProviderCatalogViewError, projectProviderCatalog, readProviderCatalogView } from "./provider-catalog-view"

const catalog = {
  all: [
    { id: "anthropic", name: "Anthropic", source: "config", env: ["ANTHROPIC_API_KEY"], models: { opus: { id: "opus", connected: true }, haiku: { id: "haiku", connected: true } } },
    { id: "openai", name: "OpenAI", source: "config", env: ["OPENAI_API_KEY"], models: { gpt: { id: "gpt", connected: false } } },
    { id: "acme", name: "Acme", source: "custom", env: [], models: { one: { id: "one", connected: false } }, options: { baseURL: "https://acme.test" } },
  ],
  connected: ["anthropic"],
  default: { anthropic: "haiku", openai: "gpt", acme: "one" },
}

describe("provider catalog views", () => {
  test("the full catalog is the default", () => {
    expect(projectProviderCatalog(catalog, readProviderCatalogView({}))).toBe(catalog)
    expect(projectProviderCatalog(catalog, readProviderCatalogView({ view: "full" }))).toBe(catalog)
  })

  test("a provider read answers that provider alone, with every provider's connected and default", () => {
    const detail = projectProviderCatalog(catalog, readProviderCatalogView({ provider: "openai" }))
    expect(detail.all).toEqual([catalog.all[1]])
    expect(detail.connected).toEqual(["anthropic"])
    expect(detail.default).toEqual(catalog.default)
  })

  test("the summary keeps connected providers whole and names the rest without models", () => {
    const summary = projectProviderCatalog(catalog, readProviderCatalogView({ view: "summary" }))
    expect(summary.all).toEqual([
      catalog.all[0],
      { id: "openai", name: "OpenAI", source: "config", models: {} },
      { id: "acme", name: "Acme", source: "custom", models: {} },
    ])
    expect(summary.connected).toEqual(catalog.connected)
    expect(summary.default).toEqual(catalog.default)
  })

  test("an unknown provider is not found rather than an empty catalog", () => {
    const read = () => projectProviderCatalog(catalog, readProviderCatalogView({ provider: "missing" }))
    expect(read).toThrow(ProviderCatalogViewError)
    expect(read).toThrow(expect.objectContaining({ status: 404, code: "provider_catalog_provider_not_found" }))
  })

  test("an unknown view, an empty provider and a provider with a view are refused", () => {
    for (const query of [{ view: "tiny" }, { provider: "" }, { provider: "openai", view: "summary" }]) {
      expect(() => readProviderCatalogView(query)).toThrow(expect.objectContaining({ status: 400, code: "provider_catalog_view_invalid" }))
    }
  })
})
