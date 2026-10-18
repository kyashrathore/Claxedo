import type { AccountScope, AccountSource } from "@claxedo/account-contract/vocabulary"
import type { QuotaWindow } from "@claxedo/usage-contract"
import type { MachineClass } from "./cloud-types"

export type AccountDelivery = { readonly local: boolean; readonly cloud: boolean; readonly reason?: string; readonly cloudHarness?: boolean }

export type AccountSources = { readonly sources: ReadonlyMap<string, AccountSource>; readonly org: readonly Account[]; readonly canManageOrgAccounts: boolean }

export type KeyHint = { readonly prefix: string; readonly tail: string }

export type Account = {
  readonly id: string
  readonly providerId: string
  readonly kind: string
  readonly source: string
  readonly label?: string
  readonly accountId?: string
  readonly keyHint?: KeyHint
  readonly active: boolean
  readonly activatedAt?: number
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

export type AccountCheck = { readonly verdict: AccountVerdict; readonly usage?: readonly QuotaWindow[] } | { readonly uncheckable: true }

export type SandboxDriverField = { readonly key: string; readonly label: string; readonly secret: boolean }

export type SandboxDriverOption = { readonly id: string; readonly label: string; readonly fields: readonly SandboxDriverField[] }

export type SandboxKeys =
  | {
    readonly kind: "listed"
    readonly drivers: readonly SandboxDriverOption[]
    readonly keys: readonly Account[]
    readonly defaultDriver?: string
    readonly machineClasses: readonly MachineClass[]
    readonly canManage: boolean
  }
  | { readonly kind: "unsupported" }

export type AccountsApi = {
  readonly select: (ids: readonly string[]) => Promise<void>
  readonly selectMachineLogin: (providerIds: readonly string[]) => Promise<void>
  readonly setSource: (providerIds: readonly string[], source: AccountSource) => Promise<void>
  readonly setScope: (ids: readonly string[], scope: AccountScope) => Promise<void>
  readonly remove: (ids: readonly string[]) => Promise<void>
  readonly check: (id: string) => Promise<AccountCheck>
  readonly checkMachineLogin: (harness: string) => Promise<readonly MachineLogin[]>
  readonly rescan: () => Promise<void>
  readonly refresh: () => Promise<void>
  readonly saveSandboxKey: (driver: string, fields: Readonly<Record<string, string>>) => Promise<Account>
  readonly saveOrgAccount: (providerId: string, secret: string, label: string) => Promise<Account>
  readonly chooseSandboxDriver: (driver: string | null) => Promise<void>
  readonly checkSandboxKey: (id: string) => Promise<AccountCheck>
  readonly removeSandboxKey: (id: string) => Promise<void>
}
