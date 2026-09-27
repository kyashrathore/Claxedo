import { describe, expect, test } from "bun:test"
import { hostedOperationNames } from "@claxedo/account-contract"
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
 * Two ways it stops working: it grows an entry that reaches past the account
 * surface, or a parameter turns out to be able to change the request rather
 * than fill it in. Round-tripping the happy path catches neither.
 */

describe("HOSTED_OPERATIONS", () => {
  test("routes exactly the contract's operations", () => {
    expect(Object.keys(HOSTED_OPERATIONS).toSorted()).toEqual(hostedOperationNames().toSorted())
  })

  test("reaches no machine-signed, invitation or relay-fence route", () => {
    // Those routes authenticate a machine or an invitation secret, never an
    // account. An entry here would spend the account credential on them.
    const forbidden = ["/enrollments/redeem", "/enrollments/acquire", "/enrollments/heartbeat", "/host/invitations", "/internal/relay/"]
    const reached = Object.entries(HOSTED_OPERATIONS)
      .filter(([, operation]) => forbidden.some((fragment) => operation.path.includes(fragment)))
      .map(([name]) => name)

    expect(reached).toEqual([])
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
    // A query may be part of a fixed path (`?host=provisioner`), and the two
    // workspace-list rows are. It may never be SUBSTITUTED: `resolveHostedOperation`
    // fills a `:name` wherever it appears, query string included, so
    // `?host=:host` would compile, run, and quietly turn one reviewed
    // operation into a family of requests the renderer chooses between. That is
    // the closed set opening by one character, which is why it is asserted
    // rather than left to review.
    const substitutedQuery = Object.entries(HOSTED_OPERATIONS)
      .filter(([, operation]) => /:[A-Za-z]/.test(operation.path.split("?")[1] ?? ""))
      .map(([name]) => name)

    expect(substitutedQuery).toEqual([])
    // Positive control: the check must be able to see one.
    expect(/:[A-Za-z]/.test("/api/workspace?host=:host".split("?")[1] ?? "")).toBe(true)
  })

  test("lists workspaces per host, with the host fixed in the path", () => {
    // The defect this pair replaced: `GET /api/workspace` with no `host`
    // answers `{ workspaces: [] }` unconditionally, so the single host-less row
    // could never return a workspace. Pinned because the value is load-bearing:
    // `provisioner` and `machine` are the only two the hosted handler acts on.
    expect(resolveHostedOperation("workspace.list.provisioner")).toEqual({
      method: "GET",
      path: "/api/workspace?host=provisioner",
    })
    expect(resolveHostedOperation("workspace.list.machine")).toEqual({
      method: "GET",
      path: "/api/workspace?host=machine",
    })
    // And the host cannot be talked out of the path by a caller.
    expect(resolveHostedOperation("workspace.list.provisioner", { host: "machine" }).path).toBe(
      "/api/workspace?host=provisioner",
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

  test("a project's session page keeps its fixed scope and appends only the declared keys", () => {
    expect(resolveHostedOperation("session.page", {
      projectId: "prj_1",
      limit: 50,
      sort: "human_turn_desc",
      after: "key_1",
      scope: "global",
    })).toEqual({
      method: "GET",
      path: "/api/control/session-list?scope=project&projectId=prj_1&limit=50&sort=human_turn_desc&after=key_1",
    })
    expect(() => resolveHostedOperation("session.page", { limit: 50 })).toThrow(MissingOperationParameter)
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

  test("forwards a cloud session's first read with the reader's viewport, and only the declared keys", () => {
    expect(resolveHostedOperation("session.outline", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
      rows: 40,
      cols: 120,
      reasoning: "1",
      view: "must-not-reach-the-server",
    })).toEqual({
      method: "GET",
      path: "/api/control/sessions/ses_1/outline?workspaceId=ws_1&rows=40&cols=120&reasoning=1",
    })
    expect(resolveHostedOperation("session.outline", { sessionId: "ses_1", workspaceId: "ws_1" })).toEqual({
      method: "GET",
      path: "/api/control/sessions/ses_1/outline?workspaceId=ws_1",
    })
  })

  test("reads the account's cloud usage facts for a range, and has no hosted dashboard read to route to", () => {
    expect(resolveHostedOperation("usage.cloudFacts", { since: 1, until: 2, timezone: "UTC", view: "total" })).toEqual({
      method: "GET",
      path: "/api/claxedo/usage/cloud-facts?since=1&until=2",
    })
    expect(() => resolveHostedOperation("usage.cloudFacts", { since: 1 })).toThrow(MissingOperationParameter)
    expect(() => resolveHostedOperation("usage.get", { since: 1, until: 2 })).toThrow(UnknownHostedOperation)
  })

  test("workspace.resolve omits empty optional query keys", () => {
    expect(resolveHostedOperation("workspace.resolve", { workspaceId: "ws_1" })).toEqual({
      method: "GET",
      path: "/api/workspace/resolve?workspaceId=ws_1",
    })
    expect(resolveHostedOperation("workspace.resolve", { directory: "/tmp/ws" })).toEqual({
      method: "GET",
      path: "/api/workspace/resolve?directory=%2Ftmp%2Fws",
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

  test("carries the share level and both recipient spellings into the grant body", () => {
    expect(resolveHostedOperation("session.shares.grant", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
      level: "send",
      grantedToUserId: "user_bob",
    })).toEqual({
      method: "POST",
      path: "/api/control/sessions/ses_1/shares",
      body: { workspaceId: "ws_1", level: "send", grantedToUserId: "user_bob" },
    })
    expect(resolveHostedOperation("session.shares.grant", {
      sessionId: "ses_1",
      workspaceId: "ws_1",
      level: "follow",
      grantedToTokenIdentifier: "https://issuer.test|user_bob",
    })).toEqual({
      method: "POST",
      path: "/api/control/sessions/ses_1/shares",
      body: {
        workspaceId: "ws_1",
        level: "follow",
        grantedToTokenIdentifier: "https://issuer.test|user_bob",
      },
    })
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

  test("carries the selected source branch through cloud workspace creation", () => {
    expect(resolveHostedOperation("workspace.create", {
      projectId: "project-1",
      gitBranch: "release/next",
    })).toEqual({
      method: "POST",
      path: "/api/workspace/create",
      body: {
        projectId: "project-1",
        gitBranch: "release/next",
      },
    })
  })

  test("carries only the declared connected-repository source", () => {
    expect(resolveHostedOperation("workspace.create", {
      projectId: "project-1",
      connectionId: "connection-1",
      repoFullName: "kyashrathore/plugins",
      unreviewed: "must-not-cross-main",
    })).toEqual({
      method: "POST",
      path: "/api/workspace/create",
      body: {
        projectId: "project-1",
        connectionId: "connection-1",
        repo: { fullName: "kyashrathore/plugins" },
      },
    })
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

  test("refuses a non-scalar parameter instead of sending [object Object]", () => {
    // A path segment, a query value and a header are all built from the
    // parameter as text; `String(value)` on an object would send the literal
    // `[object Object]` as if the caller had meant it.
    expect(() =>
      resolveHostedOperation("workspace.lifecycle", { id: { evil: true }, operation: "start" }),
    ).toThrow(MissingOperationParameter)
    expect(() => resolveHostedOperation("session.list", { workspaceId: { evil: true } })).toThrow(
      MissingOperationParameter,
    )
    expect(resolveHostedOperation("workspace.lifecycle", { id: 7, operation: "start" }).path).toBe(
      "/api/workspace/7/lifecycle/start",
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
      projectId: "project-1",
      workspaceName: "main",
      connectionId: "conn_1",
      repoFullName: "acme/demo",
      driver: "daytona",
    })).toEqual({
      method: "POST",
      path: "/api/workspace/create",
      body: {
        projectId: "project-1",
        workspaceName: "main",
        connectionId: "conn_1",
        // `driver` is declared, so the signed desktop path forwards the create
        // dialog's provider choice instead of silently dropping it. The hosted
        // control plane composes one driver from env and ignores the field.
        driver: "daytona",
        repo: { fullName: "acme/demo" },
      },
    })
  })

  test("omits a body entirely for operations that take none", () => {
    expect(resolveHostedOperation("account.mode")).toEqual({ method: "GET", path: "/api/claxedo/mode" })
  })

  test("resolves the Agent Plugins skill document, plain and project-scoped", () => {
    expect(resolveHostedOperation("agentPlugins.skill", {
      pluginInstanceId: "claxedo/composio",
      skill: "search",
    })).toEqual({
      method: "GET",
      path: "/api/claxedo/plugins/claxedo%2Fcomposio/skills/search",
      response: "http",
    })
    expect(resolveHostedOperation("agentPlugins.skill.project", {
      projectId: "project_1",
      pluginInstanceId: "claxedo/composio",
      skill: "search",
    })).toEqual({
      method: "GET",
      path: "/api/claxedo/plugins/projects/project_1/claxedo%2Fcomposio/skills/search",
      response: "http",
    })
  })

  test("a plugin instance id or skill name cannot add a path segment to the skill route", () => {
    // Encoded, so an id carrying a slash becomes one literal component rather
    // than escaping into `/skills/:skill` or past it.
    const resolved = resolveHostedOperation("agentPlugins.skill", {
      pluginInstanceId: "../../admin",
      skill: "search",
    })
    expect(resolved.path).toBe("/api/claxedo/plugins/..%2F..%2Fadmin/skills/search")
    expect(resolved.path.split("/").filter(Boolean)).toHaveLength(6)
  })

  test("refuses a skill lookup missing either path parameter", () => {
    expect(() => resolveHostedOperation("agentPlugins.skill", { pluginInstanceId: "claxedo/composio" })).toThrow(
      MissingOperationParameter,
    )
    expect(() => resolveHostedOperation("agentPlugins.skill", { skill: "search" })).toThrow(
      MissingOperationParameter,
    )
    expect(() =>
      resolveHostedOperation("agentPlugins.skill.project", {
        pluginInstanceId: "claxedo/composio",
        skill: "search",
      })
    ).toThrow(MissingOperationParameter)
  })

  test("resolves Directory source listing and removal", () => {
    expect(resolveHostedOperation("agentPlugins.sources.list")).toEqual({
      method: "GET",
      path: "/api/claxedo/plugins/sources",
      response: "http",
    })
    expect(resolveHostedOperation("agentPlugins.sources.remove", { id: "src_1" })).toEqual({
      method: "DELETE",
      path: "/api/claxedo/plugins/sources/src_1",
      response: "http",
    })
  })

  test("a source id cannot add a path segment to the removal route", () => {
    const resolved = resolveHostedOperation("agentPlugins.sources.remove", { id: "../../admin" })
    expect(resolved.path).toBe("/api/claxedo/plugins/sources/..%2F..%2Fadmin")
    expect(resolved.path.split("/").filter(Boolean)).toHaveLength(5)
  })

  test("adds a Directory source with only the declared body fields", () => {
    const resolved = resolveHostedOperation("agentPlugins.sources.add", {
      owner: "acme",
      repository: "plugins",
      ref: "main",
      authority: "user",
      unreviewed: "must-not-reach-the-server",
    })
    expect(resolved).toEqual({
      method: "POST",
      path: "/api/claxedo/plugins/sources",
      body: { owner: "acme", repository: "plugins", ref: "main", authority: "user" },
      response: "http",
    })
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
