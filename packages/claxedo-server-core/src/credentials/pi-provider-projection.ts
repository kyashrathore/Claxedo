import { piModelCatalog } from "@claxedo/agent-sdk-runtime/pi-catalog"
import type { CredentialMetadata } from "./types"

export const PI_LAUNCH_PROVIDERS = ["openai-codex", "anthropic", "openai"] as const

const credentialProviders: Record<(typeof PI_LAUNCH_PROVIDERS)[number], readonly string[]> = {
  "openai-codex": ["codex-app-server"],
  anthropic: ["anthropic"],
  openai: ["openai"],
}

export function piCredentialProviderIDs(providerID: string): readonly string[] {
  return Object.hasOwn(credentialProviders, providerID)
    ? credentialProviders[providerID as keyof typeof credentialProviders]
    : []
}

export function piCredentialConnected(providerID: string, credential: CredentialMetadata | undefined) {
  return !!credential && credential.status === "available"
    && credential.health !== "expired"
    && (credential.expires_at == null || credential.expires_at > Date.now())
    && (providerID === "openai-codex" ? credential.kind === "oauth_token" : credential.kind === "api_key")
}

const providerNames = { "openai-codex": "OpenAI Codex", anthropic: "Anthropic", openai: "OpenAI" }

/** Caller-owned credential access, shared model projection. */
export function projectPiProviderCatalog(connected: ReadonlySet<string>, local: ReadonlySet<string> = new Set()) {
  const launch = new Set<string>(PI_LAUNCH_PROVIDERS)
  const providers = piModelCatalog().filter((provider) => launch.has(provider.id))
  return {
    all: providers.map((provider) => ({
      id: provider.id,
      name: providerNames[provider.id as keyof typeof providerNames],
      env: [],
      source: connected.has(provider.id) ? "api" : local.has(provider.id) ? "env" : "config",
      models: Object.fromEntries(provider.models.map((model) => [model.id, {
        id: model.id, name: model.name,
        attachment: model.input.includes("image"), reasoning: model.reasoning,
        temperature: true, tool_call: true,
        limit: { context: model.contextWindow, output: model.maxTokens },
        cost: { input: model.cost.input, output: model.cost.output, cache_read: model.cost.cacheRead, cache_write: model.cost.cacheWrite },
        options: {},
      }])),
    })),
    connected: providers.filter((provider) => connected.has(provider.id) || local.has(provider.id)).map((provider) => provider.id),
    default: Object.fromEntries(providers.flatMap((provider) => provider.models[0] ? [[provider.id, provider.models[0].id]] : [])),
  }
}
