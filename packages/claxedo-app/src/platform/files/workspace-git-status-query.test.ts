import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { GitCommitSummary, WorkspaceGitClient } from "@/platform/runtime/workspace-git-client"
import {
  workspaceGitLogKey,
  workspaceGitLogQueryOptions,
  workspaceGitStatusKey,
  workspaceGitStatusQueryOptions,
} from "./workspace-git-status-query"

const commit: GitCommitSummary = {
  hash: "0123456789abcdef",
  shortHash: "0123456",
  subject: "feat: x",
  author: "Dev",
  date: "2026-09-07T00:00:00Z",
  refs: ["HEAD -> main"],
  parents: [],
}

function fakeGit() {
  const calls: Array<[string, unknown]> = []
  const git: WorkspaceGitClient = {
    status: () => {
      calls.push(["status", undefined])
      return Promise.resolve({ branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [] })
    },
    stage: () => Promise.resolve(),
    unstage: () => Promise.resolve(),
    commitStaged: () => Promise.resolve({ commit: commit.hash }),
    push: () => Promise.resolve({ remote: "origin", branch: "main" }),
    log: (input) => {
      calls.push(["log", input])
      return Promise.resolve({ commits: [commit] })
    },
  }
  return { git, calls }
}

const scope = { baseUrl: "https://server.test", directoryPath: "/workspace", workspaceKey: "workspace-a" }

describe("workspace git query identity", () => {
  test("status and log are distinct entries for one scope", () => {
    expect(workspaceGitStatusKey(scope)).not.toEqual(workspaceGitLogKey(scope))
    const { git } = fakeGit()
    expect(workspaceGitStatusQueryOptions({ git, scope }).queryKey).toEqual(workspaceGitStatusKey(scope))
  })

  test("isolates scopes that differ in server, directory, or workspace", () => {
    const keys = [
      workspaceGitStatusKey(scope),
      workspaceGitStatusKey({ ...scope, baseUrl: "https://other.test" }),
      workspaceGitStatusKey({ ...scope, directoryPath: "/other" }),
      workspaceGitStatusKey({ ...scope, workspaceKey: "workspace-b" }),
    ].map((key) => JSON.stringify(key))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("a log read's key extends the scope's log family with its limit", () => {
    const { git } = fakeGit()
    const family = workspaceGitLogKey(scope)
    const ten = workspaceGitLogQueryOptions({ git, scope, limit: 10 }).queryKey
    const twenty = workspaceGitLogQueryOptions({ git, scope, limit: 20 }).queryKey
    expect(ten.slice(0, family.length)).toEqual([...family])
    expect(ten).not.toEqual(twenty)
  })

  test("reads go through the git client and stay fresh until an event says otherwise", async () => {
    const { git, calls } = fakeGit()
    const queries = new QueryClient()
    const status = workspaceGitStatusQueryOptions({ git, scope })
    const log = workspaceGitLogQueryOptions({ git, scope, limit: 10 })
    expect(status.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(log.staleTime).toBe(Number.POSITIVE_INFINITY)

    expect(await queries.fetchQuery(status)).toMatchObject({ branch: "main" })
    expect(await queries.fetchQuery(log)).toEqual([commit])
    expect(calls).toEqual([["status", undefined], ["log", { limit: 10 }]])
  })
})
