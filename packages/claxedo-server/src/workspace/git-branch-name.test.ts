import { execFileSync } from "node:child_process"
import { describe, expect, test } from "vitest"
import { isGitBranchName } from "./git-branch-name"

function gitAccepts(name: string) {
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } })
    return true
  } catch {
    return false
  }
}

describe("git branch names", () => {
  test.each([
    "main", "feature/payments-v2", "release-1.2", "user/a.b/c", "UPPER_case", "tag@v1", "a+b", "emoji-✓",
    "", "@", "HEAD", "-x", "/main", "main/", "main.", "feature..main", "a//b", "main@{1}", "a b", "tab\there", "x:y",
    "what?", "glob*", "set[0]", "back\\slash", "tilde~1", "caret^", ".hidden", "dir/.hidden", "topic.lock", "dir/topic.lock/x",
    "del\x7f", "nul\x01",
  ])("%j is accepted exactly when git accepts it", (name) => {
    expect(isGitBranchName(name)).toBe(gitAccepts(name))
  })
})
