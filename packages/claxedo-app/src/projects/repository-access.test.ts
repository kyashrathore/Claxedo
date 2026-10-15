import { expect, test } from "bun:test"
import { codeHostRepositoryListingFromBody } from "@/server/wire/cloud"
import { shownRepositoryAccess } from "./repository-access"

const installations = [{ account: "kyashrathore", settingsUrl: "https://github.com/settings/installations/7", repositorySelection: "selected" }] as const

function listing(repositories: { fullName: string; private: boolean }[], access: unknown) {
  return codeHostRepositoryListingFromBody({
    repositories: repositories.map((repository, index) => ({ id: String(index), ...repository })),
    access,
  })
}

test("a listing with no private repository names where the GitHub App is granted more", () => {
  const read = listing([{ fullName: "kyashrathore/site", private: false }], { kind: "app", installations })
  expect(shownRepositoryAccess(read, 1)).toEqual({ kind: "app", installations })
})

test("a search that finds nothing names it too, even when private repositories are listed", () => {
  const read = listing([{ fullName: "kyashrathore/secret", private: true }], { kind: "app", installations })
  expect(shownRepositoryAccess(read, 1)).toBeUndefined()
  expect(shownRepositoryAccess(read, 0)).toEqual({ kind: "app", installations })
})

test("an app installed nowhere is still a reason to show the hint", () => {
  expect(shownRepositoryAccess(listing([], { kind: "app", installations: [] }), 0)).toEqual({ kind: "app", installations: [] })
})

test("a host that says nothing about access shows no hint", () => {
  expect(shownRepositoryAccess(listing([{ fullName: "a/b", private: false }], undefined), 0)).toBeUndefined()
})

test("only an https settings link is kept from the wire", () => {
  const read = listing([], { kind: "app", installations: [
    { account: "evil", settingsUrl: "javascript:alert(1)", repositorySelection: "all" },
    ...installations,
  ] })
  expect(read.access).toEqual({ kind: "app", installations })
  expect(listing([], { kind: "token", settingsUrl: "http://github.com/settings" }).access).toBeUndefined()
})
