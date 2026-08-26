export type AuthDisplayUser = {
  /** Stable account id. Present on a real user; absent mid-hydration. */
  id?: string | null
  fullName?: string | null
  username?: string | null
  imageUrl?: string | null
  primaryEmailAddress?: { emailAddress?: string | null } | null
  emailAddresses?: ReadonlyArray<{ emailAddress?: string | null }> | null
  externalAccounts?: ReadonlyArray<{ provider?: string | null }> | null
}

export function authDisplayEmail(user: AuthDisplayUser | null | undefined) {
  return (
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.find((entry) => entry.emailAddress)?.emailAddress ??
    undefined
  )
}
