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
    version: 4 as const,
    mcp: {},
    commands: [],
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
    auth: { machineOwnerUserId: "local", accounts: { local: {} } },
  }
}

describe("runtime config v4", () => {
  test("only management callers can read the live settings apply status", async () => {
    let status: import("../workspace/host").RuntimeConfigApplyStatus = { state: "idle", revision: 0 }
    const app = ConfigRoutes({ apply: async () => {}, configApply: () => status }, {
      managementAuth,
      managementTarget: { workspaceId: "ws-1", hostId: "host-1" },
    })
    expect((await app.request("/api/wr/config")).status).toBe(401)
    for (const state of ["idle", "applying", "failed", "applied"] as const) {
      status = { state, revision: 1 }
      const response = await app.request("/api/wr/config", { headers: { [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken } })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(status)
    }
  })

  test("accepts the strict trusted descriptor and explicit selection", async () => {
    let applied: unknown
    const app = ConfigRoutes({ apply: async (value) => { applied = value }, configApply: () => ({ state: "idle", revision: 0 }) }, {
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
    const app = ConfigRoutes({ apply: async (value) => { seen = value }, configApply: () => ({ state: "idle", revision: 0 }) }, {
      managementAuth,
      managementTarget: { workspaceId: "ws-1", hostId: "host-1" },
    })
    const headers = {
      "content-type": "application/json",
      [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
    }
    const body = {
      ...snapshot(),
      harnessLaunch: { acp: { generation: "generation-1", execution: { mode: "default" }, mcpServers: [], notApplied: [], pluginRoots: [{ pluginInstanceId: "pi_review", root: "/runtime/plugins/review", dataRoot: "/runtime/data/pi_review", skillNames: ["review"] }] } },
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

  test("rejects a snapshot that does not state its saved commands", () => {
    const { commands: _, ...withoutCommands } = snapshot()
    expect(normalizeRuntimeSnapshot(withoutCommands)).toBeUndefined()
    expect(normalizeRuntimeSnapshot(snapshot())?.commands).toEqual([])
  })

  test("rejects unknown runtime snapshot fields instead of silently ignoring them", () => {
    expect(normalizeRuntimeSnapshot({ ...snapshot(), unexpected: { value: true } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ ...snapshot(), runner: { type: "opencode" } })).toBeUndefined()
  })

  test("rejects every earlier snapshot version, v3 included", () => {
    expect(normalizeRuntimeSnapshot({ version: 1, mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } }, runner: { type: "opencode" } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ version: 2, mcp: {}, auth: { machineOwnerUserId: "local", accounts: { local: {} } }, runners: [] })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ ...snapshot(), version: 3 })).toBeUndefined()
  })

  test("accepts provider projections in auth and rejects secret material of any shape", () => {
    const projection = {
      baseUrl: "http://127.0.0.1:2595/bindings/ab12",
      placeholder: "signed-placeholder",
      authMode: "api-key",
      expiresAt: 1_800_000_000_000,
    }
    expect(normalizeRuntimeSnapshot({ ...snapshot(), auth: { machineOwnerUserId: "local", accounts: { local: { anthropic: projection } } } }))
      .toMatchObject({ auth: { machineOwnerUserId: "local", accounts: { local: { anthropic: projection } } } })
    // The v3 channel: a bare string where a projection belongs is the plaintext
    // push this version exists to remove, so it must not merely be dropped.
    expect(normalizeRuntimeSnapshot({ ...snapshot(), auth: { machineOwnerUserId: "local", accounts: { local: { anthropic: "sk-ant-api03-real" } } } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ ...snapshot(), auth: { machineOwnerUserId: "local", accounts: { local: { anthropic: { ...projection, authMode: "basic" } } } } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ ...snapshot(), auth: { machineOwnerUserId: "local", accounts: { local: { anthropic: { ...projection, secret: "leak" } } } } })).toBeUndefined()
    expect(normalizeRuntimeSnapshot({ ...snapshot(), auth: undefined })).toBeUndefined()
  })

  test("one unreadable row refuses the whole pushed snapshot", () => {
    const projection = {
      baseUrl: "http://127.0.0.1:2595/bindings/ab12",
      placeholder: "signed-placeholder",
      authMode: "api-key",
    }
    // A producer that sent a row this runtime cannot read has said nothing
    // trustworthy about the rest, so the snapshot already applied is a better
    // answer than half of this one.
    expect(normalizeRuntimeSnapshot({
      ...snapshot(),
      auth: { machineOwnerUserId: "local", accounts: { local: { anthropic: projection, openai: { ...projection, authMode: "basic" } } } },
    })).toBeUndefined()
  })

  test("a sandbox-issued placeholder is resolved from this runtime's own environment", () => {
    const projection = {
      baseUrl: "https://api.anthropic.com",
      placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
      authMode: "api-key",
      apiPath: "/v1",
    }
    expect(normalizeRuntimeSnapshot(
      { ...snapshot(), auth: { machineOwnerUserId: "local", accounts: { local: { "claude-sdk": projection } } } },
      { CLAXEDO_PROVIDER_CLAUDE_SDK: "secret_ref_abc" },
    )).toMatchObject({
      auth: { machineOwnerUserId: "local", accounts: { local: {
        "claude-sdk": {
          baseUrl: "https://api.anthropic.com",
          placeholder: "secret_ref_abc",
          authMode: "api-key",
          apiPath: "/v1",
        },
      } } },
    })
    // The sandbox provider never filled the variable: the account the operator
    // chose is unusable here, which is not the same as choosing none.
    expect(normalizeRuntimeSnapshot({ ...snapshot(), auth: { machineOwnerUserId: "local", accounts: { local: { "claude-sdk": projection } } } }, {}))
      .toMatchObject({
        auth: { machineOwnerUserId: "local", accounts: { local: { "claude-sdk": { unavailable: true, reason: "placeholder_env_missing: CLAXEDO_PROVIDER_CLAUDE_SDK" } } } },
      })
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

test("runtime snapshots accept definitions and credential references but reject credential material", () => {
  const definition = { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible" as const, baseURL: "https://acme.invalid/v1",
    headers: { "X-Title": "one" }, models: { one: { name: "One" } }, credentialProviderId: "acme", credentialSource: "account" as const }
  expect(normalizeRuntimeSnapshot({ ...snapshot(), providerDefinitions: [definition] })?.providerDefinitions).toEqual([definition])
  expect(normalizeRuntimeSnapshot({ ...snapshot(), providerDefinitions: [{ ...definition, apiKey: "secret" }] })).toBeUndefined()
  expect(normalizeRuntimeSnapshot({ ...snapshot(), providerDefinitions: [{ ...definition, headers: { Authorization: "secret" } }] })).toBeUndefined()
  for (const header of ["X-Auth-Token", "X-Goog-Api-Key", "X-Unspecified-Header"]) {
    expect(normalizeRuntimeSnapshot({ ...snapshot(), providerDefinitions: [{ ...definition, headers: { [header]: "secret" } }] })).toBeUndefined()
  }
  expect(normalizeRuntimeSnapshot({ ...snapshot(), providerDefinitions: [] })?.providerDefinitions).toEqual([])
})
