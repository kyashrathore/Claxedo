import { describe, expect, test } from "bun:test"
import { ConfigRoutes } from "./config"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import { WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER, type WorkspaceRuntimeManagementAuth } from "../management-auth"

const workspaceId = "ws_1"
const hostId = "host_1"
const managementToken = "allow-runtime-config"

const managementAuth: WorkspaceRuntimeManagementAuth = {
  authorize: async (input) =>
    input.request.headers.get(WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER) === managementToken
      ? { ok: true, subject: "test", scopes: [input.action] }
      : {
          ok: false,
          status: 401,
          code: "runtime_management_token_required",
          message: "Workspace runtime management token is required",
        },
}

async function configHarness(apply: Parameters<typeof ConfigRoutes>[0]) {
  return {
    app: ConfigRoutes(apply, {
      managementAuth,
      managementTarget: {
        workspaceId,
        hostId,
      },
    }),
    headers: {
      "Content-Type": "application/json",
      [WORKSPACE_RUNTIME_MANAGEMENT_TOKEN_HEADER]: managementToken,
    },
  }
}

describe("runtime config route", () => {
  test("normalizes legacy runner snapshots before applying", async () => {
    let seen: unknown
    const { app, headers } = await configHarness(async (snapshot) => {
      seen = snapshot
    })

    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        mcp: {
          local: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            disabled: true,
          },
        },
        runner: {
          id: "openclaw",
          access: "acp",
          binary: "/tmp/openclaw-acp",
          model: "default",
        },
        auth: {},
        agent_extensions: {
          version: 1,
          installs: [{
            desired: {
              id: "review",
              source: { type: "project", package_path: "agent-extensions/review" },
              targets: ["codex"],
            },
            lock: { resolved_sha: "abcdef1234567890" },
            status: "applied",
            components: [],
          }],
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual({
      version: 1,
      mcp: {
        local: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          disabled: true,
        },
      },
      harness: {
        id: "openclaw",
        access: "acp",
        connection: {
          kind: "process",
          binary: "/tmp/openclaw-acp",
        },
      },
      model: "default",
      auth: {},
      agent_extensions: {
        version: 1,
        installs: [{
          desired: {
            id: "review",
            source: { type: "project", package_path: "agent-extensions/review" },
            targets: ["codex"],
          },
          lock: { resolved_sha: "abcdef1234567890" },
          status: "applied",
          components: [],
        }],
      },
    })
  })

  test("normalizes v2 runner snapshots before applying", async () => {
    let seen: unknown
    const { app, headers } = await configHarness(async (snapshot) => {
      seen = snapshot
    })

    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 2,
        mcp: {
          fs: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
          },
        },
        runners: [{
          type: "codex-app-server",
          binary: "/tmp/codex",
          model: "gpt-5",
        }, {
          id: "openclaw",
          access: "acp",
          binary: "/tmp/openclaw-acp",
        }],
        auth: {
          "codex-app-server": "codex-auth",
        },
        workspaceHarnessEnabled: true,
        commands: [{
          name: "explain",
          content: "Explain the current file",
        }],
      }),
    })

    expect(res.status).toBe(200)
    expect(seen).toEqual({
      version: 1,
      mcp: {
        fs: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
        },
      },
      harness: {
        id: "codex",
        access: "native",
        connection: {
          kind: "process",
          binary: "/tmp/codex",
        },
      },
      // v2 retains EVERY validated row so the runtime holds the full accepted
      // registry (operator ACP connections resolve from it); the first row
      // stays the active harness.
      harnesses: [{
        id: "codex",
        access: "native",
        connection: {
          kind: "process",
          binary: "/tmp/codex",
        },
      }, {
        id: "openclaw",
        access: "acp",
        connection: {
          kind: "process",
          binary: "/tmp/openclaw-acp",
        },
      }],
      auth: {
        "codex-app-server": "codex-auth",
      },
      workspaceHarnessEnabled: true,
      commands: [{
        name: "explain",
        content: "Explain the current file",
      }],
    })
  })

  test("accepts remote ACP streamable HTTP harness config", async () => {
    let seen: unknown
    const { app, headers } = await configHarness(async (snapshot) => {
      seen = snapshot
    })

    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        mcp: {},
        harness: {
          id: "openclaw",
          access: "acp",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
          headers: {
            Authorization: "Bearer test-token",
          },
        },
        auth: {},
      }),
    })

    expect(res.status).toBe(200)
    expect(seen).toMatchObject({
      harness: {
        id: "openclaw",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
          headers: {
            Authorization: "Bearer test-token",
          },
        },
      },
    })
  })

  test("normalizes ACP http transport spelling to streamable-http", async () => {
    let seen: unknown
    const { app, headers } = await configHarness(async (snapshot) => {
      seen = snapshot
    })

    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: 1,
        mcp: {},
        harness: {
          id: "openclaw",
          access: "acp",
          transport: "http",
          url: "http://127.0.0.1:7331/acp",
        },
        auth: {},
      }),
    })

    expect(res.status).toBe(200)
    expect(seen).toMatchObject({
      harness: {
        id: "openclaw",
        access: "acp",
        connection: {
          kind: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:7331/acp",
        },
      },
    })
  })

  test("requires management auth for config mutation", async () => {
    let applied = false
    const { app, headers } = await configHarness(async () => {
      applied = true
    })
    const body = JSON.stringify({
      version: 1,
      mcp: {},
      runner: {
        type: "opencode",
      },
      auth: {},
    })

    const missing = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
    const accepted = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers,
      body,
    })

    expect(missing.status).toBe(401)
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "runtime_management_token_required",
        message: "Workspace runtime management token is required",
      },
    })
    expect(accepted.status).toBe(200)
    expect(applied).toBe(true)
  })

  test("returns structured errors for invalid and failed runtime snapshots", async () => {
    let applied = false
    const invalidHarness = await configHarness(async () => {})
    const invalid = await invalidHarness.app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: invalidHarness.headers,
      body: JSON.stringify({ version: 1, runner: { type: "opencode" } }),
    })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toEqual({
      error: {
        code: "invalid_runtime_snapshot",
        message: "Invalid runtime snapshot",
      },
    })

    const unknownHarness = await configHarness(async () => {
      applied = true
    })
    const unknownRunner = await unknownHarness.app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: unknownHarness.headers,
      body: JSON.stringify({
        version: 1,
        mcp: {},
        runner: { type: "mystery-runner" },
        auth: {},
      }),
    })
    expect(unknownRunner.status).toBe(400)
    await expect(unknownRunner.json()).resolves.toEqual({
      error: {
        code: "invalid_runtime_snapshot",
        message: "Invalid runtime snapshot",
      },
    })
    expect(applied).toBe(false)

    const noRunnerHarness = await configHarness(async () => {
      applied = true
    })
    const noRunner = await noRunnerHarness.app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: noRunnerHarness.headers,
      body: JSON.stringify({
        version: 2,
        mcp: {},
        runners: [],
        auth: {},
      }),
    })
    expect(noRunner.status).toBe(400)
    await expect(noRunner.json()).resolves.toEqual({
      error: {
        code: "invalid_runtime_snapshot",
        message: "Invalid runtime snapshot",
      },
    })
    expect(applied).toBe(false)

    const failedHarness = await configHarness(async () => {
      throw new Error("materialization failed")
    })
    const failed = await failedHarness.app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: failedHarness.headers,
      body: JSON.stringify({
        version: 1,
        mcp: {},
        runner: { type: "opencode" },
        auth: {},
      }),
    })
    expect(failed.status).toBe(500)
    await expect(failed.json()).resolves.toEqual({
      error: {
        code: "runtime_snapshot_apply_failed",
        message: "Runtime config apply failed",
      },
    })
  })

  test("rejects malformed and unsupported agent extension snapshots with stable codes", async () => {
    let applied = false
    const malformedHarness = await configHarness(async () => {
      applied = true
    })
    const malformed = await malformedHarness.app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: malformedHarness.headers,
      body: JSON.stringify({
        version: 1,
        mcp: {},
        runner: { type: "opencode" },
        auth: {},
        agent_extensions: {
          version: 1,
          installs: [{ desired: "not-an-object" }],
        },
      }),
    })

    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toEqual({
      error: {
        code: "runtime_config_agent_extensions_malformed",
        message: "Invalid runtime agent extension snapshot",
      },
    })
    expect(applied).toBe(false)

    const unsupportedHarness = await configHarness(async () => {
      applied = true
    })
    const unsupported = await unsupportedHarness.app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: unsupportedHarness.headers,
      body: JSON.stringify({
        version: 1,
        mcp: {},
        runner: { type: "opencode" },
        auth: {},
        agent_extensions: {
          version: 1,
          installs: [{
            desired: {
              id: "registry-ext",
              source: { type: "registry", name: "@acme/review" },
              enabled: true,
            },
            components: [],
          }],
        },
      }),
    })

    expect(unsupported.status).toBe(400)
    await expect(unsupported.json()).resolves.toEqual({
      error: {
        code: "runtime_config_agent_extensions_unsupported_source",
        message: "Unsupported runtime agent extension source",
      },
    })
    expect(applied).toBe(false)
  })

  test("rejects oversized runtime config bodies before applying", async () => {
    let applied = false
    const { app, headers } = await configHarness(async () => {
      applied = true
    })
    const res = await app.request("http://localhost/api/wr/config", {
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1),
      },
      body: JSON.stringify({
        version: 1,
        mcp: {},
        runner: { type: "opencode" },
        auth: {},
      }),
    })

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual(errorBody("request_body_too_large", "Request body is too large"))
    expect(applied).toBe(false)
  })
})
