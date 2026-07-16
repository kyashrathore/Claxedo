export type SandboxProviderFacts = {
  cost: string
  needs: string
  keyUrl: string | undefined
}

export function sandboxProviderFacts(provider: string): SandboxProviderFacts {
  if (provider === "daytona") {
    return {
      cost: "Usage-based billing; account credits may apply.",
      needs: "Daytona account and API key",
      keyUrl: "https://app.daytona.io/dashboard/keys",
    }
  }
  if (provider === "modal") {
    return {
      cost: "Usage-based billing with a limited free tier.",
      needs: "Modal account and token credentials",
      keyUrl: "https://modal.com/settings/tokens",
    }
  }
  return {
    cost: "Pricing is set by this provider.",
    needs: "A configured provider account",
    keyUrl: undefined,
  }
}
