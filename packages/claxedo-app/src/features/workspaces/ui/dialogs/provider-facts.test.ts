import { describe, expect, test } from "bun:test"
import { sandboxProviderFacts } from "./provider-facts"

describe("sandbox provider facts", () => {
  test("provides honest setup and billing context for supported hosted drivers", () => {
    expect(sandboxProviderFacts("daytona")).toEqual({
      cost: "Usage-based billing; account credits may apply.",
      needs: "Daytona account and API key",
      keyUrl: "https://app.daytona.io/dashboard/keys",
      accountUrl: "https://app.daytona.io/dashboard",
    })
    expect(sandboxProviderFacts("modal")).toEqual({
      cost: "Usage-based billing with a limited free tier.",
      needs: "Modal account and token credentials",
      keyUrl: "https://modal.com/settings/tokens",
      accountUrl: "https://modal.com/settings",
    })
  })

  test("does not invent pricing or a key page for an unknown driver", () => {
    expect(sandboxProviderFacts("custom")).toEqual({
      cost: "Pricing is set by this provider.",
      needs: "A configured provider account",
      keyUrl: undefined,
      accountUrl: undefined,
    })
  })
})
