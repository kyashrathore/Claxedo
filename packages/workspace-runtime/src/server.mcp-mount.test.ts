import { describe, expect, test } from "bun:test"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import type { McpClientInputs } from "@claxedo/mcp"
import { createWorkspaceRuntimeApp } from "./server"
import { loopbackWorkspaceRuntimeExposure, relayWorkspaceRuntimeExposure } from "./exposure"

const claims = { runtimeId: "rt_1", workspaceId: "ws_1", expiresAt: Number.MAX_SAFE_INTEGER }
const stubClient: ClaxedoMcpClient = {
  deployment: "loopback",
  runtime: async () => async () => new Response(null, { status: 204 }),
  resolveTarget: async () => ({ kind: "loopback", baseUrl: "", headers: {} }),
  server: () => Promise.reject(new Error("unused")),
  workspaces: async () => [],
}

function initialize(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, headers: Record<string, string> = {}) {
  return app.request("http://127.0.0.1/api/claxedo/mcp?session=ses_1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "0" } },
    }),
  })
}

describe("the runtime's first-party MCP mount", () => {
  test("is absent until the composition supplies the credential verifier", async () => {
    const runtime = createWorkspaceRuntimeApp({ exposure: loopbackWorkspaceRuntimeExposure() })
    try {
      expect((await initialize(runtime.app, { authorization: "Bearer rt" })).status).toBe(404)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("admits only the runtime credential and hands the client factory this runtime's own fetch", async () => {
    const inputs: McpClientInputs[] = []
    const runtime = createWorkspaceRuntimeApp({
      exposure: loopbackWorkspaceRuntimeExposure(),
      target: { workspaceId: "ws_1", directory: process.cwd() },
      firstPartyMcp: {
        verifyRuntimeCredential: (token) => (token === "rt" ? claims : undefined),
        createClient: (input) => {
          inputs.push(input)
          return stubClient
        },
      },
    })
    try {
      expect((await initialize(runtime.app)).status).toBe(401)
      expect((await initialize(runtime.app, { authorization: "Bearer other" })).status).toBe(401)
      const response = await initialize(runtime.app, { authorization: "Bearer rt" })
      expect(response.status).toBe(200)
      expect(response.headers.get("mcp-session-id")).toMatch(/\S/)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        deployment: "loopback",
        credential: { kind: "runtime", runtimeId: "rt_1", workspaceId: "ws_1", sessionId: "ses_1" },
        local: { workspace: { workspaceId: "ws_1", directory: process.cwd() } },
      })
      expect(inputs[0]?.controlPlane).toBeUndefined()
      const capabilities = await inputs[0]!.local!.fetch("/api/wr/capabilities")
      expect(capabilities.status).toBe(200)
    } finally {
      await runtime.host.dispose()
    }
  })

  test("under relay exposure the tools' in-process calls pass relay-host auth while outside callers do not", async () => {
    const inputs: McpClientInputs[] = []
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({ key: new Uint8Array([1]), workspaceId: "ws_1", hostId: "host_1" }),
      firstPartyMcp: {
        verifyRuntimeCredential: () => claims,
        createClient: (input) => {
          inputs.push(input)
          return stubClient
        },
      },
    })
    try {
      expect((await runtime.app.request("http://127.0.0.1/api/wr/capabilities")).status).toBe(401)
      expect((await initialize(runtime.app, { authorization: "Bearer rt" })).status).toBe(200)
      expect((await inputs[0]!.local!.fetch("/api/wr/capabilities")).status).toBe(200)
    } finally {
      await runtime.host.dispose()
    }
  })
})
