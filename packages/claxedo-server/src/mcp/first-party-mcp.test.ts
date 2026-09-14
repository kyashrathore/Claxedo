import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import { CLAXEDO_MCP_SERVER_INFO, CLAXEDO_MCP_TOOL_GROUPS, fullUserCredential, type McpClientInputs, type McpToolGroup } from "@claxedo/mcp"
import type { WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { firstPartyMcpContribution, signedActorId, type FirstPartyMcpContributionInput } from "./first-party-mcp"
import { resolveOAuthMcpCredential, type OAuthAccessTokenClaims } from "./oauth-credential"

const stubClient: ClaxedoMcpClient = {
  deployment: "hosted",
  runtime: async () => async () => new Response(null, { status: 204 }),
  resolveTarget: async () => ({ kind: "relay", baseUrl: "", headers: {} }),
  server: () => Promise.reject(new Error("unused")),
  workspaces: async () => [],
}

const signed = (subject: string, actorId?: string): SignedControlPlaneAuth => ({
  mode: "signed",
  token: "jwt",
  user: { subject, tokenIdentifier: `issuer|${subject}`, issuer: "https://issuer.test" },
  ...(actorId
    ? {
        principal: {
          userId: subject,
          actorId,
          actorKind: "human",
          deploymentId: "d",
          sessionId: "s",
          authenticatedAt: 0,
          methods: [],
          assurance: "single-factor",
          client: {
            id: "claxedo-cli",
            kind: "cli",
            tokenKind: "access-token",
            resource: "r",
            scopes: [],
            deploymentId: "d",
            adapter: "better-auth",
            issuer: "https://issuer.test",
            tokenEndpointOrigin: "https://issuer.test",
            controlPlaneOrigin: "https://core.test",
          },
          identity: { adapter: "better-auth", issuer: "https://issuer.test", subject },
        } as SignedControlPlaneAuth["principal"],
      }
    : {}),
})

const tools: McpToolGroup = { id: "fixture", reach: "runtime", register: (registry) => {
  registry.tool("session_send", {
    description: "write",
    inputSchema: { session: z.string() },
    access: { audiences: ["runtime", "user"], write: true, scope: "act" },
    sessionIdOf: (args) => args.session,
  }, async (args) => ({ content: [{ type: "text", text: `sent:${args.session}` }] }))
} }

function compose(overrides: Partial<FirstPartyMcpContributionInput> = {}) {
  const app = new Hono().get("/api/echo", (c) => c.json({ authorization: c.req.header("authorization") ?? null }))
  const inputs: McpClientInputs[] = []
  const auditAllow = vi.fn(async () => undefined)
  const auditFallback = vi.fn()
  const contribution = firstPartyMcpContribution({
    mount: "hosted",
    app,
    authority: { auditAllow },
    options: {
      createClient: (input) => {
        inputs.push(input)
        return stubClient
      },
      registerTools: [tools],
    },
    signedAuth: async (request) => (request.headers.get("authorization") === "Bearer jwt" ? signed("user_1", "actor_9") : undefined),
    auditFallback,
    ...overrides,
  })
  app.route(contribution.path, contribution.routes)
  return { app, inputs, auditAllow, auditFallback, contribution }
}

async function connect(app: Hono, headers: Record<string, string>) {
  const client = new Client({ name: "fixture", version: "0" })
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/api/claxedo/mcp"), {
    fetch: (url, init) => Promise.resolve(app.request(url.toString(), init)),
    requestInit: { headers },
  })
  await client.connect(transport)
  return client
}

