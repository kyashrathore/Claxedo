import {
  isPiLaunchProvider,
  PI_LAUNCH_PROVIDERS,
  piCredentialProviderIDs,
  type PiLaunchProvider,
} from "@claxedo/agent-runtime-contract"
import type { CredentialKind, CredentialMetadata } from "./types"

export { isPiLaunchProvider, PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type PiLaunchProvider }

/**
 * The forms each provider's binding can spend.
 *
 * A plan and a key are different requests, not the same request authenticated
 * twice: the broker sends an OpenAI plan to the Codex backend and an OpenAI
 * key to the v1 API, while Anthropic's destination serves both on one path and
 * only changes the header it rides in.
 */
const acceptedKinds: Record<PiLaunchProvider, readonly CredentialKind[]> = {
  "openai-codex": ["oauth_token"],
  anthropic: ["api_key", "oauth_token", "subscription_session"],
  openai: ["api_key"],
  openrouter: ["api_key"],
  google: ["api_key"],
  groq: ["api_key"],
  xai: ["api_key"],
}

/** Pi providers whose account is pasted rather than signed in to. */
export function piProviderTakesApiKey(providerID: string) {
  return isPiLaunchProvider(providerID) && acceptedKinds[providerID].includes("api_key")
}

export function piCredentialConnected(providerID: string, credential: CredentialMetadata | undefined) {
  return !!credential && credential.status === "available"
    && credential.health !== "expired"
    && (credential.expires_at == null || credential.expires_at > Date.now())
    && isPiLaunchProvider(providerID) && acceptedKinds[providerID].includes(credential.kind)
}

const providerNames: Record<PiLaunchProvider, string> = {
  "openai-codex": "OpenAI Codex",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  google: "Google",
  groq: "Groq",
  xai: "xAI",
}

/** Registry connection metadata. Models come from the selected machine runtime. */
export function projectPiProviderCatalog(connected: ReadonlySet<string>) {
  return {
    all: PI_LAUNCH_PROVIDERS.map((id) => ({ id, name: providerNames[id], env: [], source: connected.has(id) ? "api" : "config", models: {} })),
    connected: PI_LAUNCH_PROVIDERS.filter((id) => connected.has(id)),
    default: {},
    modelAvailability: "runtime_required" as const,
  }
}
