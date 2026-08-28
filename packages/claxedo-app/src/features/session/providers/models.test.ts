import { describe, expect, test, mock } from "bun:test"
import { hydrateConnectedProviderDetails, resolveModelVisibility } from "./models"

const defaults = {
  anthropic: "sonnet",
  openai: "gpt-5.3-chat",
}

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

describe("hydrateConnectedProviderDetails", () => {
  test("loads every connected provider and tolerates per-provider failures", async () => {
    const load = mock(async (providerId: string) => {
      if (providerId === "broken") throw new Error("offline")
    })
    const connected = () => [{ id: "anthropic" }, { id: "openai" }, { id: "broken" }]

    const results = await hydrateConnectedProviderDetails({ connected, load })

    expect(load).toHaveBeenCalledTimes(3)
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"])
  })
})
