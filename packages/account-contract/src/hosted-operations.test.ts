import { describe, expect, test } from "bun:test"
import { CORE_HOSTED_OPERATIONS, hostedOperationTable } from "./hosted-operations"
import { defineOperation, object, operationInput, operationPath, requiredParameter, UnknownHostedOperation, withStrings } from "./operation-definition"

const CORE = hostedOperationTable()

describe("decode", () => {
  test("requires the complete session People capability envelope", () => {
    const grant = { grant_id: "ssg_1", granted_to_user_id: "user_bob" }
    expect(CORE.decode("session.shares.list", { can_manage_shares: true, grants: [grant] }))
      .toEqual({ can_manage_shares: true, grants: [grant] })
    expect(() => CORE.decode("session.shares.list", { grants: [] })).toThrow(/can_manage_shares/)
    expect(() => CORE.decode("session.shares.list", { can_manage_shares: false })).toThrow(/grants/)
  })

  test("refuses a grant that names no person", () => {
    expect(() => CORE.decode("session.shares.list", {
      can_manage_shares: true,
      grants: [{ grant_id: "ssg_1", granted_to_team_id: "team_1" }],
    })).toThrow(/session\.shares\.list.*grants\[0\]\.granted_to_user_id/)
    expect(() => CORE.decode("session.shares.list", {
      can_manage_shares: true,
      grants: [{ grant_id: 1, granted_to_user_id: "user_bob" }],
    })).toThrow(/session\.shares\.list.*grants\[0\]\.grant_id/)
  })

  test("names the operation when a shape is wrong", () => {
    // "expected a non-empty relayUrl" from an unnamed decoder sends someone
    // reading the wrong route.
    expect(() => CORE.decode("workspace.connection.mint", {})).toThrow(
      /workspace\.connection\.mint.*relayUrl/,
    )
  })

  test("rejects an unknown operation rather than passing the value through", () => {
    expect(() => CORE.decode("hostedFetch" as never, { anything: true })).toThrow(/no hosted operation/)
  })

  test("rejects a list where an object is required, and the reverse", () => {
    expect(() => CORE.decode("account.mode", [])).toThrow(/expected an object/)
    expect(() => CORE.decode("workspace.list.provisioner", [])).toThrow(/expected an object/)
    expect(() => CORE.decode("workspace.list.provisioner", {})).toThrow(/expected an array "workspaces"/)
    expect(() => CORE.decode("workspace.list.machine", {})).toThrow(/expected an array "workspaces"/)
  })

  test("rejects an empty string in a required field, not just a missing one", () => {
    // The failure that reaches a component: a present-but-blank relay URL
    // produces a WebSocket connection to nowhere rather than an error here.
    expect(() => CORE.decode("workspace.connection.mint", { relayUrl: "" })).toThrow(/relayUrl/)
    expect(() => CORE.decode("workspace.connection.mint", { relayUrl: 42 })).toThrow(/relayUrl/)
  })

  test("returns the decoded value on a good shape", () => {
    expect(CORE.decode("workspace.connection.mint", { relayUrl: "wss://relay.test", token: "x" })).toEqual({
      relayUrl: "wss://relay.test",
      token: "x",
    })
    expect(CORE.decode("workspace.list.provisioner", { workspaces: [{ id: "ws_1" }] })).toEqual({
      workspaces: [{ id: "ws_1" }],
    })
    expect(CORE.decode("workspace.list.machine", { workspaces: [{ id: "ws_2" }] })).toEqual({
      workspaces: [{ id: "ws_2" }],
    })
  })

  test("admits a connection that is still provisioning", () => {
    // A cold start answers 200 with no relay URL and a retry hint. Requiring
    // the URL unconditionally would fail every cold start — the moment the user
    // is watching most closely.
    expect(CORE.decode("workspace.connection.mint", { status: "provisioning", retryAfterMs: 2_000 })).toEqual({
      status: "provisioning",
      retryAfterMs: 2_000,
    })
    // Still not a rubber stamp: a SETTLED connection with nowhere to connect to
    // is the case the requirement exists for.
    expect(() => CORE.decode("workspace.connection.mint", { status: "ready" })).toThrow(/relayUrl/)
  })

  test("reads through the envelope an operation is wrapped in", () => {
    // `{ enrollment }`, not a bare enrollment. Checking `host_id` on the
    // envelope finds nothing and reports a server that changed shape, which is
    // what this decoder did for as long as it existed.
    expect(() => CORE.decode("host.enrollCurrentMachine", { host_id: "host_1" })).toThrow(/enrollment/)
    expect(
      CORE.decode("host.enrollCurrentMachine", { enrollment: { enrollment_id: "enr_1", host_id: "host_1" } }),
    ).toEqual({ enrollment: { enrollment_id: "enr_1", host_id: "host_1" } })
  })

  test("rejects null, which is an object to typeof", () => {
    // The classic. `typeof null === "object"`, so a decoder written the obvious
    // way accepts it and the caller reads a field off nothing.
    expect(() => CORE.decode("account.mode", null)).toThrow(/expected an object/)
  })

  test("decodes the Agent Plugins skill and Directory sources rows as status results", () => {
    // Regression for the 2026-09-04 defect: these `response: "http"` operations
    // must be read through `statusResult`, never through a bare `object`
    // decoder that would accept a raw body and hide the HTTP status the caller
    // needs to tell a 422 diagnostic from a decoded document.
    for (const name of [
      "agentPlugins.skill",
      "agentPlugins.skill.project",
      "agentPlugins.sources.list",
      "agentPlugins.sources.add",
      "agentPlugins.sources.remove",
    ] as const) {
      expect(() => CORE.decode(name, { name: "search" })).toThrow(/expected a response status/)
      expect(CORE.decode(name, { status: 200, body: { ok: true } })).toEqual({
        status: 200,
        body: { ok: true },
      })
    }
  })

  test("accepts null only where a route answers it deliberately", () => {
    // The hosted control plane's `/api/workspace/resolve` returns `null` as its
    // "no central runtime snapshot" signal. Nullability is per-operation for
    // that reason: loosening `object` instead would have made every operation
    // null-tolerant to fix one that is.
    expect(CORE.decode("workspace.resolve", null)).toBe(null as never)
    expect(CORE.decode("workspace.resolve", { workspaceId: "ws_1" })).toEqual({ workspaceId: "ws_1" })
    expect(() => CORE.decode("workspace.resolve", [])).toThrow(/expected an object/)
  })

  test("a cloud draft's options are absent when the control plane leaves the runtime to answer", () => {
    expect(CORE.decode("agentConfig.harness.options", undefined)).toBeUndefined()
    expect(CORE.decode("agentConfig.harness.options", { options: [] })).toEqual({ options: [] })
    expect(() => CORE.decode("agentConfig.harness.options", null)).toThrow(/expected an object/)
  })
})

