import { describe, expect, test } from "bun:test"
import { ConfigRoutes, normalizeRuntimeSnapshot } from "./config"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth } from "../management-auth"

const managementToken = "allow-runtime-config"
const managementAuth: WorkspaceRuntimeManagementAuth = {
  authorize: async ({ request, action }) => request.headers.get(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER) === managementToken
    ? { ok: true, subject: "test", scopes: [action] }
    : { ok: false, status: 401, code: "runtime_management_token_required", message: "token required" },
}

function snapshot() {
  return {
    version: 3 as const,
    mcp: {},
    connections: [{
      connectionId: "acp-primary",
      providerKey: "acp",
      configRevision: 1,
      enabled: true,
      config: {
        label: "Primary ACP",
        connection: { kind: "process", command: "/bin/agent", args: ["--acp"] },
      },
      secretRefs: { token: "credentials/agent-token" },
    }],
    defaultHarness: { kind: "connection" as const, connectionId: "acp-primary" },
    auth: {},
  }
}

describe("runtime config v3", () => {
  test("accepts the strict trusted descriptor and explicit selection", async () => {
    let applied: unknown
    const app = ConfigRoutes(async (value) => { applied = value }, {
      managementAuth,
      managementTarget: { workspaceId: "ws-1", hostId: "host-1" },
    })
    const response = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
      },
      body: JSON.stringify(snapshot()),
    })
    expect(response.status).toBe(200)
    expect(applied).toEqual(snapshot())
  })

  test("preserves only known harness-owned opaque launch options", async () => {
    let seen: unknown
    const app = ConfigRoutes(async (value) => { seen = value }, {
      managementAuth,
      managementTarget: { workspaceId: "ws-1", hostId: "host-1" },
    })
    const headers = {
      "content-type": "application/json",
      [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
    }
    const body = {
      ...snapshot(),
      harnessLaunch: { claude: { pluginRoots: ["/runtime/plugins/review"] } },
    }
    const accepted = await app.request("http://localhost/api/wr/config", { method: "POST", headers, body: JSON.stringify(body) })
    expect(accepted.status).toBe(200)
    expect(seen).toMatchObject({ harnessLaunch: body.harnessLaunch })

    const rejected = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, harnessLaunch: { arbitrary: {} } }),
    })
    expect(rejected.status).toBe(400)
    expect(normalizeRuntimeSnapshot({ ...snapshot(), harnessLaunch: {} })).not.toHaveProperty("harnessLaunch")
  })

  test("rejects unknown runtime snapshot fields instead of silently ignoring them", () => {
    expect(normalizeRuntimeSnapshot({ ...snapshot(), unexpected: { value: true } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ ...snapshot(), runner: { type: "opencode" } })).toBeUndefined()
  })

  test("rejects v1/v2 compatibility snapshots", () => {
    expect(normalizeRuntimeSnapshot({ version: 1, mcp: {}, auth: {}, runner: { type: "opencode" } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ version: 2, mcp: {}, auth: {}, runners: [] })).toBeUndefined()
  })

  test("rejects duplicate identities and unknown descriptor fields", () => {
    const value = snapshot()
    expect(normalizeRuntimeSnapshot({ ...value, connections: [...value.connections, value.connections[0]] })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({
      ...value,
      connections: [{ ...value.connections[0], label: "duplicate projection" }],
    })).toBeUndefined()
  })

  test("requires a positive config revision and a real selected connection", () => {
    const value = snapshot()
    expect(normalizeRuntimeSnapshot({
      ...value,
      connections: [{ ...value.connections[0], configRevision: 0 }],
    })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({
      ...value,
      defaultHarness: { kind: "connection", connectionId: "missing" },
    })).toBeUndefined()
  })
})
