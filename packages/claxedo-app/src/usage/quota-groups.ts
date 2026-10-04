import { usedPercent, type QuotaAccount, type QuotaWindow } from "./model"

export type QuotaGroups = {
  readonly inUse: readonly QuotaAccount[]
  readonly signedIn: readonly QuotaAccount[]
  readonly notConnected: readonly QuotaAccount[]
}

export type WindowRisk = "normal" | "high" | "reached"

const HIGH_USE_PERCENT = 80

function reportsPlan(account: QuotaAccount): boolean {
  return !account.otherAgent || account.windows.length > 0
}

export function groupQuotaAccounts(accounts: readonly QuotaAccount[]): QuotaGroups {
  return {
    inUse: accounts.filter((account) => account.inUse),
    signedIn: accounts.filter((account) => !account.inUse && reportsPlan(account)),
    notConnected: accounts.filter((account) => !account.inUse && !reportsPlan(account)),
  }
}

export function windowRisk(window: QuotaWindow): WindowRisk {
  const used = usedPercent(window)
  if (used >= 100) return "reached"
  return used >= HIGH_USE_PERCENT ? "high" : "normal"
}
