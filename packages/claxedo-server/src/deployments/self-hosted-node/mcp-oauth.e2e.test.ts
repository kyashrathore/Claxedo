import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import type { ClaxedoMcpClient } from "@claxedo/mcp/client"
import { CLAXEDO_MCP_TOOL_GROUPS } from "@claxedo/mcp"
import type { WorkspaceRuntimeClient } from "@claxedo/workspace-runtime/client"
import { createSelfHostedApp } from "./app"
import { EMBEDDED_AUTH_ISSUER, getEmbeddedAuth, resetEmbeddedAuthForTests } from "./embedded-auth"
import { betterAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import { createControlPlaneServices } from "../../authority/services"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { testManagedSessionAuthority } from "../../test-support/managed-session-authority"
import { CLAXEDO_MCP_OAUTH_SCOPES } from "../../platform/auth/mcp-oauth-scopes"

/**
 * An MCP host obtaining a token the way one really does, against the box's own
 * Better Auth: discovery, RFC 7591 registration with a loopback redirect,
 * an authorization request with PKCE, the user's consent, the code exchange,
 * and then that token spent at `/api/claxedo/mcp`.
 *
 * `embedded-auth.test.ts` covers the provider's own answers up to registration
 * and `mcp/oauth-credential.test.ts` covers the mapping from claims to scopes,
 * each against a fixture of the other half. Nothing joined them, so nothing
 * could tell whether a token this box actually issues is one its own endpoint
 * admits, nor whether the scopes the user ticked on the consent page are the
 * scopes the tools gate on.
 *
 * What is real: the whole self-hosted app, its embedded Better Auth on a
 * temporary SQLite file, its introspection client, the MCP mount, the tool
 * registry, and an MCP client over streamable HTTP. What is faked: the
 * workspace runtime behind the tools — the endpoint reaches it in-process on a
 * real box and no runtime is booted here, so `permission.respond` records what
 * the approval tool sent it.
 */

const ORIGIN = "http://localhost:2593"

let dataDir: string
let savedDataDir: string | undefined
let savedEmbedded: string | undefined
let app: Hono
let answered: Array<{ sessionID: string; permissionID: string; response: string }>

/** Enough runtime for the approval tools: an empty board and a permission they can answer. */
function runtimeClient(): ClaxedoMcpClient {
  const server = {
    permission: { list: async () => ({ data: [] }), respond: async (input: typeof answered[number]) => { answered.push(input) } },
    question: { list: async () => ({ data: [] }) },
    session: { status: async () => ({ data: {} }), list: async () => ({ data: [] }), summaries: async () => ({ data: [] }) },
  } as unknown as WorkspaceRuntimeClient
  return {
    deployment: "node",
    ownWorkspace: { workspaceId: "ws_box" },
    runtime: async () => async () => new Response(null, { status: 204 }),
    resolveTarget: async () => ({ kind: "node", workspaceId: "ws_box", baseUrl: "", headers: {} }),
    server: async () => server,
    workspaces: async () => [{ id: "ws_box", host: "machine" }],
  }
}

beforeAll(async () => {
  savedDataDir = process.env.CLAXEDO_DATA_DIR
  savedEmbedded = process.env.CLAXEDO_EMBEDDED_AUTH
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-mcp-oauth-"))
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_EMBEDDED_AUTH = "1"
  answered = []
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  app = createSelfHostedApp(
    createControlPlaneServices(
      { projectionStore: centralStore.projectionStore, durableSessionLog: centralStore.durableSessionLog },
      {
        authority: testManagedSessionAuthority(),
        localExecution: { enabled: true },
        telemetry: { capture: () => {} },
        // The same adapter `createSelfHostedApp` composes for an embedded-auth
        // box: without it the mount admits a loopback caller as the whole
        // account and no token is ever asked for.
        auth: betterAuthAdapter({ issuer: EMBEDDED_AUTH_ISSUER, verifier: getEmbeddedAuth().verifier }),
      },
    ),
    { firstPartyMcp: { createClient: () => runtimeClient(), registerTools: CLAXEDO_MCP_TOOL_GROUPS } },
  ).app
}, 60_000)

afterAll(async () => {
  resetEmbeddedAuthForTests()
  const { ClaxedoDB } = await import("@claxedo/server-core/platform/db/index")
  ClaxedoDB.close()
  const { closeAuthorityDatabases } = await import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store")
  closeAuthorityDatabases()
  if (savedDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = savedDataDir
  if (savedEmbedded === undefined) delete process.env.CLAXEDO_EMBEDDED_AUTH
  else process.env.CLAXEDO_EMBEDDED_AUTH = savedEmbedded
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const request = (pathname: string, init?: RequestInit) => app.request(new URL(pathname, ORIGIN).toString(), init)

const MCP_RESOURCE = `${ORIGIN}/api/claxedo/mcp`

/** Where `oauthProvider({ consentPage })` sends a signed-in user who has not consented yet. */
const CONSENT_PATH = "/oauth/consent"

/** One `initialize`, the first thing any MCP host sends. */
const initialize = (headers: Record<string, string> = {}) =>
  request("/api/claxedo/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-mcp-host", version: "0" } },
    }),
  })

