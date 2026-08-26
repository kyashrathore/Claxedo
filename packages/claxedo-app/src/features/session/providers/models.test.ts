import { describe, expect, test } from "bun:test"
import { hydrateConnectedProviderDetails, resolveModelVisibility } from "./models"

const defaults = {
  anthropic: "sonnet",
  openai: "gpt-5.3-chat",
}

// The boot catalog is an INDEX (one default model per connected provider);
// hydration is the picker-open step that fills in the rest.
describe("hydrateConnectedProviderDetails", () => {
  test("loads detail for every connected provider, and only those", async () => {
    const loaded: string[] = []
    await hydrateConnectedProviderDetails({
      connected: () => [{ id: "anthropic" }, { id: "openai" }],
      load: async (id) => {
        loaded.push(id)
      },
    })
    expect(loaded.sort()).toEqual(["anthropic", "openai"])
  })

  test("one provider's failed detail fetch does not abort the others", async () => {
    const loaded: string[] = []
    const results = await hydrateConnectedProviderDetails({
      connected: () => [{ id: "anthropic" }, { id: "broken" }, { id: "openai" }],
      load: async (id) => {
        if (id === "broken") throw new Error("detail fetch failed")
        loaded.push(id)
      },
    })
    expect(loaded.sort()).toEqual(["anthropic", "openai"])
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
  })
})

describe("model visibility", () => {
  test("shows the configured provider default without storing a user override", () => {
    expect(resolveModelVisibility({
      model: { providerID: "anthropic", modelID: "sonnet" },
      defaults,
    })).toBe(true)
  })

  test("keeps newly loaded catalog models hidden until the user enables them", () => {
    expect(resolveModelVisibility({
      model: { providerID: "anthropic", modelID: "opus" },
      defaults,
    })).toBe(false)
  })

  test("user visibility overrides take precedence over provider defaults", () => {
    expect(resolveModelVisibility({
      model: { providerID: "anthropic", modelID: "opus" },
      defaults,
      user: "show",
    })).toBe(true)
    expect(resolveModelVisibility({
      model: { providerID: "anthropic", modelID: "sonnet" },
      defaults,
      user: "hide",
    })).toBe(false)
  })
})
