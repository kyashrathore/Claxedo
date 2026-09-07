import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import { fullUserCredential, type McpClientInputs, type McpToolGroup } from "@claxedo/mcp"
import { firstPartyMcpContribution, signedActorId, type FirstPartyMcpContributionInput } from "./first-party-mcp"

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

const tools: McpToolGroup = (registry) => {
  registry.tool("session_send", {
    description: "write",
    inputSchema: { session: z.string() },
    access: { audiences: ["runtime", "user"], write: true, scope: "act" },
    sessionIdOf: (args) => args.session,
  }, async (args) => ({ content: [{ type: "text", text: `sent:${args.session}` }] }))
}

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
    version: "1.2.3",
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
    expect(client.getServerVersion()).toEqual({ name: "claxedo", version: "1.2.3" })
    expect(inputs[0]).toMatchObject({
      deployment: "hosted",
      credential: { kind: "user", actorId: "actor_9", clientId: "cli", readOnly: false },
    })
    expect(inputs[0]?.local).toBeUndefined()
    expect(await (await inputs[0]!.controlPlane!.fetch("/api/echo")).json()).toEqual({ authorization: "Bearer jwt" })
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
