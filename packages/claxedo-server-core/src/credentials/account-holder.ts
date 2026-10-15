import type { AccountSource } from "@claxedo/account-contract/vocabulary"
import { LOCAL_USER_ID } from "../platform/auth/local-identity"
import { builtInProviderRow } from "./built-in-destinations"
import type { CredentialKind } from "./types"

/**
 * The person a stored personal row is spent for: the machine owner for a row
 * the unsigned loopback operator stored, since that operator is them, and the
 * row's own owner otherwise.
 */
export function accountHolderOf(rowOwner: string, machineOwnerUserId: string): string {
  return rowOwner === LOCAL_USER_ID ? machineOwnerUserId : rowOwner
}

/**
 * Whether a connection's secret reference may resolve to this stored row for
 * a session whose accounts are `holder`'s: a key the holder stored themselves,
 * and never an organization's row, another person's row, a sandbox provider
 * key or a model account. Those reach their consumers only through paths that
 * keep the value out of the sandbox (the sandbox manager, the plane's broker,
 * the provider edge), while a connection hands its secret to the sandbox.
 */
export function connectionSecretAdmitted(
  row: { owner?: string | null; kind: CredentialKind; provider_id: string },
  holder: string,
  machineOwnerUserId: string,
): boolean {
  if (row.owner === null || row.owner === undefined) return false
  if (row.kind === "sandbox_driver" || builtInProviderRow(row.provider_id)) return false
  return accountHolderOf(row.owner, machineOwnerUserId) === holder
}

/** One person's choice per provider id; a provider they never chose for is `own`. */
export type AccountSources = Readonly<Record<string, AccountSource>>

/** Every person's choices, keyed by the user id each was stored under. */
export type AccountSelections = Readonly<Record<string, AccountSources>>

/** One holder's choices, merged across the user ids that name them. */
export function holderAccountSources(selections: AccountSelections, holder: string, machineOwnerUserId: string): AccountSources {
  const sources: Record<string, AccountSource> = Object.create(null)
  for (const [user, chosen] of Object.entries(selections)) {
    if (accountHolderOf(user, machineOwnerUserId) === holder) Object.assign(sources, chosen)
  }
  return sources
}

/**
 * Whether `holder` spends a stored provider account: their own row for a
 * provider they spend their own account on, the org's (owner NULL) row for a
 * provider they chose the org account for, and nothing else. Selection,
 * delivery and every catalog answer through this, so no surface can show or
 * spend an account the person did not choose.
 */
export function spendsAccount(
  row: { owner?: string | null; provider_id: string },
  holder: string,
  sources: AccountSources,
  machineOwnerUserId: string,
): boolean {
  const spent = spentRowOwner(sources, row.provider_id, holder)
  if (row.owner === null || row.owner === undefined) return spent === null
  return spent !== null && accountHolderOf(row.owner, machineOwnerUserId) === holder
}

export function spentRowOwner(sources: AccountSources, providerId: string, person: string): string | null {
  return sources[providerId] === "org" ? null : person
}

/**
 * Each person's spent account per provider, from the rows a producer resolved.
 *
 * A person who chose the org account for a provider gets the org's row, or
 * `missingOrgAccount` when the org holds none, and never their own row for it;
 * a person who did not choose it never sees the org's row.
 */
export function selectedAccounts<T>(input: {
  machineOwnerUserId: string
  rows: Iterable<{ owner: string | null; providerId: string; projection: T }>
  selections: AccountSelections
  missingOrgAccount: (providerId: string) => T
}): Record<string, Record<string, T>> {
  const org = new Map<string, T>()
  const accounts: Record<string, Record<string, T>> = Object.create(null)
  const holders = new Map<string, AccountSources>()
  const sourcesOf = (holder: string) => {
    let sources = holders.get(holder)
    if (!sources) holders.set(holder, sources = holderAccountSources(input.selections, holder, input.machineOwnerUserId))
    return sources
  }
  for (const row of input.rows) {
    if (row.owner === null) {
      org.set(row.providerId, row.projection)
      continue
    }
    const holder = accountHolderOf(row.owner, input.machineOwnerUserId)
    if (sourcesOf(holder)[row.providerId] === "org") continue
    ;(accounts[holder] ??= Object.create(null))[row.providerId] = row.projection
  }
  for (const user of Object.keys(input.selections)) {
    const holder = accountHolderOf(user, input.machineOwnerUserId)
    for (const [providerId, source] of Object.entries(sourcesOf(holder))) {
      if (source !== "org") continue
      ;(accounts[holder] ??= Object.create(null))[providerId] = org.get(providerId) ?? input.missingOrgAccount(providerId)
    }
  }
  return accounts
}