describe("firstPartyMcpContribution", () => {
  test("names the contribution and its path", () => {
    const { contribution } = compose()
    expect(contribution).toMatchObject({ id: "claxedo-mcp", path: "/api/claxedo/mcp" })
  })

  test("acts as the signed principal, forwards its authorization to the control plane, and serves no runtime in-process", async () => {
    const { app, inputs } = compose()
    const client = await connect(app, { authorization: "Bearer jwt" })
    expect(client.getServerVersion()).toEqual(CLAXEDO_MCP_SERVER_INFO)
    expect(inputs[0]).toMatchObject({
      deployment: "hosted",
      credential: { kind: "user", actorId: "actor_9", clientId: "cli", readOnly: false },
    })
    expect(inputs[0]?.local).toBeUndefined()
    const controlPlane = inputs[0]?.controlPlane
    if (!controlPlane) throw new Error("the hosted mount composed no control-plane client")
    expect(await (await controlPlane.fetch("/api/echo")).json()).toEqual({ authorization: "Bearer jwt" })
  })

  test("falls back to the token subject when the adapter resolved no principal", () => {
    expect(signedActorId(signed("subject_only"))).toBe("subject_only")
    expect(signedActorId(signed("user_1", "actor_9"))).toBe("actor_9")
  })

  test("records every write on the authority as the signed caller", async () => {
    const { app, auditAllow, auditFallback } = compose()
    const client = await connect(app, { authorization: "Bearer jwt" })
    await client.callTool({ name: "session_send", arguments: { session: "ses_1" } })
    expect(auditFallback).not.toHaveBeenCalled()
    expect(auditAllow).toHaveBeenCalledTimes(1)
    expect(auditAllow.mock.calls[0]).toEqual([
      expect.objectContaining({ mode: "signed", user: expect.objectContaining({ subject: "user_1" }) }),
      { action: "mcp.session_send", metadata: { tool: "session_send", actor: "actor_9", client: "cli", sessionId: "ses_1" } },
    ])
  })

  test("serves only the tool groups the composition says this caller consented to", async () => {
    const other: McpToolGroup = { id: "other", reach: "runtime", register: (registry) => {
      registry.tool("other_ping", {
        description: "read",
        inputSchema: {},
        access: { audiences: ["runtime", "user"], write: false, scope: "read" },
      }, async () => ({ content: [{ type: "text", text: "pong" }] }))
    } }
    const consented = (groups: readonly string[]) =>
      compose({
        mount: "node",
        options: { createClient: () => stubClient, registerTools: [tools, other], enabledToolGroups: () => groups },
      })

    const one = await connect(consented(["fixture"]).app, { authorization: "Bearer jwt" })
    expect((await one.listTools()).tools.map((tool) => tool.name)).toEqual(["session_send"])
    expect(await one.callTool({ name: "other_ping", arguments: {} })).toMatchObject({ isError: true })
    expect(await one.callTool({ name: "session_send", arguments: { session: "ses_1" } })).toMatchObject({
      content: [{ type: "text", text: "sent:ses_1" }],
    })

    // With no group left there is no tools/call handler at all, so the
    // protocol itself refuses the call.
    const none = await connect(consented([]).app, { authorization: "Bearer jwt" })
    expect((await none.listTools()).tools).toEqual([])
    await expect(none.callTool({ name: "session_send", arguments: { session: "ses_1" } })).rejects.toThrow(/Method not found/)
  })

  test("challenges a caller with no credential and admits an anonymous one only where the mount allows it", async () => {
    const { app } = compose()
    const bare = await app.request("http://127.0.0.1/api/claxedo/mcp", { method: "POST", body: "{}" })
    expect(bare.status).toBe(401)
    expect(bare.headers.get("www-authenticate")).toContain('resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"')

    const { app: loopback, inputs, auditAllow, auditFallback } = compose({
      mount: "node",
      anonymousCredential: () => fullUserCredential({ actorId: "loopback", clientId: "loopback" }),
      local: () => ({ fetch: async () => new Response(null, { status: 204 }), workspace: {} }),
    })
    const client = await connect(loopback, {})
    expect(inputs[0]).toMatchObject({ deployment: "node", credential: { kind: "user", actorId: "loopback", clientId: "loopback" } })
    expect(inputs[0]?.local).toBeDefined()
    await client.callTool({ name: "session_send", arguments: { session: "ses_2" } })
    expect(auditAllow).not.toHaveBeenCalled()
    expect(auditFallback).toHaveBeenCalledWith({ tool: "session_send", actor: "loopback", client: "loopback", sessionId: "ses_2" })
  })
})

