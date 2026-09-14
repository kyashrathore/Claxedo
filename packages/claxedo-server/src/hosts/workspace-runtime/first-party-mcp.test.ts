import { describe, expect, test } from "vitest"
import { CLAXEDO_MCP_SERVER_INFO, CLAXEDO_MCP_TOOL_GROUP_IDS } from "@claxedo/mcp"
import { createRuntimeCredentialIssuer, createWorkspaceRuntimeApp } from "@claxedo/workspace-runtime"
import { relayWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime/exposure"
import type { OwnerGrantIdentity } from "@claxedo/workspace-runtime"
import type { TasksGrant } from "@claxedo/mcp"
import { firstPartyMcpRuntimeContribution } from "./first-party-mcp"

const relayAuth = { key: new Uint8Array([1]), workspaceId: "ws_1", hostId: "host_1" }

function runtime(options: {
  contribute?: boolean
  tasks?: () => TasksGrant | undefined
  groups?: readonly string[]
  ownerGrant?: () => string | undefined
  ownerGrantIdentity?: OwnerGrantIdentity
} = {}) {
  const issuer = createRuntimeCredentialIssuer({ runtimeId: "rt_1", workspaceId: "ws_1" })
  const enabledToolGroups = options.groups ?? CLAXEDO_MCP_TOOL_GROUP_IDS
  const app = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure(relayAuth),
    target: { workspaceId: "ws_1", directory: process.cwd() },
    firstPartyMcpLaunch: { baseUrl: "http://127.0.0.1:3002", issuer, enabledToolGroups: () => enabledToolGroups },
    ...(options.ownerGrantIdentity ? { ownerGrantIdentity: options.ownerGrantIdentity } : {}),
    routeContributions: options.contribute === false
      ? []
      : [firstPartyMcpRuntimeContribution({
          verifyRuntimeCredential: issuer.verify,
          enabledToolGroups,
          ...(options.tasks ? { tasks: options.tasks } : {}),
          ...(options.ownerGrant ? { ownerGrant: options.ownerGrant } : {}),
        })],
  })
  return { ...app, issuer }
}

async function callTool(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  credential: string,
  name: string,
) {
  const opened = await initialize(app, "http://127.0.0.1", { authorization: `Bearer ${credential}` })
  const session = opened.headers.get("mcp-session-id") ?? ""
  await opened.text()
  const called = await app.request("http://127.0.0.1/api/claxedo/mcp?session=ses_1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${credential}`,
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } }),
  })
  const body = await called.text()
  const line = body.split("\n").find((entry) => entry.startsWith("data:")) ?? body
  const result = (JSON.parse(line.replace(/^data:\s*/, "")) as { result: { isError?: boolean; content: { text?: string }[] } }).result
  return { isError: result.isError === true, text: result.content.map((part) => part.text ?? "").join("") }
}