const form = (body: Record<string, string>) =>
  ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() })

const json = (body: unknown) =>
  ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function signUp(email: string) {
  const response = await request("/api/auth/sign-up/email", json({ email, password: "correct-horse-battery", name: "Box Owner" }))
  expect(response.status).toBe(200)
  const token = response.headers.get("set-auth-token")
  if (!token) throw new Error("the embedded issuer minted no session token")
  return token
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

/** Everything an MCP host does before its first tool call, ending at an access token. */
async function consentedToken(input: { sessionToken: string; scopes: readonly string[]; clientId?: string }) {
  const redirect = "http://127.0.0.1:51789/callback"
  let clientId = input.clientId
  if (!clientId) {
    const registered = await request("/api/auth/oauth2/register", json({
      client_name: "Fixture MCP host",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }))
    expect(registered.status).toBe(201)
    clientId = ((await registered.json()) as { client_id: string }).client_id
  }

  const { verifier, challenge } = pkce()
  const scope = [...input.scopes, "offline_access"].join(" ")
  const authorization = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope,
    resource: MCP_RESOURCE,
    state: "fixture-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const asked = await request(`/api/auth/oauth2/authorize?${authorization.toString()}`, {
    headers: { authorization: `Bearer ${input.sessionToken}` },
    redirect: "manual",
  })
  // Better Auth sends a signed-in user to the consent page this box configured
  // and carries the authorize query there; the page hands that query straight
  // back with the scopes the person ticked.
  expect(asked.status).toBe(302)
  const consentPage = new URL(asked.headers.get("location") ?? "", ORIGIN)
  expect(consentPage.pathname).toBe(CONSENT_PATH)

  const consented = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.sessionToken}` },
    body: JSON.stringify({ accept: true, oauth_query: consentPage.search, scope }),
  })
  expect(consented.status, `consent refused: ${await consented.clone().text()}`).toBe(200)
  const location = ((await consented.json()) as { redirect?: boolean; url?: string }).url
  if (!location) throw new Error("consent produced no redirect")
  const code = new URL(location).searchParams.get("code")
  expect(new URL(location).searchParams.get("state")).toBe("fixture-state")
  if (!code) throw new Error(`consent redirected without a code: ${location}`)

  const exchanged = await request("/api/auth/oauth2/token", form({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
    resource: MCP_RESOURCE,
  }))
  expect(exchanged.status).toBe(200)
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token?: string; scope?: string }
  expect(tokens.access_token).toBeTruthy()
  return { ...tokens, clientId, redirect }
}

async function connect(accessToken: string) {
  const client = new Client({ name: "fixture-mcp-host", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/claxedo/mcp", ORIGIN), {
    fetch: (url, init) => Promise.resolve(app.request(url.toString(), init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }))
  return client
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort()

const callTool = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<CallToolResult>

describe("an MCP host that consents on this box's own OAuth server", () => {
  test("disconnecting a consent revokes its access and refresh tokens", async () => {
    const sessionToken = await signUp("disconnect@box.test")
    const granted = await consentedToken({ sessionToken, scopes: ["claxedo:read", "claxedo:act"] })
    const listed = await request("/api/auth/oauth2/get-consents", { headers: { authorization: `Bearer ${sessionToken}` } })
    const rows = await listed.json() as Array<{ id: string; clientId: string }>
    const consent = rows.find((row) => row.clientId === granted.clientId)
    expect(consent).toBeDefined()
    const otherUser = await signUp("other-disconnect@box.test")
    const forbidden = await request("/api/auth/oauth2/delete-consent", {
      method: "POST", headers: { authorization: `Bearer ${otherUser}`, "content-type": "application/json" },
      body: JSON.stringify({ id: consent!.id }),
    })
    expect(forbidden.status).toBe(401)
    const stillConnected = await connect(granted.access_token)
    expect(await toolNames(stillConnected)).toContain("session_send")
    await stillConnected.close()
    const otherClient = await consentedToken({ sessionToken, scopes: ["claxedo:read"] })
    const deleted = await request("/api/auth/oauth2/delete-consent", {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id: consent!.id }),
    })
    expect(deleted.ok).toBe(true)
    const accessed = await request("/api/claxedo/mcp", { headers: { authorization: `Bearer ${granted.access_token}` } })
    expect(accessed.status).toBe(401)
    const refreshed = await request("/api/auth/oauth2/token", form({
      grant_type: "refresh_token", refresh_token: granted.refresh_token!, client_id: granted.clientId, resource: MCP_RESOURCE,
    }))
    expect(refreshed.ok).toBe(false)
    const preserved = await connect(otherClient.access_token)
    expect(await toolNames(preserved)).toContain("sessions_list")
    await preserved.close()
  })

  test("is pointed at the protected-resource metadata, which names this box's authorization server and scopes", async () => {
    const challenged = await initialize()
    expect(challenged.status).toBe(401)
    const header = challenged.headers.get("www-authenticate") ?? ""
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1]
    expect(metadataUrl).toBeTruthy()

    const metadata = await request(new URL(metadataUrl!).pathname)
    expect(metadata.status).toBe(200)
    const document = (await metadata.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] }
    expect(document.resource).toBe(`${ORIGIN}/api/claxedo/mcp`)
    expect(document.authorization_servers).toEqual([`${ORIGIN}/api/auth`])
    expect(document.scopes_supported).toEqual([...CLAXEDO_MCP_OAUTH_SCOPES])

    const [authorizationServer] = document.authorization_servers
    const server = await request(`${new URL(authorizationServer ?? "").pathname}/.well-known/oauth-authorization-server`)
    expect(server.status).toBe(200)
    expect(await server.json()).toMatchObject({
      registration_endpoint: expect.stringMatching(/\/oauth2\/register$/),
    })
  })

  test("spends the token it was issued, with exactly the scopes the person granted", async () => {
    const sessionToken = await signUp("act@box.test")
    const granted = await consentedToken({ sessionToken, scopes: ["claxedo:read", "claxedo:act"] })

    const client = await connect(granted.access_token)
    const listed = await toolNames(client)
    expect(listed).toContain("sessions_board")
    expect(listed).toContain("session_send")
    expect(listed).not.toContain("permission_reply")
    expect(listed).not.toContain("workspace_lifecycle")

    const refused = await callTool(client, "permission_reply", { session: "ses_1", permission: "p1", response: "once" })
    expect(refused.isError).toBe(true)
    expect(answered).toEqual([])
    await client.close()
  })

  test("answers a permission only once the person has granted claxedo:approve", async () => {
    const sessionToken = await signUp("approve@box.test")
    const granted = await consentedToken({ sessionToken, scopes: ["claxedo:read", "claxedo:approve"] })

    const client = await connect(granted.access_token)
    expect(await toolNames(client)).toContain("permission_reply")
    const replied = await callTool(client, "permission_reply", { session: "ses_7", permission: "perm_7", response: "once" })
    expect(replied.isError).toBeFalsy()
    expect(answered).toContainEqual({ sessionID: "ses_7", permissionID: "perm_7", response: "once" })
    await client.close()
  })

  test("is shown reads alone when the person granted only claxedo:read", async () => {
    const sessionToken = await signUp("read@box.test")
    const granted = await consentedToken({ sessionToken, scopes: ["claxedo:read"] })

    const client = await connect(granted.access_token)
    const writes = (await client.listTools()).tools.filter((tool) => tool.annotations?.readOnlyHint !== true)
    expect(writes).toEqual([])
    expect(await toolNames(client)).toContain("sessions_board")
    await client.close()
  })

  test("never spends claxedo:admin, because this box registered no such client itself", async () => {
    const sessionToken = await signUp("admin@box.test")
    const granted = await consentedToken({ sessionToken, scopes: [...CLAXEDO_MCP_OAUTH_SCOPES] })
    expect(granted.scope?.split(" ")).toContain("claxedo:admin")

    const client = await connect(granted.access_token)
    const listed = await toolNames(client)
    expect(listed).toContain("permission_reply")
    expect(listed).not.toContain("workspace_lifecycle")
    expect(listed).not.toContain("workspace_restore")
    const refused = await callTool(client, "workspace_lifecycle", { workspace: "ws_box", action: "stop" })
    expect(refused.isError).toBe(true)
    await client.close()
  })

  test("keeps working across a refresh, and the endpoint refuses a token this box did not issue", async () => {
    const sessionToken = await signUp("refresh@box.test")
    const granted = await consentedToken({ sessionToken, scopes: ["claxedo:read", "claxedo:act"] })
    expect(granted.refresh_token).toBeTruthy()

    const refreshed = await request("/api/auth/oauth2/token", form({
      grant_type: "refresh_token",
      refresh_token: granted.refresh_token!,
      client_id: granted.clientId,
      resource: MCP_RESOURCE,
    }))
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { access_token: string }
    expect(next.access_token).toBeTruthy()
    expect(next.access_token).not.toBe(granted.access_token)

    const client = await connect(next.access_token)
    expect(await toolNames(client)).toContain("session_send")
    await client.close()

    const forged = await initialize({ authorization: "Bearer not-a-token" })
    expect(forged.status).toBe(401)
  })
})
