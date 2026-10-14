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

/**
 * The stored row a Pi provider runs on: the provider id it is stored under,
 * and, when the row cannot be spent, why — the verdict of its last Check or
 * its status — so a person whose only account the vendor refused is told that
 * rather than that they have none.
 */
export type PiProviderAccount = { by: string; refused?: string }

export function piProviderAccount(providerID: string, credential: CredentialMetadata | undefined): PiProviderAccount | undefined {
  if (!credential || !isPiLaunchProvider(providerID) || !acceptedKinds[providerID].includes(credential.kind)) return undefined
  const expired = credential.health === "expired" || (credential.expires_at != null && credential.expires_at <= Date.now())
  const refused = credential.status !== "available" ? credential.health ?? credential.status : expired ? "expired" : undefined
  return { by: credential.provider_id, ...(refused ? { refused } : {}) }
}

/** The account a Pi provider runs on among the rows its credential provider ids hold: a usable one first, else the first refused one. */
export function piProviderAccountAmong(providerID: string, rowOf: (credentialProviderId: string) => CredentialMetadata | undefined): PiProviderAccount | undefined {
  const accounts = piCredentialProviderIDs(providerID).flatMap((id) => piProviderAccount(providerID, rowOf(id)) ?? [])
  return accounts.find((account) => account.refused === undefined) ?? accounts[0]
}

const providerNames: Record<PiLaunchProvider, string> = { "openai-codex": "OpenAI Codex", ...VENDOR_PROVIDER_NAMES }

/**
 * Registry connection metadata, from each Pi provider to the account it runs
 * on. A provider connected by another harness's login (Anthropic through
 * Claude Code's) names that harness and is not Pi's to disconnect. Models are
 * the launch catalog the session host runs Pi with, listed only for a usable
 * account; a refused account's provider says `refused` and lists none.
 */
export function projectPiProviderCatalog(accounts: ReadonlyMap<string, PiProviderAccount>) {
  const usable = (id: PiLaunchProvider) => accounts.get(id)?.refused === undefined && accounts.has(id)
  const source = (id: PiLaunchProvider) => {
    const by = accounts.get(id)?.by
    if (by === undefined) return { source: "config" }
    const harness = by === id ? undefined : harnessForProviderId(by)
    return harness ? { source: "harness", harness } : { source: "api" }
  }
  const refusal = (id: PiLaunchProvider) => {
    const refused = accounts.get(id)?.refused
    return refused === undefined ? {} : { refused }
  }
  const models = (id: PiLaunchProvider) => Object.fromEntries(piLaunchCatalog([id]).map((model) => {
    const key = model.id.slice(id.length + 1)
    return [key, { id: key, name: model.name }]
  }))
  return {
    all: PI_LAUNCH_PROVIDERS.map((id) => ({ id, name: providerNames[id], env: [], ...source(id), ...refusal(id), models: usable(id) ? models(id) : {} })),
    connected: PI_LAUNCH_PROVIDERS.filter(usable),
    default: {},
  }
}

export type PiProviderCatalog = ReturnType<typeof projectPiProviderCatalog>
