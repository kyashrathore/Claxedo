import type { AccountScope, AccountSource } from "@claxedo/account-contract/vocabulary"
import type { QuotaWindow } from "@claxedo/usage-contract"

export type AccountDelivery = { readonly local: boolean; readonly cloud: boolean; readonly reason?: string }

export type AccountSources = { readonly sources: ReadonlyMap<string, AccountSource>; readonly org: readonly Account[] }

export type HostedAccountSources = { readonly sources: ReadonlyMap<string, AccountSource>; readonly org: ReadonlySet<string> }

export type Account = {
  readonly id: string
  readonly providerId: string
  readonly kind: string
  readonly source: string
  readonly label?: string
  readonly accountId?: string
  readonly active: boolean
  readonly status?: string
  readonly health?: string
  readonly hasSecret: boolean
  readonly expiresAt?: number
  readonly scope?: AccountScope
  readonly lastValidatedAt?: number
  readonly usage?: readonly QuotaWindow[]
  readonly usageAt?: number
  readonly delivery?: AccountDelivery
}

export type EffectiveAccounts =
  | { readonly kind: "listed"; readonly accounts: readonly Account[] }
  | { readonly kind: "unsupported" }

export type MachineLoginState = "signed_in" | "signed_out" | "absent" | "unknown"

export type MachineLogin = {
  readonly harness: string
  readonly providerIds: readonly string[]
  readonly serves?: readonly string[]
  readonly state: MachineLoginState
  readonly email?: string
  readonly plan?: string
  readonly org?: string
  readonly usage?: readonly QuotaWindow[]
  readonly usageAt?: number
  readonly detail?: string
}

export type AccountVerdict = "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired" | "unknown"

export type AccountCheck = { readonly verdict: AccountVerdict; readonly usage?: readonly QuotaWindow[] }

