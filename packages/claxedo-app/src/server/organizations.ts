import type { HostedAccount } from "./account"
import { contractMismatch, ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { OrgId } from "./ids"
import { queryKeys } from "./query-keys"
import type { OrgMember, OrgMembership } from "./access-types"
import type { FetchQuery } from "./types"
import { memberFromWire, membershipFromWire } from "./wire/organizations"

function parsed<T>(rows: readonly unknown[], parse: (row: unknown) => T | undefined, what: string): readonly T[] {
  return rows.map((row) => {
    const value = parse(row)
    if (value === undefined) throw contractMismatch(what)
    return value
  })
}

export function organizationQueries(serverUrl: string, account: HostedAccount | undefined) {
  const signed = () => {
    if (!account) throw new ServerError({ class: "auth", message: "Organizations belong to a signed-in account" })
    return account
  }
  const mine = (): FetchQuery<readonly OrgMembership[]> =>
    fetchQuery(queryKeys.organizations(serverUrl), async () => parsed(await signed().run("org.list"), membershipFromWire, "organization"))
  const members = (id: OrgId): FetchQuery<readonly OrgMember[]> =>
    fetchQuery(queryKeys.organizationMembers(serverUrl, id), async () => parsed(await signed().run("org.members.list", { orgId: id }), memberFromWire, "organization member"))
  return { signedIn: account !== undefined, mine, members }
}
