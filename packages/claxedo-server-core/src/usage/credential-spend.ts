import type { CredentialMemberSpend, CredentialSpend } from "@claxedo/usage-contract"
import type { UsagePricing } from "./adapters/token-tracker-pricing"
import { priceCentralBreakdown } from "./central-pricing"
import type { CredentialSpendRow } from "./ledger"
import { rowNumber } from "./projection"

const CREDENTIAL_KINDS = ["api_key", "oauth_token", "subscription_session"] as const

/** A current member of the organization and the name its members list gives them. */
export type OrgMemberName = { userId: string; name: string | null }

type RowGroup = { head: CredentialSpendRow; rows: CredentialSpendRow[] }

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

async function pricedSpend(pricing: UsagePricing, rows: readonly CredentialSpendRow[]) {
  const priced = await priceCentralBreakdown(pricing, rows.map((row) => ({ ...row, value: row.model })))
  return { ...spendTotals(rows), estimatedUsd: priced.estimatedUsd, pricedTokens: priced.pricedTokens, unpricedTokens: priced.unpricedTokens }
}

function groupedBy(rows: readonly CredentialSpendRow[], key: (row: CredentialSpendRow) => string): RowGroup[] {
  const groups = new Map<string, RowGroup>()
  for (const row of rows) {
    const group = groups.get(key(row))
    if (group) group.rows.push(row)
    else groups.set(key(row), { head: row, rows: [row] })
  }
  return [...groups.values()]
}

function costliestFirst<Spend extends CredentialMemberSpend | CredentialSpend>(spends: readonly Spend[]) {
  const tokens = (spend: Spend) => spend.input + spend.output + spend.reasoning + spend.cacheRead + spend.cacheWrite
  return spends.toSorted((a, b) => b.estimatedUsd - a.estimatedUsd || tokens(b) - tokens(a))
}

async function memberSpend(pricing: UsagePricing, spent: readonly CredentialSpendRow[], names: ReadonlyMap<string, string | null>) {
  const spends = await Promise.all(groupedBy(spent, (row) => row.spender ?? "").map(async ({ head, rows }) => {
    const userId = head.spender ?? ""
    const name = names.get(userId)
    return {
      userId,
      ...(name ? { name } : {}),
      ...(names.has(userId) ? {} : { former: true as const }),
      ...(await pricedSpend(pricing, rows)),
    } satisfies CredentialMemberSpend
  }))
  return costliestFirst(spends)
}

/**
 * One entry per credential the store's per-model rows name, each priced by its models, costliest first. Rows that
 * name the member who spent them also split their credential's spend per member, named from `members`.
 */
export async function credentialSpend(
  pricing: UsagePricing,
  rows: readonly CredentialSpendRow[],
  members: readonly OrgMemberName[],
): Promise<CredentialSpend[]> {
  const names = new Map(members.map((member) => [member.userId, member.name]))
  const groups = groupedBy(rows, (row) => JSON.stringify([row.source, row.credential_id, row.credential_kind]))
  const spends = await Promise.all(groups.map(async ({ head, rows: models }) => {
    const kind = credentialKind(head.credential_kind)
    const spenders = models.filter((row) => row.spender !== null)
    return {
      source: head.source,
      ...(head.credential_id ? { credentialId: head.credential_id } : {}),
      ...(kind ? { kind } : {}),
      ...(head.label ? { label: head.label } : {}),
      ...(head.credential_provider_id ? { providerId: head.credential_provider_id } : {}),
      ...(await pricedSpend(pricing, models)),
      ...(spenders.length > 0 ? { members: await memberSpend(pricing, spenders, names) } : {}),
    } satisfies CredentialSpend
  }))
  return costliestFirst(spends)
}
