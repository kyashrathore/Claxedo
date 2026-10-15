import { HARNESS_IDS, HARNESS_TABLE, harnessBindingIds, harnessForProviderId } from "@claxedo/agent-runtime-contract"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { fanoutEligible } from "../account-kinds"
import { builtInProviderRow } from "../built-in-destinations"
import { pastedSecret } from "../secret-material"
import type { CredentialKind, CredentialMetadata } from "../types"

/**
 * The organization's own model accounts: one API key per vendor, owner `null`,
 * spent by each person who chose the org account for that vendor's providers.
 * A plan login is never one. Claude and ChatGPT plans are personal, and their
 * terms forbid sharing them or spending one on another person's behalf, so the
 * row holds a key the vendor bills the organization for.
 */
const HARNESS_LOGINS: ReadonlySet<string> = new Set(HARNESS_IDS.flatMap(harnessBindingIds))

/**
 * How each vendor's API keys begin, by its published key formats. Anything
 * else is refused before it is stored: a ChatGPT login's JWT, a Claude
 * refresh token (sk-ant-ort…) or a plan token (sk-ant-oat…) pasted as a team
 * key would be sent as one.
 */
const TEAM_KEYS: Readonly<Record<string, { vendor: string; prefix: string; refused?: string }>> = {
  anthropic: { vendor: "Anthropic", prefix: "sk-ant-api" },
  openai: { vendor: "OpenAI", prefix: "sk-", refused: "sk-ant-" },
  openrouter: { vendor: "OpenRouter", prefix: "sk-or-" },
  google: { vendor: "Google", prefix: "AIza" },
  groq: { vendor: "Groq", prefix: "gsk_" },
  xai: { vendor: "xAI", prefix: "xai-" },
  cursor: { vendor: "Cursor", prefix: "key_" },
}

export function isOrgAccount(row: CredentialMetadata): boolean {
  return row.owner === null && fanoutEligible(row)
}

/** A team key write the store refused because its author no longer administers the organization. */
export class OrgAccountWriteRefusedError extends Error {
  constructor() {
    super("The organization's account was not written: its author no longer administers the organization")
    this.name = "OrgAccountWriteRefusedError"
  }
}

/**
 * Why a write cannot be a team account, or nothing when it can. A harness's
 * own binding (`claude-sdk`, `codex-app-server`, …) is refused because the
 * vendor id beside it already reaches the same origin: one row per vendor is
 * what keeps a person's org choice to exactly one delivered key per host.
 */
export function orgAccountRefusal(input: { provider_id: string; kind: CredentialKind; secret: string }) {
  const key = Object.hasOwn(TEAM_KEYS, input.provider_id) ? TEAM_KEYS[input.provider_id] : undefined
  if (!key || !builtInProviderRow(input.provider_id) || HARNESS_LOGINS.has(input.provider_id)) {
    return errorBody("org_account_provider_unsupported", "A team account is a model vendor's API key, such as Anthropic's or OpenAI's.")
  }
  const secret = pastedSecret(input.secret)
  if (input.kind !== "api_key" || !secret.startsWith(key.prefix) || (key.refused !== undefined && secret.startsWith(key.refused))) {
    return errorBody(
      "org_account_plan_refused",
      `Team accounts hold API keys only, and ${key.vendor} API keys start with ${key.prefix}. A Claude or ChatGPT plan belongs to one person: add it under your own accounts in Settings → Models.`,
    )
  }
  return undefined
}

/** The provider whose team key serves `providerId`: itself, or for a harness's own binding the vendor behind that harness. */
function teamKeyProvider(providerId: string): string {
  const harness = harnessForProviderId(providerId)
  return harness && HARNESS_LOGINS.has(providerId) ? HARNESS_TABLE[harness].vendorProvider : providerId
}

/** Why a person cannot choose the org account for these providers: the organization holds no team key for one of them. */
export function orgSourceRefusal(rows: readonly CredentialMetadata[], providerIds: readonly string[]) {
  const held = new Set(rows.flatMap((row) => isOrgAccount(row) ? [row.provider_id] : []))
  if (providerIds.every((providerId) => held.has(providerId) || held.has(teamKeyProvider(providerId)))) return undefined
  return errorBody(
    "org_account_missing",
    "Your organization has no team account for this provider. Ask an owner or admin to add one in Settings → Team accounts, or keep your own account.",
  )
}
