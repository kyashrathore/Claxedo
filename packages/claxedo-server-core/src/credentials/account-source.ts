import { and, eq, inArray } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db"
import type { AccountSelections, AccountSource, AccountSources } from "./account-holder"
import { ClaxedoProviderAccountSourceTable } from "./account-source.sql"
import { credentialOrg, type CredentialOrgScope } from "./registry"

export function accountSelections(org?: CredentialOrgScope): AccountSelections {
  const selections: Record<string, Record<string, AccountSource>> = Object.create(null)
  const rows = ClaxedoDB.use((db) => db.select().from(ClaxedoProviderAccountSourceTable)
    .where(eq(ClaxedoProviderAccountSourceTable.org_id, credentialOrg(org)))
    .all())
  for (const row of rows) (selections[row.user_id] ??= Object.create(null))[row.provider_id] = row.source
  return selections
}

export function setAccountSources(
  providerIds: readonly string[],
  source: AccountSource,
  org: CredentialOrgScope | undefined,
  person: string,
): AccountSources {
  const orgId = credentialOrg(org)
  const at = Date.now()
  ClaxedoDB.transaction((db) => {
    db.delete(ClaxedoProviderAccountSourceTable).where(and(
      eq(ClaxedoProviderAccountSourceTable.org_id, orgId),
      eq(ClaxedoProviderAccountSourceTable.user_id, person),
      inArray(ClaxedoProviderAccountSourceTable.provider_id, [...providerIds]),
    )).run()
    for (const providerId of new Set(providerIds)) {
      db.insert(ClaxedoProviderAccountSourceTable)
        .values({ org_id: orgId, user_id: person, provider_id: providerId, source, updated_at: at })
        .run()
    }
  })
  return accountSelections(orgId)[person] ?? {}
}
