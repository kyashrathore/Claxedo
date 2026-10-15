import { expect, test } from "bun:test"
import type { CodeHostRepositoryAccess, CodeHostRepositoryListing } from "@/server"
import { shownRepositoryAccess } from "./repository-access"

const app: CodeHostRepositoryAccess = { kind: "app", installations: [
  { account: "kyashrathore", settingsUrl: "https://github.com/settings/installations/7", repositorySelection: "selected" },
] }

function listing(repositories: { fullName: string; private: boolean }[], access?: CodeHostRepositoryAccess): CodeHostRepositoryListing {
  return { repositories: repositories.map((repository, index) => ({ id: String(index), ...repository })), ...(access ? { access } : {}) }
}

test("a listing with no private repository names where the GitHub App is granted more", () => {
  expect(shownRepositoryAccess(listing([{ fullName: "kyashrathore/site", private: false }], app), 1)).toEqual(app)
})

test("a search that finds nothing names it too, even when private repositories are listed", () => {
  const read = listing([{ fullName: "kyashrathore/secret", private: true }], app)
  expect(shownRepositoryAccess(read, 1)).toBeUndefined()
  expect(shownRepositoryAccess(read, 0)).toEqual(app)
})

test("an app installed nowhere is still a reason to show the hint", () => {
  const nowhere: CodeHostRepositoryAccess = { kind: "app", installations: [] }
  expect(shownRepositoryAccess(listing([], nowhere), 0)).toEqual(nowhere)
})

test("a host that says nothing about access shows no hint", () => {
  expect(shownRepositoryAccess(listing([{ fullName: "a/b", private: false }]), 0)).toBeUndefined()
  expect(shownRepositoryAccess(undefined, 0)).toBeUndefined()
})
