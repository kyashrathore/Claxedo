import { LOCAL_USER_ID } from "../platform/auth/local-identity"

/**
 * The person a stored personal row is spent for: the machine owner for a row
 * the unsigned loopback operator stored, since that operator is them, and the
 * row's own owner otherwise.
 */
export function accountHolderOf(rowOwner: string, machineOwnerUserId: string): string {
  return rowOwner === LOCAL_USER_ID ? machineOwnerUserId : rowOwner
}

/**
 * Whether a session whose accounts are `accountHolder`'s may use a stored
 * connection secret: the holder's own rows and the org's own (owner NULL) rows,
 * never another person's.
 */
export function credentialAdmitted(rowOwner: string | null | undefined, accountHolder: string, machineOwnerUserId: string): boolean {
  if (rowOwner === null || rowOwner === undefined) return true
  return accountHolderOf(rowOwner, machineOwnerUserId) === accountHolder
}

export const ACCOUNT_SOURCES = ["own", "team"] as const
export type AccountSource = (typeof ACCOUNT_SOURCES)[number]

/** One person's choice per provider id; a provider they never chose for is `own`. */
export type AccountSources = Readonly<Record<string, AccountSource>>

/** Every person's choices, keyed by the user id each was stored under. */
export type AccountSelections = Readonly<Record<string, AccountSources>>

export function isAccountSource(value: unknown): value is AccountSource {
  return value === "own" || value === "team"
}

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
 * provider they chose the team account for, and nothing else. Selection,
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

/** The owner of the row a person spends for a provider: the team's NULL for the team account, theirs otherwise. */
export function spentRowOwner(sources: AccountSources, providerId: string, person: string): string | null {
  return sources[providerId] === "team" ? null : person
}

/**
 * Each person's spent account per provider, from the rows a producer resolved.
 *
 * A person who chose the team account for a provider gets the team row, or
 * `missingTeam` when the org holds none, and never their own row for it; a
 * person who did not choose it never sees the team row.
 */
export function selectedAccounts<T>(input: {
  machineOwnerUserId: string
  rows: Iterable<{ owner: string | null; providerId: string; projection: T }>
  selections: AccountSelections
  missingTeam: (providerId: string) => T
}): Record<string, Record<string, T>> {
  const team = new Map<string, T>()
  const accounts: Record<string, Record<string, T>> = Object.create(null)
  const holders = new Map<string, AccountSources>()
  const sourcesOf = (holder: string) => {
    let sources = holders.get(holder)
    if (!sources) holders.set(holder, sources = holderAccountSources(input.selections, holder, input.machineOwnerUserId))
    return sources
  }
  for (const row of input.rows) {
    if (row.owner === null) {
      team.set(row.providerId, row.projection)
      continue
    }
    const holder = accountHolderOf(row.owner, input.machineOwnerUserId)
    if (sourcesOf(holder)[row.providerId] === "team") continue
    ;(accounts[holder] ??= Object.create(null))[row.providerId] = row.projection
  }
  for (const user of Object.keys(input.selections)) {
    const holder = accountHolderOf(user, input.machineOwnerUserId)
    for (const [providerId, source] of Object.entries(sourcesOf(holder))) {
      if (source !== "team") continue
      ;(accounts[holder] ??= Object.create(null))[providerId] = team.get(providerId) ?? input.missingTeam(providerId)
    }
  }
  return accounts
}

export const TEAM_ACCOUNT_UNAVAILABLE = "team_account_unavailable"
