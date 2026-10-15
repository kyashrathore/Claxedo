/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { GitStatus } from "@/server"
import { pullRequestCompareUrl } from "./create-pr"

const remote = "https://github.com/acme/widgets.git"
const status = (fields: Partial<GitStatus>): GitStatus => ({ branch: "feature", ahead: 0, behind: 0, staged: [], unstaged: [], ...fields })

test("create pr: a branch that was never pushed offers no compare link, so GitHub is never asked for a branch it does not have", () => {
  expect(pullRequestCompareUrl({ remote, defaultRef: "origin/main", status: status({}) })).toBeUndefined()
})

test("create pr: a branch with commits not yet pushed offers no compare link until they are pushed", () => {
  expect(pullRequestCompareUrl({ remote, defaultRef: "origin/main", status: status({ upstream: "origin/feature", ahead: 2 }) })).toBeUndefined()
})

test("create pr: a pushed branch compares the remote branch it tracks against the workspace repository's default branch", () => {
  expect(pullRequestCompareUrl({ remote, defaultRef: "origin/main", status: status({ branch: "local-name", upstream: "origin/feature" }) })).toBe(
    "https://github.com/acme/widgets/compare/main...feature?expand=1",
  )
  expect(pullRequestCompareUrl({ remote: "git@github.com:acme/widgets.git", defaultRef: "origin/main", status: status({ upstream: "origin/feature" }) })).toBe(
    "https://github.com/acme/widgets/compare/main...feature?expand=1",
  )
})

test("create pr: a branch tracking another remote, the default branch itself, or a repository off GitHub offers no compare link", () => {
  expect(pullRequestCompareUrl({ remote, defaultRef: "origin/main", status: status({ upstream: "fork/feature" }) })).toBeUndefined()
  expect(pullRequestCompareUrl({ remote, defaultRef: "origin/main", status: status({ branch: "main", upstream: "origin/main" }) })).toBeUndefined()
  expect(pullRequestCompareUrl({ remote: "https://gitlab.com/acme/widgets.git", defaultRef: "origin/main", status: status({ upstream: "origin/feature" }) })).toBeUndefined()
})