function initialize(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, origin: string, headers: Record<string, string> = {}) {
  return app.request(`${origin}/api/claxedo/mcp?session=ses_1`, {
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

async function toolNames(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  credential: string,
) {
  const opened = await initialize(app, "http://127.0.0.1", { authorization: `Bearer ${credential}` })
  const session = opened.headers.get("mcp-session-id") ?? ""
  await opened.text()
  const listed = await app.request("http://127.0.0.1/api/claxedo/mcp?session=ses_1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${credential}`,
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  })
  const body = await listed.text()
  const line = body.split("\n").find((entry) => entry.startsWith("data:")) ?? body
  const result = JSON.parse(line.replace(/^data:\s*/, "")) as { result: { tools: { name: string }[] } }
  return result.result.tools.map((tool) => tool.name)
}

async function serverInfo(response: Response) {
  const body = await response.text()
  const line = body.split("\n").find((entry) => entry.startsWith("data:")) ?? body
  return (JSON.parse(line.replace(/^data:\s*/, "")) as { result: { serverInfo: unknown } }).result.serverInfo
}

describe("the cloud runtime's first-party MCP contribution", () => {
  test("is absent from a runtime the host contributes nothing to", async () => {
    const app = runtime({ contribute: false })
    try {
      const response = await initialize(app.app, "http://127.0.0.1", { authorization: `Bearer ${app.issuer.current("ses_1")}` })
      expect(response.status).toBe(404)
    } finally {
      await app.host.dispose()
    }
  })

  test("admits this runtime's own credential and reports the MCP package's version", async () => {
    const app = runtime()
    try {
      const response = await initialize(app.app, "http://127.0.0.1", { authorization: `Bearer ${app.issuer.current("ses_1")}` })
      expect(response.status).toBe(200)
      expect(response.headers.get("mcp-session-id")).toMatch(/\S/)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(await serverInfo(response)).toEqual(CLAXEDO_MCP_SERVER_INFO)
    } finally {
      await app.host.dispose()
    }
  })

  test("refuses a bearer this runtime did not mint, and any caller without one", async () => {
    const app = runtime()
    const foreign = createRuntimeCredentialIssuer({ runtimeId: "rt_1", workspaceId: "ws_1" })
    try {
      expect((await initialize(app.app, "http://127.0.0.1")).status).toBe(401)
      expect((await initialize(app.app, "http://127.0.0.1", { authorization: `Bearer ${foreign.current()}` })).status).toBe(401)
    } finally {
      await app.host.dispose()
    }
  })

  test("offers no Tasks tools to a root launched without a grant", async () => {
    const app = runtime()
    try {
      expect(await toolNames(app.app, app.issuer.current("ses_1"))).not.toContain("task_list")
    } finally {
      await app.host.dispose()
    }
  })

  test("offers exactly the Tasks tools the root's grant carries", async () => {
    const app = runtime({ tasks: () => ({ fetch: async () => new Response(null, { status: 503 }), operations: ["read", "create"] }) })
    try {
      const names = await toolNames(app.app, app.issuer.current("ses_1"))
      expect(names).toContain("task_list")
      expect(names).toContain("task_create")
      expect(names).not.toContain("task_start")
    } finally {
      await app.host.dispose()
    }
  })

  test("reads the grant per session, so a session opened after a renewal sees the renewed operations and one after a lapse sees none", async () => {
    let grant: TasksGrant | undefined = { fetch: async () => new Response(null, { status: 503 }), operations: ["read", "create"] }
    const app = runtime({ tasks: () => grant })
    try {
      expect(await toolNames(app.app, app.issuer.current("ses_1"))).not.toContain("task_start")
      grant = { ...grant, operations: ["read", "create", "start"] }
      expect(await toolNames(app.app, app.issuer.current("ses_1"))).toContain("task_start")
      grant = undefined
      expect(await toolNames(app.app, app.issuer.current("ses_1"))).not.toContain("task_list")
    } finally {
      await app.host.dispose()
    }
  })

  test("presents the owner grant on every in-process call, read at the call so a renewed or lapsed grant is what the runtime sees", async () => {
    const owner = {
      principal_kind: "user" as const,
      actor_id: "actor:owner",
      actor_kind: "human" as const,
      actor_public_id: "actor:owner",
      actor_name: "workspace owner",
      org_id: "org_1",
      workspace_id: "ws_1",
      role: "owner" as const,
    }
    let grant: string | undefined = "owner-grant"
    const app = runtime({ ownerGrant: () => grant, ownerGrantIdentity: async (token) => (token === "owner-grant" ? owner : undefined) })
    try {
      // With the owner stamped, the relay-exposed runtime's session policy
      // asks its authority; this test composes none, and that is the answer.
      const asOwner = await callTool(app.app, app.issuer.current("ses_1"), "subagent_list")
      expect(asOwner.isError).toBe(true)
      expect(asOwner.text).toContain("session_authority_unavailable")
      grant = undefined
      const lapsed = await callTool(app.app, app.issuer.current("ses_1"), "subagent_list")
      expect(lapsed.isError).toBe(true)
      expect(lapsed.text).toContain("session_actor_required")
      grant = "not-this-workspace's"
      expect((await callTool(app.app, app.issuer.current("ses_1"), "subagent_list")).text).toContain("session_actor_required")
    } finally {
      await app.host.dispose()
    }
  })

  test("a root launched without an owner grant stays actor-less on its own routes", async () => {
    const app = runtime()
    try {
      expect((await callTool(app.app, app.issuer.current("ses_1"), "subagent_list")).text).toContain("session_actor_required")
    } finally {
      await app.host.dispose()
    }
  })

  test("refuses a caller that reached it on anything but loopback", async () => {
    const app = runtime()
    try {
      const response = await initialize(app.app, "http://runtime.example.com", {
        authorization: `Bearer ${app.issuer.current("ses_1")}`,
      })
      expect(response.status).toBe(403)
    } finally {
      await app.host.dispose()
    }
  })
})
