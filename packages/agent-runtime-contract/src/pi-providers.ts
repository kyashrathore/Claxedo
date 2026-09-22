import { vendorCredentialProviderIds } from "./harness-table"

/**
 * The providers Pi can be launched on, and the stored rows each one can be
 * launched from.
 *
 * Here rather than beside either consumer, because two of them ask the same
 * question and a disagreement between them is invisible: the credential
 * catalog decides whether Settings calls a provider connected, and the harness
 * decides whether it writes that provider an overlay. Held apart, a provider
 * reads as connected and then has nothing to bind at the turn.
 *
 * `openai-codex` is Pi's own name for the ChatGPT-plan endpoint. It is a
 * different destination from its `openai` provider rather than the same one
 * signed in differently, which is why the plan and the key never appear in
 * each other's lists.
 */
export const PI_LAUNCH_PROVIDERS = [
  "openai-codex",
  "anthropic",
  "openai",
  "openrouter",
  "google",
  "groq",
  "xai",
] as const

export type PiLaunchProvider = (typeof PI_LAUNCH_PROVIDERS)[number]

export function isPiLaunchProvider(providerID: string): providerID is PiLaunchProvider {
  return PI_LAUNCH_PROVIDERS.some((provider) => provider === providerID)
}

/**
 * Anthropic takes the whole vendor list, harness logins first: a Claude Code
 * subscription reaches the same origin and paths an Anthropic key does. Every
 * other provider names only its own row, because no other vendor here has a
 * second login that reaches the same endpoint.
 */
const credentialProviders: Record<PiLaunchProvider, readonly string[]> = {
  "openai-codex": ["codex-app-server"],
  anthropic: vendorCredentialProviderIds("anthropic"),
  openai: ["openai"],
  openrouter: ["openrouter"],
  google: ["google"],
  groq: ["groq"],
  xai: ["xai"],
}

/** The stored provider ids a Pi provider can be launched on, best first. */
export function piCredentialProviderIDs(providerID: string): readonly string[] {
  return isPiLaunchProvider(providerID) ? credentialProviders[providerID] : []
}
