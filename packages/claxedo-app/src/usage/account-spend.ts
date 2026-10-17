import { vendorName } from "@claxedo/agent-runtime-contract"
import type { AccountSpend, AccountSpendRequest, AccountSpendScope, MemberSpend } from "@/server"
import { inclusiveLocalRange, totalTokens, type UsageDays } from "./model"

export type SpendRowKind = "plan" | "apiKey" | "teamKey" | "otherMember" | "machine" | "unresolved" | "unreported"

export type SpendRow = {
  readonly id: string
  readonly kind: SpendRowKind
  readonly label?: string
  readonly vendor?: string
  readonly totals: AccountSpend["totals"]
  readonly cost: AccountSpend["cost"]
  readonly members?: readonly MemberSpend[]
}

export function spendScopes(managesTeamKeys: boolean): readonly AccountSpendScope[] {
  return managesTeamKeys ? ["mine", "org"] : ["mine"]
}

export function spendScope(chosen: AccountSpendScope, managesTeamKeys: boolean): AccountSpendScope {
  return spendScopes(managesTeamKeys).includes(chosen) ? chosen : "mine"
}

export function accountSpendRequest(days: UsageDays, scope: AccountSpendScope, now: number): AccountSpendRequest {
  return { ...inclusiveLocalRange(days, now), scope }
}

export function spendTokens(row: Pick<SpendRow, "totals">): number | undefined {
  const tokens = totalTokens(row.totals)
  const reportedNothing = row.totals.turnCount > 0 && (row.totals.unavailableTurnCount ?? 0) >= row.totals.turnCount
  return reportedNothing && tokens === 0 ? undefined : tokens
}

export function spendRow(spend: AccountSpend): SpendRow {
  const figures = { totals: spend.totals, cost: spend.cost }
  const payer = spend.payer
  switch (payer.kind) {
    case "own":
    case "team":
      return {
        id: payer.accountId,
        kind: payer.kind === "team" ? "teamKey" : payer.access,
        ...(payer.label ? { label: payer.label } : {}),
        ...(payer.providerId ? { vendor: vendorName(payer.providerId) } : {}),
        ...(payer.kind === "team" ? { members: payer.members } : {}),
        ...figures,
      }
    default:
      return { id: payer.kind, kind: payer.kind, ...figures }
  }
}
