import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  HOSTED_OPERATIONS,
  MissingOperationParameter,
  UnknownHostedOperation,
  hostedOperationChannel,
  resolveHostedOperation,
} from "./hosted-operations"

/**
 * The table is a security control, so it is tested like one.
 *
 * Two ways it stops working: it drifts from the reviewed matrix, or a
 * parameter turns out to be able to change the request rather than fill it in.
 * Round-tripping the happy path catches neither.
 */

const matrix = readFileSync(
  path.resolve(import.meta.dir, "../../../../../docs/tech-docs/desktop-hosted-operation-matrix.md"),
  "utf8",
)

/** `| \`name\` | owner | \`METHOD /path\` |` rows from the matrix. */
function matrixRows() {
  return [...matrix.matchAll(/^\| `([a-zA-Z][\w.]*)` \|[^|]*\| `(GET|POST|PUT|PATCH|DELETE) ([^`]+)` \|/gm)].map(
    (match) => ({ name: match[1]!, method: match[2]!, path: match[3]! }),
  )
}

describe("HOSTED_OPERATIONS", () => {
  test("every entry matches the matrix's method and path", () => {
    // Drift is the failure mode: the matrix is what a reviewer reads, and this
    // table is what actually runs. A mismatch means the review covered a
    // different system.
    const rows = new Map(matrixRows().map((row) => [row.name, row]))
    const mismatched = Object.entries(HOSTED_OPERATIONS).flatMap(([name, operation]) => {
      const row = rows.get(name)
      if (!row) return [`${name}: not declared in the matrix`]
      if (row.method !== operation.method) return [`${name}: matrix says ${row.method}, table says ${operation.method}`]
      if (row.path !== operation.path) return [`${name}: matrix says ${row.path}, table says ${operation.path}`]
      return []
    })

    expect(mismatched).toEqual([])
  })

  test("the matrix parse actually found rows", () => {
    // Positive control: a regex that matched nothing would make the assertion
    // above pass with no coverage at all.
    expect(matrixRows().length).toBeGreaterThan(20)
    expect(matrixRows().map((row) => row.name)).toContain("host.enrollCurrentMachine")
  })

  test("declares no generic proxy", () => {
    for (const name of Object.keys(HOSTED_OPERATIONS)) {
      expect(name).not.toMatch(/fetch|proxy|request$/i)
    }
    // And nothing whose path is caller-supplied.
    for (const operation of Object.values(HOSTED_OPERATIONS)) {
      expect(operation.path.startsWith("/")).toBe(true)
      expect(operation.path).not.toContain("://")
    }
  })

  test("declares no caller-selected query", () => {
    // A query may be part of a fixed path (`?access=cloud`), and the two
    // workspace-list rows are. It may never be SUBSTITUTED: `resolveHostedOperation`
    // fills a `:name` wherever it appears, query string included, so
    // `?access=:access` would compile, run, and quietly turn one reviewed
    // operation into a family of requests the renderer chooses between. That is
    // the closed set opening by one character, which is why it is asserted
    // rather than left to review.
    const substitutedQuery = Object.entries(HOSTED_OPERATIONS)
      .filter(([, operation]) => /:[A-Za-z]/.test(operation.path.split("?")[1] ?? ""))
      .map(([name]) => name)

    expect(substitutedQuery).toEqual([])
    // Positive control: the check must be able to see one.
    expect(/:[A-Za-z]/.test("/api/workspace?access=:access".split("?")[1] ?? "")).toBe(true)
  })

  test("lists workspaces per access kind, with the kind fixed in the path", () => {
    // The defect this pair replaced: `GET /api/workspace` with no `access`
    // answers `{ workspaces: [] }` unconditionally, so the single access-less
    // row could never return a workspace. Pinned here as well as in the matrix
    // because the value is load-bearing — `cloud` and `user-hosted` are the only
    // two the hosted handler acts on.
    expect(resolveHostedOperation("workspace.list.cloud")).toEqual({
      method: "GET",
      path: "/api/workspace?access=cloud",
    })
    expect(resolveHostedOperation("workspace.list.userHosted")).toEqual({
      method: "GET",
      path: "/api/workspace?access=user-hosted",
    })
    // And the kind cannot be talked out of the path by a caller.
    expect(resolveHostedOperation("workspace.list.cloud", { access: "user-hosted" }).path).toBe(
      "/api/workspace?access=cloud",
    )
  })
})

describe("resolveHostedOperation", () => {
  test("forwards the declared session-list sort without opening the query allowlist", () => {
    expect(resolveHostedOperation("session.navigationList", {
      scope: "workspace",
      limit: 25,
      sort: "created_desc",
      unreviewed: "must-not-reach-the-server",
    })).toEqual({
      method: "GET",
      path: "/api/control/session-list?scope=workspace&limit=25&sort=created_desc",
    })
  })

  test("appends only declared query keys from input", () => {
    expect(resolveHostedOperation("session.shares.list", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
    })).toEqual({
      method: "GET",
      path: "/api/control/sessions/ses_1/shares?workspaceId=ws_1",
    })
    expect(() => resolveHostedOperation("session.shares.list", { sessionId: "ses_1" })).toThrow(
      MissingOperationParameter,
    )
  })

  test("workspace.resolve omits empty optional query keys", () => {
    expect(resolveHostedOperation("workspace.resolve", { workspaceId: "ws_1" })).toEqual({
      method: "GET",
      path: "/api/workspace/resolve?workspaceId=ws_1",
    })
    expect(resolveHostedOperation("workspace.resolve", { directory: "/tmp/ws", create: true })).toEqual({
      method: "GET",
      path: "/api/workspace/resolve?directory=%2Ftmp%2Fws&create=true",
    })
    expect(resolveHostedOperation("workspace.resolve", {})).toEqual({
      method: "GET",
      path: "/api/workspace/resolve",
    })
  })

  test("encodes declared query values", () => {
    const resolved = resolveHostedOperation("session.shares.list", {
      sessionId: "ses_1",
      workspaceId: "ws a&b=c",
    })
    expect(resolved.path).toBe("/api/control/sessions/ses_1/shares?workspaceId=ws+a%26b%3Dc")
  })

  test("resolves DELETE session share revoke with body fields", () => {
    expect(resolveHostedOperation("session.shares.revoke", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
      grantId: "ssg_1",
    })).toEqual({
      method: "DELETE",
      path: "/api/control/sessions/ses_1/shares",
      body: { workspaceId: "ws_1", grantId: "ssg_1" },
    })
  })

  test("resolves org and team control-plane operations", () => {
    expect(resolveHostedOperation("org.list")).toEqual({
      method: "GET",
      path: "/api/control/orgs",
    })
    expect(resolveHostedOperation("org.create", { name: "Acme" })).toEqual({
      method: "POST",
      path: "/api/control/orgs",
      body: { name: "Acme" },
    })
    expect(resolveHostedOperation("org.teams.list", { orgId: "org_1" })).toEqual({
      method: "GET",
      path: "/api/control/orgs/org_1/teams",
    })
    expect(resolveHostedOperation("org.teams.create", { orgId: "org_1", name: "Eng" })).toEqual({
      method: "POST",
      path: "/api/control/orgs/org_1/teams",
      body: { name: "Eng" },
    })
    expect(resolveHostedOperation("org.ensureDefaultTeam", { orgId: "org_1" })).toEqual({
      method: "POST",
      path: "/api/control/orgs/org_1/ensure-default-team",
    })
    expect(resolveHostedOperation("team.members.list", { teamId: "team_1" })).toEqual({
      method: "GET",
      path: "/api/control/teams/team_1/members",
    })
    expect(resolveHostedOperation("team.members.add", {
      teamId: "team_1",
      tokenIdentifier: "tok_1",
      role: "member",
    })).toEqual({
      method: "POST",
      path: "/api/control/teams/team_1/members",
      body: { tokenIdentifier: "tok_1", role: "member" },
    })
    expect(resolveHostedOperation("team.members.remove", {
      teamId: "team_1",
      userPublicId: "usr_1",
    })).toEqual({
      method: "DELETE",
      path: "/api/control/teams/team_1/members",
      body: { userPublicId: "usr_1" },
    })
    expect(resolveHostedOperation("team.projects.grant", {
      teamId: "team_1",
      projectId: "proj_1",
      role: "editor",
    })).toEqual({
      method: "POST",
      path: "/api/control/teams/team_1/projects",
      body: { projectId: "proj_1", role: "editor" },
    })
    expect(() => resolveHostedOperation("org.teams.create", { name: "Eng" })).toThrow(
      MissingOperationParameter,
    )
  })

  test("fills path parameters from named input", () => {
    // `replace`, not `start`: the server's lifecycle operations are stop,
    // replace, cleanup and destroy, and every one but `stop` refuses without
    // the approval the body carries.
    expect(resolveHostedOperation("workspace.lifecycle", { id: "ws_1", operation: "replace", approved: true })).toEqual({
      method: "POST",
      path: "/api/workspace/ws_1/lifecycle/replace",
      body: { approved: true },
    })
  })

  test("refuses an operation nobody wrote down", () => {
    // There is no default branch. An operation not in the table cannot be
    // performed, which is the entire value of having a table.
    expect(() => resolveHostedOperation("hostedFetch", { url: "/admin" })).toThrow(UnknownHostedOperation)
  })

  test("a parameter cannot add a path segment", () => {
    // The traversal attempt. Encoded, so it becomes one literal component.
    const resolved = resolveHostedOperation("workspace.checkpoints.list", { id: "../../internal/sandbox-manager" })

    expect(resolved.path).toBe("/api/workspace/..%2F..%2Finternal%2Fsandbox-manager/checkpoints")
    expect(resolved.path.split("/").filter(Boolean)).toHaveLength(4)
  })

  test("a parameter cannot append a query string", () => {
    const resolved = resolveHostedOperation("workspace.checkpoints.list", { id: "ws_1?admin=true" })

    expect(resolved.path).not.toContain("?")
  })

  test("refuses a missing path parameter instead of building a broken url", () => {
    // Otherwise `:id` reaches the server as a literal, or the segment vanishes
    // and the request lands on a different route entirely.
    expect(() => resolveHostedOperation("workspace.lifecycle", { id: "ws_1" })).toThrow(MissingOperationParameter)
    expect(() => resolveHostedOperation("workspace.lifecycle", { id: "", operation: "start" })).toThrow(
      MissingOperationParameter,
    )
  })

  test("sends only the declared body fields", () => {
    // An undeclared field is one nobody reviewed. Dropping it is safer than
    // forwarding it, and safer than failing on a caller that passes extra
    // bookkeeping.
    const resolved = resolveHostedOperation("host.enrollCurrentMachine", {
      hostId: "host_1",
      publicKey: "{}",
      requestId: "req_1",
      signature: "sig",
      elevate: true,
    })

    expect(resolved.body).toEqual({ hostId: "host_1", publicKey: "{}", requestId: "req_1", signature: "sig" })
    expect(resolved.body).not.toHaveProperty("elevate")
  })

  test("nests connected-repo create into the hosted schema shape", () => {
    expect(resolveHostedOperation("workspace.create", {
      projectName: "demo",
      workspaceName: "main",
      connectionId: "conn_1",
      repoFullName: "acme/demo",
      driver: "daytona",
    })).toEqual({
      method: "POST",
      path: "/api/workspace/create",
      body: {
        projectName: "demo",
        workspaceName: "main",
        connectionId: "conn_1",
        repo: { fullName: "acme/demo" },
      },
    })
  })

  test("omits a body entirely for operations that take none", () => {
    expect(resolveHostedOperation("account.mode")).toEqual({ method: "GET", path: "/api/claxedo/mode" })
  })
})

describe("hostedOperationChannel", () => {
  test("gives each operation its own channel", () => {
    // One channel per operation, rather than one channel taking an operation
    // name: a single channel is a place for a future argument to become the
    // route.
    const channels = Object.keys(HOSTED_OPERATIONS).map((name) => hostedOperationChannel(name as never))

    expect(new Set(channels).size).toBe(channels.length)
    expect(hostedOperationChannel("account.mode")).toBe("claxedo.account.operation:account.mode")
  })
})
