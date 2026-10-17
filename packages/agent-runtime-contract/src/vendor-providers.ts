import { HARNESS_TABLE, harnessForProviderId } from "./harness-table"
import { PI_PROVIDER_LABELS, piProviderSpending } from "./pi-providers"

/** The model vendors Claxedo stores accounts for and brokers to, as Settings names them. */
export const VENDOR_PROVIDER_NAMES = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
} as const

/** The vendor a stored account of this provider id belongs to, as Settings names it; the id itself for a provider Claxedo does not name. */
export function vendorName(providerId: string): string {
  const harness = harnessForProviderId(providerId)
  if (harness) return HARNESS_TABLE[harness].vendor
  const piProvider = piProviderSpending(providerId)
  return piProvider ? PI_PROVIDER_LABELS[piProvider] : providerId
}
