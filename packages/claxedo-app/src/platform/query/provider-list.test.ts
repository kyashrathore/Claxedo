import { describe, expect, test } from "bun:test"
import { filterConnectedByDisabledProviders, normalizeProviderList, providerNeedsDetailHydration } from "./provider-list"

describe("filterConnectedByDisabledProviders", () => {
  test("removes disabled ids from connected without mutating the input", () => {
    const cached = normalizeProviderList({
      all: [
        { id: "openai", name: "OpenAI", models: {} },
        { id: "clinepass-2", name: "Cline pass 2", models: {} },
      ],
      connected: ["openai", "clinepass-2"],
      default: {},
    })
    const filtered = filterConnectedByDisabledProviders(cached, ["clinepass-2"])
    expect(filtered.connected).toEqual(["openai"])
    expect(cached.connected).toEqual(["openai", "clinepass-2"])
  })
})

describe("providerNeedsDetailHydration", () => {
  test("connected index rows with one default model still need detail", () => {
    const cached = normalizeProviderList({
      all: [{ id: "opencode", name: "OpenCode Zen", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle" } } }],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    })
    expect(providerNeedsDetailHydration(cached, "opencode")).toBe(true)
  })

  test("connected rows with multiple models are fully hydrated", () => {
    const cached = normalizeProviderList({
      all: [{
        id: "opencode-go",
        name: "OpenCode Go",
        models: {
          "gpt-5.6-luna": { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          "kimi-k3": { id: "kimi-k3", name: "Kimi K3" },
        },
      }],
      connected: ["opencode-go"],
      default: { "opencode-go": "gpt-5.6-luna" },
    })
    expect(providerNeedsDetailHydration(cached, "opencode-go")).toBe(false)
  })

  test("disconnected preview providers with zero models need detail", () => {
    const cached = normalizeProviderList({
      all: [{ id: "anthropic", name: "Anthropic", models: {} }],
      connected: [],
      default: {},
    })
    expect(providerNeedsDetailHydration(cached, "anthropic")).toBe(true)
  })
})
