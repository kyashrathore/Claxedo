import type { CredentialSpend } from "@claxedo/usage-contract"
import type { UsagePricing } from "./adapters/token-tracker-pricing"
import { priceCentralBreakdown } from "./central-pricing"
import type { CredentialSpendRow } from "./ledger"
import { rowNumber } from "./projection"

const CREDENTIAL_KINDS = ["api_key", "oauth_token", "subscription_session"] as const

function credentialKind(value: string | null): CredentialSpend["kind"] {
  return CREDENTIAL_KINDS.find((kind) => kind === value)
}

function spendTotals(rows: readonly CredentialSpendRow[]) {
  const sum = (...keys: string[]) => rows.reduce((total, row) => total + rowNumber(row, ...keys), 0)
  return {
    turnCount: sum("turn_count"),
    input: sum("input_tokens"),
    output: sum("output_tokens"),
    reasoning: sum("reasoning_tokens"),
    cacheRead: sum("cache_read_tokens"),
    cacheWrite: sum("cache_write_tokens"),
    unknownCategories: sum("unknown_token_count"),
    partialTurnCount: sum("partial_turn_count"),
    unavailableTurnCount: sum("unavailable_turn_count"),
    errorTurnCount: sum("error_turn_count"),
  }
}

function byCredential(rows: readonly CredentialSpendRow[]) {
  const groups = new Map<string, { head: CredentialSpendRow; models: CredentialSpendRow[] }>()
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.credential_id, row.credential_kind])
    const group = groups.get(key)
    if (group) group.models.push(row)
    else groups.set(key, { head: row, models: [row] })
  }
  return [...groups.values()]
}

/** One entry per credential the store's per-model rows name, each priced by its models, costliest first. */
export async function credentialSpend(pricing: UsagePricing, rows: readonly CredentialSpendRow[]): Promise<CredentialSpend[]> {
  const spends = await Promise.all(byCredential(rows).map(async ({ head, models }) => {
    const priced = await priceCentralBreakdown(pricing, models.map((row) => ({ ...row, value: row.model })))
    const kind = credentialKind(head.credential_kind)
    return {
      source: head.source,
      ...(head.credential_id ? { credentialId: head.credential_id } : {}),
      ...(kind ? { kind } : {}),
      ...(head.label ? { label: head.label } : {}),
      ...(head.credential_provider_id ? { providerId: head.credential_provider_id } : {}),
      ...spendTotals(models),
      estimatedUsd: priced.estimatedUsd,
      pricedTokens: priced.pricedTokens,
      unpricedTokens: priced.unpricedTokens,
    } satisfies CredentialSpend
  }))
  const tokens = (spend: CredentialSpend) => spend.input + spend.output + spend.reasoning + spend.cacheRead + spend.cacheWrite
  return spends.toSorted((a, b) => b.estimatedUsd - a.estimatedUsd || tokens(b) - tokens(a))
}
