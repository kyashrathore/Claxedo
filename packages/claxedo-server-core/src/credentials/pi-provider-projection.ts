import type { CredentialMetadata } from "./types"

export const PI_LAUNCH_PROVIDERS = ["openai-codex", "anthropic", "openai"] as const

export type PiLaunchProvider = (typeof PI_LAUNCH_PROVIDERS)[number]

/** Narrow an arbitrary provider id to one Pi can launch. */
export function isPiLaunchProvider(providerID: string): providerID is PiLaunchProvider {
  return PI_LAUNCH_PROVIDERS.some((provider) => provider === providerID)
}

const credentialProviders: Record<PiLaunchProvider, readonly string[]> = {
  "openai-codex": ["codex-app-server"],
  anthropic: ["anthropic"],
  openai: ["openai"],
}

export function piCredentialProviderIDs(providerID: string): readonly string[] {
  return isPiLaunchProvider(providerID) ? credentialProviders[providerID] : []
}

export function piCredentialConnected(providerID: string, credential: CredentialMetadata | undefined) {
  return !!credential && credential.status === "available"
    && credential.health !== "expired"
    && (credential.expires_at == null || credential.expires_at > Date.now())
    && (providerID === "openai-codex" ? credential.kind === "oauth_token" : credential.kind === "api_key")
}

const providerNames = { "openai-codex": "OpenAI Codex", anthropic: "Anthropic", openai: "OpenAI" }

/** Registry connection metadata. Models come from the selected machine runtime. */
export function projectPiProviderCatalog(connected: ReadonlySet<string>) {
  return {
    all: PI_LAUNCH_PROVIDERS.map((id) => ({ id, name: providerNames[id], env: [], source: connected.has(id) ? "api" : "config", models: {} })),
    connected: PI_LAUNCH_PROVIDERS.filter((id) => connected.has(id)),
    default: {},
    modelAvailability: "runtime_required" as const,
  }
}
