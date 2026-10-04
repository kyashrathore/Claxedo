import {
  harnessForProviderId,
  isPiLaunchProvider,
  PI_LAUNCH_PROVIDERS,
  piCredentialProviderIDs,
  type PiLaunchProvider,
} from "@claxedo/agent-runtime-contract"
import { piLaunchCatalog } from "@claxedo/harness/pi-catalog"
import type { CredentialKind, CredentialMetadata } from "./types"
import { VENDOR_PROVIDER_NAMES } from "./vendor-providers"

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

export function piCredentialConnected(providerID: string, credential: CredentialMetadata | undefined) {
  return !!credential && credential.status === "available"
    && credential.health !== "expired"
    && (credential.expires_at == null || credential.expires_at > Date.now())
    && isPiLaunchProvider(providerID) && acceptedKinds[providerID].includes(credential.kind)
}

const providerNames: Record<PiLaunchProvider, string> = { "openai-codex": "OpenAI Codex", ...VENDOR_PROVIDER_NAMES }

/**
 * Registry connection metadata, from each connected Pi provider to the stored
 * provider id whose row connects it. A provider connected by another harness's
 * login (Anthropic through Claude Code's) names that harness and is not Pi's
 * to disconnect. Models are the launch catalog the session host runs Pi with.
 */
export function projectPiProviderCatalog(connected: ReadonlyMap<string, string>) {
  const source = (id: PiLaunchProvider) => {
    const by = connected.get(id)
    if (by === undefined) return { source: "config" }
    const harness = by === id ? undefined : harnessForProviderId(by)
    return harness ? { source: "harness", harness } : { source: "api" }
  }
  const models = (id: PiLaunchProvider) => Object.fromEntries(piLaunchCatalog([id]).map((model) => {
    const key = model.id.slice(id.length + 1)
    return [key, { id: key, name: model.name }]
  }))
  return {
    all: PI_LAUNCH_PROVIDERS.map((id) => ({ id, name: providerNames[id], env: [], ...source(id), models: models(id) })),
    connected: PI_LAUNCH_PROVIDERS.filter((id) => connected.has(id)),
    default: {},
  }
}

export type PiProviderCatalog = ReturnType<typeof projectPiProviderCatalog>
