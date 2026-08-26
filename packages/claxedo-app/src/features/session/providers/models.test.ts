import { describe, expect, test } from "bun:test"
import { resolveModelVisibility } from "./models"

const defaults = {
  anthropic: "sonnet",
  openai: "gpt-5.3-chat",
}

describe("model visibility", () => {
  test("shows the configured provider default without storing a user override", () => {
    expect(
      resolveModelVisibility({
        model: { providerID: "anthropic", modelID: "sonnet" },
        defaults,
      }),
    ).toBe(true)
  })

  test("keeps newly loaded catalog models hidden until the user enables them", () => {
    expect(
      resolveModelVisibility({
        model: { providerID: "anthropic", modelID: "opus" },
        defaults,
      }),
    ).toBe(false)
  })

  test("user visibility overrides take precedence over provider defaults", () => {
    expect(
      resolveModelVisibility({
        model: { providerID: "anthropic", modelID: "opus" },
        defaults,
        user: "show",
      }),
    ).toBe(true)
    expect(
      resolveModelVisibility({
        model: { providerID: "anthropic", modelID: "sonnet" },
        defaults,
        user: "hide",
      }),
    ).toBe(false)
  })
})