describe("the signed desktop's session sources", () => {
  test("a session page is an items envelope", () => {
    expect(CORE.decode("session.page", { items: [], nextCursor: "k" })).toEqual({ items: [], nextCursor: "k" })
    expect(() => CORE.decode("session.page", { groups: [] })).toThrow(/session\.page.*items/)
  })

  test("a session page is a read a renderer may retry", () => {
    expect(CORE.isSafe("session.page")).toBe(true)
  })

  test("a transcript's page of turns is a turns envelope a renderer may retry", () => {
    expect(CORE.decode("session.turnPage", { turns: [] })).toEqual({ turns: [] })
    expect(() => CORE.decode("session.turnPage", { items: [] })).toThrow(/session\.turnPage.*turns/)
    expect(CORE.isSafe("session.turnPage")).toBe(true)
  })

  test("a plugin request answers the plugin's status and body, and is never the renderer's to retry", () => {
    expect(CORE.decode("plugin.request", { status: 200, body: { value: 1 } })).toEqual({ status: 200, body: { value: 1 } })
    expect(CORE.decode("plugin.request", { status: 404, body: { error: { code: "plugin_route_not_declared" } } })).toMatchObject({ status: 404 })
    expect(() => CORE.decode("plugin.request", { value: 1 })).toThrow(/plugin\.request.*response status/)
    expect(CORE.isSafe("plugin.request")).toBe(false)
  })

  test("reads the organization member and project access answers the access routes give", () => {
    const member = { user_id: "usr_1", public_id: "usr_1", role: "admin", joined_at: 1 }
    expect(CORE.decode("org.members.update", member)).toEqual(member)
    expect(() => CORE.decode("org.invitations.accept", { user_id: "usr_1" })).toThrow(/org\.invitations\.accept.*role/)
    const access = { project_id: "prj_1", org_id: "org_1", entries: [{ kind: "user", user_id: "usr_1", role: "owner", source: "owner" }] }
    expect(CORE.decode("project.access", access)).toEqual(access)
    expect(() => CORE.decode("project.access", [])).toThrow(/project\.access/)
    expect(CORE.isSafe("project.access")).toBe(true)
    expect(CORE.isSafe("project.members.grant")).toBe(false)
  })

  test("a part read is an object a renderer may retry", () => {
    expect(CORE.decode("session.part", { part: { id: "a1-p0", type: "text", text: "whole" } })).toEqual({ part: { id: "a1-p0", type: "text", text: "whole" } })
    expect(() => CORE.decode("session.part", [])).toThrow(/expected an object/)
    expect(CORE.isSafe("session.part")).toBe(true)
  })
})

