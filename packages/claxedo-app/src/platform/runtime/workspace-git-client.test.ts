import { describe, expect, test } from "bun:test"
import { workspaceRuntimeClientError } from "@claxedo/workspace-runtime/client"
import {
  createWorkspaceGitClient,
  isWorkspaceGitError,
  WorkspaceGitError,
  type GitWorktreeStatus,
  type WorkspaceGitRuntime,
} from "./workspace-git-client"

const status: GitWorktreeStatus = { branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [] }

function fakeRuntime(overrides: Partial<WorkspaceGitRuntime["git"]> = {}) {
  const calls: Array<[string, unknown]> = []
  const record = <T,>(name: string, result: T) => (input?: unknown) => {
    calls.push([name, input])
    return Promise.resolve(result)
  }
  const runtime: WorkspaceGitRuntime = {
    git: {
      status: record("status", status),
      stage: record("stage", undefined),
      unstage: record("unstage", undefined),
      commitStaged: record("commitStaged", { commit: "abc123" }),
      push: record("push", { remote: "origin", branch: "main" }),
      log: record("log", { commits: [] }),
      ...overrides,
    },
  }
  return { runtime, calls }
}

/** The runtime client's own producer, so the fixture cannot drift from it. */
function runtimeFailure(statusCode: number, body: string) {
  return async (): Promise<never> => {
    throw await workspaceRuntimeClientError("git", new Response(body, { status: statusCode }))
  }
}

describe("workspace git client", () => {
  test("drives the runtime's git namespace with the contract's request shapes", async () => {
    const { runtime, calls } = fakeRuntime()
    const client = createWorkspaceGitClient(runtime)

    expect(await client.status()).toEqual(status)
    await client.stage(["a.ts", "b.ts"])
    await client.unstage(["a.ts"])
    expect(await client.commitStaged({ message: "feat: x", amend: true })).toEqual({ commit: "abc123" })
    expect(await client.push({ setUpstream: true })).toEqual({ remote: "origin", branch: "main" })
    expect(await client.log({ limit: 5 })).toEqual({ commits: [] })
    await client.log()

    expect(calls).toEqual([
      ["status", undefined],
      ["stage", { paths: ["a.ts", "b.ts"] }],
      ["unstage", { paths: ["a.ts"] }],
      ["commitStaged", { message: "feat: x", amend: true }],
      ["push", { setUpstream: true }],
      ["log", { limit: 5 }],
      ["log", undefined],
    ])
  })

  test("a runtime error body becomes a WorkspaceGitError carrying its code, status, and git message", async () => {
    const { runtime } = fakeRuntime({
      push: runtimeFailure(502, JSON.stringify({
        error: { code: "git_push_rejected", message: "! [rejected] main -> main (fetch first)" },
      })),
      commitStaged: runtimeFailure(400, JSON.stringify({ error: { code: "git_nothing_staged", message: "nothing staged" } })),
      stage: runtimeFailure(403, JSON.stringify({ error: { code: "relay_role_denied", message: "viewers cannot write" } })),
    })
    const client = createWorkspaceGitClient(runtime)

    const push = await client.push({}).catch((error: unknown) => error)
    expect(push).toBeInstanceOf(WorkspaceGitError)
    expect(isWorkspaceGitError(push) && { code: push.code, status: push.status, message: push.message }).toEqual({
      code: "git_push_rejected",
      status: 502,
      message: "! [rejected] main -> main (fetch first)",
    })

    const commit = await client.commitStaged({ message: "x" }).catch((error: unknown) => error)
    expect(isWorkspaceGitError(commit) && commit.code).toBe("git_nothing_staged")

    const stage = await client.stage(["a.ts"]).catch((error: unknown) => error)
    expect(isWorkspaceGitError(stage) && [stage.code, stage.status]).toEqual(["relay_role_denied", 403])
  })

  test("a runtime failure without a JSON error body is reported as git_request_failed with the transport message", async () => {
    const { runtime } = fakeRuntime({ status: runtimeFailure(503, "<html>bad gateway</html>") })
    const client = createWorkspaceGitClient(runtime)

    const error = await client.status().catch((error: unknown) => error)
    expect(isWorkspaceGitError(error) && [error.code, error.status, error.message]).toEqual([
      "git_request_failed",
      503,
      "<html>bad gateway</html>",
    ])
  })

  test("a runtime failure with no body at all still carries the runtime's synthesized message", async () => {
    const { runtime } = fakeRuntime({ status: runtimeFailure(503, "") })
    const client = createWorkspaceGitClient(runtime)

    const error = await client.status().catch((error: unknown) => error)
    expect(isWorkspaceGitError(error) && [error.code, error.status, error.message]).toEqual([
      "git_request_failed",
      503,
      "Workspace runtime request failed with status 503",
    ])
  })

  test("errors that are not runtime responses pass through untouched", async () => {
    const network = new TypeError("fetch failed")
    const { runtime } = fakeRuntime({ log: () => Promise.reject(network) })
    const client = createWorkspaceGitClient(runtime)

    const error = await client.log().catch((error: unknown) => error)
    expect(error).toBe(network)
    expect(isWorkspaceGitError(error)).toBe(false)
  })
})
