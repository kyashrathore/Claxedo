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
