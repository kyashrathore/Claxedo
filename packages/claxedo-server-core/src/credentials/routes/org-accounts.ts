import { HARNESS_IDS, harnessBindingIds } from "@claxedo/agent-runtime-contract"
import { errorBody } from "@claxedo/server-core/platform/http/http"
import { fanoutEligible } from "../account-kinds"
import { builtInProviderRow } from "../built-in-destinations"
import { credentialSecretMaterial } from "../secret-material"
import type { CredentialKind, CredentialMetadata } from "../types"

/**
 * The organization's own model accounts: one API key per vendor, owner `null`,
 * spent by each person who chose the org account for that vendor's providers.
 * A plan login is never one. Claude and ChatGPT plans are personal, and their
 * terms forbid sharing them or spending one on another person's behalf, so the
 * row holds a key the vendor bills the organization for.
 */
const HARNESS_LOGINS: ReadonlySet<string> = new Set(HARNESS_IDS.flatMap(harnessBindingIds))

export function isOrgAccount(row: CredentialMetadata): boolean {
  return row.owner === null && fanoutEligible(row)
}

/**
 * Why a write cannot be a team account, or nothing when it can. A harness's
 * own binding (`claude-sdk`, `codex-app-server`, …) is refused because the
 * vendor id beside it already reaches the same origin: one row per vendor is
 * what keeps a person's org choice to exactly one delivered key per host.
 */
export function orgAccountRefusal(input: { provider_id: string; kind: CredentialKind; secret: string }) {
  if (!builtInProviderRow(input.provider_id) || HARNESS_LOGINS.has(input.provider_id)) {
    return errorBody("org_account_provider_unsupported", "A team account is a model vendor's API key, such as Anthropic's or OpenAI's.")
  }
  if (input.kind !== "api_key" || credentialSecretMaterial(input)?.form !== "api-key") {
    return errorBody(
      "org_account_plan_refused",
      "Team accounts hold API keys only. A Claude or ChatGPT plan belongs to one person: add it under your own accounts in Settings → Models.",
    )
  }
  return undefined
}

/** Why a person cannot choose the org account for these providers: the organization holds none for any of them. */
export function orgSourceRefusal(rows: readonly CredentialMetadata[], providerIds: readonly string[]) {
  if (rows.some((row) => isOrgAccount(row) && providerIds.includes(row.provider_id))) return undefined
  return errorBody(
    "org_account_missing",
    "Your organization has no team account for this provider. Ask an owner or admin to add one in Settings → Team accounts, or keep your own account.",
  )
}