describe("isSafe", () => {
  test("each declaration owns its request, codecs and exposure", () => {
    for (const name of CORE.names()) {
      const operation = CORE_HOSTED_OPERATIONS[name] as unknown as Record<string, unknown>
      expect(typeof operation.method, name).not.toBe("undefined")
      expect(typeof operation.path, name).toBe("function")
      expect(typeof operation.input, name).toBe("function")
      expect(typeof operation.output, name).toBe("function")
      expect(["safe", "never"], name).toContain(String(operation.retry))
      expect(operation.exposure, name).toEqual(expect.objectContaining({ renderer: expect.any(Boolean), app: expect.any(Boolean) }))
    }
  })
  test("marks the operations that provision or destroy as unsafe", () => {
    for (const unsafe of [
      "workspace.create",
      "workspace.checkpoints.restore",
      "account.cliExchange",
      "host.enrollCurrentMachine",
      // Creating a Directory source: a repeated add is main's call, same as
      // every other creating mutation in this table.
      "agentPlugins.sources.add",
    ] as const) {
      expect(CORE.isSafe(unsafe), unsafe).toBe(false)
    }
  })

  test("marks plain reads as safe", () => {
    for (const safe of [
      "account.mode",
      "workspace.list.provisioner",
      "workspace.list.machine",
      "workspace.checkpoints.list",
      "agentPlugins.skill",
      "agentPlugins.skill.project",
      "agentPlugins.sources.list",
      // Idempotent delete: `remove` treats a 404 as already-removed, so a
      // retried call after a dropped response is still correct.
      "agentPlugins.sources.remove",
    ] as const) {
      expect(CORE.isSafe(safe), safe).toBe(true)
    }
  })

  test("every operation states one way or the other", () => {
    for (const name of CORE.names()) {
      expect(["safe", "never"], name).toContain(CORE_HOSTED_OPERATIONS[name].retry)
    }
  })
})

test("invitation results decode the receipt and declare retry policy", () => {
  expect(CORE.decode("org.invitations.create", { message: "invitation sent" })).toEqual({ message: "invitation sent" })
  expect(CORE.isSafe("org.invitations.create")).toBe(false)
  expect(CORE.isSafe("org.invitations.accept")).toBe(false)
  expect(CORE.isSafe("org.invitations.list")).toBe(true)
})

describe("hostedOperationTable", () => {
  const fixture = {
    "fixture.read": defineOperation({
      method: "GET", path: operationPath("/fixture/:id"),
      input: operationInput({ id: requiredParameter }),
      output: object, retry: "safe",
      exposure: { renderer: true, app: false },
    }),
    "fixture.export": defineOperation({
      method: "GET", path: operationPath("/fixture/:id/export"),
      input: operationInput({ id: requiredParameter }),
      output: withStrings("bytesBase64"), retry: "safe",
      exposure: { renderer: true, app: false },
      response: "bytes",
    }),
  }

  test("serves a plugin's operations after the core ones, and the core table never sees them", () => {
    const table = hostedOperationTable(fixture)
    expect(table.names()).toEqual([...CORE.names(), "fixture.read", "fixture.export"])
    expect(table.resolve("fixture.read", { id: "a/b" })).toEqual({ method: "GET", path: "/fixture/a%2Fb" })
    expect(table.resolve("fixture.export", { id: "a" })).toEqual({ method: "GET", path: "/fixture/a/export", response: "bytes" })
    expect(CORE.has("fixture.read")).toBe(false)
    expect(() => CORE.resolve("fixture.read", { id: "a" })).toThrow(UnknownHostedOperation)
  })

  test("refuses a name two tables declare, whichever declared it first", () => {
    expect(() => hostedOperationTable({ "account.mode": fixture["fixture.read"] })).toThrow('hosted operation "account.mode" is declared twice')
    expect(() => hostedOperationTable(fixture, { "fixture.read": fixture["fixture.read"] })).toThrow('hosted operation "fixture.read" is declared twice')
  })
})
