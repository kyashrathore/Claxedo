import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { providerDirect } from "@claxedo/agent-runtime-contract"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "../credentials/worker/index"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../test-support/control-plane-migrations"
import { RuntimeSessionAuthorityRoutes } from "./runtime-session-authority"
import { sandboxDirectCredentialRefresh } from "../hosts/workspace-runtime/direct-credential-refresh"

const env = { [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 9).toString("base64"), [HOSTED_CREDENTIALS_FLAG]: "1" }
const access = (tag: string, exp: number) => `h.${Buffer.from(JSON.stringify({ exp, tag })).toString("base64url")}.s`

let controlPlane: ControlPlaneDatabase
beforeAll(async () => {
  controlPlane = await miniflareControlPlaneDatabase()
})
afterAll(async () => {
  await controlPlane.dispose()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

let sequence = 0
async function fixture() {
  const org = `org-refresh-${++sequence}`
  const relayKeys = await generateKeyPair("EdDSA", { extractable: true })
  const turnKeys = await generateKeyPair("EdDSA", { extractable: true })
  const active = vi.fn(async () => ({ active: true }))
  const store = hostedOrgCredentials(org, { database: controlPlane.database, env })
  const app = RuntimeSessionAuthorityRoutes({
    authority: { runtimeAccessTokenActive: active, authorizeRuntimeSession: async () => {} } as never,
    turnAuthority: {
      acquireSessionTurn: async (turn: { sessionId: string; workspaceId: string; turnId: string }) => ({
        ...turn, leaseId: "authority-lease-1", fencingToken: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000,
      }),
    } as never,
    env: {
      CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKeys.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(turnKeys.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(turnKeys.publicKey),
    },
    credentialRefresh: {
      resolveWorkspaceOwner: async () => ({ userId: "owner", actorId: "actor-1", orgId: org, projectId: "project-1" }),
      credentials: () => store,
    },
  })
  const acquireTurn = async (workspaceId = "workspace-1") => {
    const proof = await mintRelayHostToken({ principalKind: "user", actorId: "actor-1", actorKind: "human", orgId: org, workspaceId,
      hostId: "host-1", role: "owner", backing: "cloud-vm", jti: "proof-1", parentJti: "parent-1", ttlSeconds: 60 }, relayKeys.privateKey, "EdDSA")
    const response = await app.request("/session-authorize", { method: "POST",
      headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses-1", action: "turn_acquire", turnId: "msg-1" }) })
    expect(response.status).toBe(200)
    return (await response.json() as { leaseId: string }).leaseId
  }
  const refresh = (body: Record<string, unknown>) => app.request("/credential-refresh/workspace-1", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ credentialProviderId: "codex-app-server", ...body }) })
  const plan = async (owner: string, token: string, expiresAt: number) => await store.putCredential({
    owner, provider_id: "codex-app-server", kind: "oauth_token", source: "managed", expires_at: expiresAt,
    secret: JSON.stringify({ type: "codex_auth", tokens: { access_token: token, refresh_token: "refresh-1", account_id: "acct" }, access: token, refresh: "refresh-1" }),
  })
  return { app, store, active, acquireTurn, refresh, plan }
}

function openaiTokenEndpoint(token: string) {
  const exchanged: string[] = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    exchanged.push(`${url} ${typeof init.body === "string" ? init.body : ""}`)
    return Response.json({ access_token: token, refresh_token: "refresh-2" })
  })
  return exchanged
}

describe("a sandbox renewing the ChatGPT plan it was handed, under its running turn's lease", () => {
  test("a refused token is renewed in the store and only the new access token comes back", async () => {
    const f = await fixture()
    const now = Math.floor(Date.now() / 1000)
    const renewed = access("renewed", now + 7200)
    const exchanged = openaiTokenEndpoint(renewed)
    await f.plan("owner", access("first", now + 3600), (now + 3600) * 1000)

    const response = await f.refresh({ turnLease: await f.acquireTurn(), rejectedExpiresAt: (now + 3600) * 1000 })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(providerDirect(body)).toMatchObject({ secret: renewed, authKind: "subscription", expiresAt: (now + 7200) * 1000 })
    expect(JSON.stringify(body)).not.toContain("refresh-")
    expect(exchanged).toEqual([expect.stringContaining("refresh_token=refresh-1")])

    const again = await f.refresh({ turnLease: await f.acquireTurn(), rejectedExpiresAt: (now + 3600) * 1000 })
    expect((await again.json()).secret).toBe(renewed)
    expect(exchanged).toHaveLength(1)
  })

  test("only a plan handed over as its token, only the workspace owner's, and only under a live lease of this workspace", async () => {
    const f = await fixture()
    const exchanged = openaiTokenEndpoint("unused")
    const now = Math.floor(Date.now() / 1000)
    await f.store.putCredential({ owner: "owner", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant-api03-owner" })
    await f.plan("someone-else", access("theirs", now + 3600), (now + 3600) * 1000)
    const turnLease = await f.acquireTurn()

    const key = await f.refresh({ turnLease, credentialProviderId: "anthropic" })
    expect(key.status).toBe(403)
    expect(await key.text()).not.toContain("sk-ant")
    expect((await f.refresh({ turnLease })).status).toBe(409)
    expect((await f.refresh({ turnLease: await f.acquireTurn("workspace-2") })).status).toBe(403)
    expect((await f.refresh({ turnLease: `${turnLease}x` })).status).toBe(401)
    f.active.mockResolvedValue({ active: false })
    expect((await f.refresh({ turnLease })).status).toBe(403)
    expect(exchanged).toEqual([])
  })

  test("the sandbox's client asks the route with its turn lease and reads nothing back when the plane holds no plan", async () => {
    const f = await fixture()
    const now = Math.floor(Date.now() / 1000)
    const renewed = access("renewed", now + 7200)
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => url.startsWith("https://cp.test/")
      ? f.app.request(url.slice("https://cp.test/api/runtime-authority".length), init)
      : Response.json({ access_token: renewed, refresh_token: "refresh-2" }))
    const client = sandboxDirectCredentialRefresh({ workspaceId: "workspace-1", authorityUrl: "https://cp.test" })
    const authority = { kind: "turn" as const, lease: await f.acquireTurn() }

    expect(await client({ authority, credentialProviderId: "codex-app-server" })).toBeUndefined()
    await f.plan("owner", access("first", now + 60), (now + 60) * 1000)
    expect(await client({ authority, credentialProviderId: "codex-app-server", rejectedExpiresAt: (now + 60) * 1000 }))
      .toMatchObject({ delivery: "direct", secret: renewed, authKind: "subscription" })
    expect(await client({ authority: { kind: "request", credential: "Bearer relay" }, credentialProviderId: "codex-app-server" })).toBeUndefined()
  })
})
