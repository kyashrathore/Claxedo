import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { WorkspaceDiffClient } from "@/platform/runtime/workspace-diff-client"
import { workspaceGitStatusKey } from "./workspace-git-status-query"
import { workspaceDiffSummaryKey, workspaceDiffSummaryQueryOptions } from "./workspace-diff-summary-query"

function fakeClient(rows: Array<{ file: string; additions: number; deletions: number; status?: string }>) {
  const calls: unknown[] = []
  const client: Pick<WorkspaceDiffClient, "vcs"> = {
    vcs: async (input) => {
      calls.push(input)
      return rows
    },
  }
  return { client, calls }
}

const scope = { baseUrl: "https://server.test", directoryPath: "/workspace", workspaceKey: "workspace-a" }
const target = { mode: "to-from", fromRef: "main", toRef: "HEAD" }

describe("workspace diff summary query identity", () => {
  test("is its own family beside git status, isolated by server, directory, and workspace", () => {
    expect(workspaceDiffSummaryKey(scope)).not.toEqual(workspaceGitStatusKey(scope))
    const keys = [
      workspaceDiffSummaryKey(scope),
      workspaceDiffSummaryKey({ ...scope, baseUrl: "https://other.test" }),
      workspaceDiffSummaryKey({ ...scope, directoryPath: "/other" }),
      workspaceDiffSummaryKey({ ...scope, workspaceKey: "workspace-b" }),
    ].map((key) => JSON.stringify(key))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("a read's key extends the scope's family with its mode and refs", () => {
    const { client } = fakeClient([])
    const family = workspaceDiffSummaryKey(scope)
    const branch = workspaceDiffSummaryQueryOptions({ client, scope, target }).queryKey
    const commit = workspaceDiffSummaryQueryOptions({ client, scope, target: { ...target, fromRef: "abc" } }).queryKey
    const staged = workspaceDiffSummaryQueryOptions({ client, scope, target: { mode: "staged" } }).queryKey
    expect(branch.slice(0, family.length)).toEqual([...family])
    expect(new Set([branch, commit, staged].map((key) => JSON.stringify(key))).size).toBe(3)
  })

  test("reads a summary through the diff client and maps rows into change entries", async () => {
    const { client, calls } = fakeClient([
      { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
      { file: "src/b.ts", additions: 2, deletions: 0, status: "A" },
      { file: "README.md", additions: 0, deletions: 4, status: "deleted" },
      { file: "lib/c.ts", additions: 0, deletions: 0, status: "R" },
      { file: "lib/d.ts", additions: 1, deletions: 1 },
    ])
    const queries = new QueryClient()
    const options = workspaceDiffSummaryQueryOptions({ client, scope, target })
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY)

    expect(await queries.fetchQuery(options)).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
      { path: "src/b.ts", status: "added", additions: 2, deletions: 0 },
      { path: "README.md", status: "deleted", additions: 0, deletions: 4 },
      { path: "lib/c.ts", status: "renamed", additions: 0, deletions: 0 },
      { path: "lib/d.ts", status: "modified", additions: 1, deletions: 1 },
    ])
    expect(calls).toEqual([{ directory: "/workspace", mode: "to-from", fromRef: "main", toRef: "HEAD", content: "summary" }])
  })
})