const CONTROL_PLANE_ORIGIN = "https://api.claxedo.test"

/** Enough of the runtime for the attention tools: an empty board, and a permission they can answer. */
function attentionRuntime() {
  const answered: Array<{ sessionID: string; permissionID: string; response: string }> = []
  const server = {
    permission: { list: async () => ({ data: [] }), respond: async (input: typeof answered[number]) => { answered.push(input) } },
    question: { list: async () => ({ data: [] }) },
    session: { status: async () => ({ data: {} }), list: async () => ({ data: [] }) },
  } as unknown as WorkspaceRuntimeClient
  return { answered, server }
}

function oauthComposed(tokens: Readonly<Record<string, readonly string[]>>) {
  const app = new Hono()
  const { answered, server } = attentionRuntime()
  const claims = (token: string): OAuthAccessTokenClaims | undefined =>
    tokens[token] ? { subject: "user_7", clientId: "mcp-host-1", scopes: tokens[token] } : undefined
  const contribution = firstPartyMcpContribution({
    mount: "hosted",
    app,
    authority: undefined,
    options: {
      createClient: () => ({
        deployment: "hosted",
        ownWorkspace: { workspaceId: "ws_1" },
        runtime: async () => async () => new Response(null, { status: 204 }),
        resolveTarget: async () => ({ kind: "relay", baseUrl: "", headers: {} }),
        server: async () => server,
        workspaces: async () => [],
      }),
      registerTools: CLAXEDO_MCP_TOOL_GROUPS,
    },
    signedAuth: async () => undefined,
    oauthCredential: (request) =>
      resolveOAuthMcpCredential(request, {
        verifyAccessToken: (token) => claims(token),
        controlPlaneOrigin: () => CONTROL_PLANE_ORIGIN,
      }),
    auditFallback: () => undefined,
  })
  app.route(contribution.path, contribution.routes)
  return { app, answered }
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort()

const writeTools = async (client: Client) =>
  (await client.listTools()).tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name)

describe("a consented OAuth access token", () => {
  test("with claxedo:read is listed the reads and refused every write", async () => {
    const { app, answered } = oauthComposed({ "read-only": ["claxedo:read"] })
    const client = await connect(app, { authorization: "Bearer read-only" })

    expect(await toolNames(client)).toContain("sessions_board")
    expect(await writeTools(client)).toEqual([])
    expect(await client.callTool({ name: "permission_reply", arguments: { session: "ses_1", permission: "p1", response: "once" } }))
      .toMatchObject({ isError: true })
    expect(answered).toEqual([])
  })

  test("with claxedo:approve answers a permission, and one without it never sees the tool", async () => {
    const { app, answered } = oauthComposed({
      approver: ["claxedo:read", "claxedo:approve"],
      actor: ["claxedo:read", "claxedo:act"],
    })

    const approver = await connect(app, { authorization: "Bearer approver" })
    expect(await toolNames(approver)).toContain("permission_reply")
    expect(await approver.callTool({ name: "permission_reply", arguments: { session: "ses_1", permission: "p1", response: "once" } }))
      .toMatchObject({ content: [{ type: "text", text: 'Answered permission p1 on session ses_1 with "once".' }] })
    expect(answered).toEqual([{ sessionID: "ses_1", permissionID: "p1", response: "once" }])

    const actor = await connect(app, { authorization: "Bearer actor" })
    expect(await toolNames(actor)).not.toContain("permission_reply")
  })

  test("is refused when the token is not one this deployment issued", async () => {
    const { app } = oauthComposed({ known: ["claxedo:read"] })
    const refused = await app.request("http://127.0.0.1/api/claxedo/mcp", {
      method: "POST",
      headers: { authorization: "Bearer forged" },
      body: "{}",
    })
    expect(refused.status).toBe(401)
  })
})
