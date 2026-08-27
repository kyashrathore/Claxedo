import { describe, expect, test } from "vitest"
import { sqliteRepoKey } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { canonicalRepoKey } from "./workspaces"

describe("repository identity backend parity", () => {
  const cases = [
    ["https://GitHub.com/Acme/Widget.git", "github.com/Acme/Widget", "url"],
    ["git@github.com:Acme/Widget.git", "github.com/Acme/Widget", "url"],
    ["ssh://git@GitHub.com:22/Acme/Widget/", "github.com/Acme/Widget", "url"],
    ["/Users/Example/Repo/", "/users/example/repo", "directory"],
  ] as const

  test.each(cases)("normalizes %s identically", (value, expected, kind) => {
    expect(canonicalRepoKey({
      ...(kind === "url" ? { repoUrl: value } : { remoteDirectory: value }),
      workspaceId: "ws_1",
    })).toBe(expected)
    expect(sqliteRepoKey(value, "ws_1")).toBe(expected)
  })

  test("preserves case-sensitive repository paths", () => {
    expect(canonicalRepoKey({ repoUrl: "https://github.com/Acme/Widget", workspaceId: "ws_1" }))
      .not.toBe(canonicalRepoKey({ repoUrl: "https://github.com/acme/widget", workspaceId: "ws_1" }))
  })
})
