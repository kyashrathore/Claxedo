import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { AuthenticationError, type RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "./index"
import { d1ProviderAuthPending } from "./provider-auth-pending"
import { hostedCredentialRoutes } from "./routes"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 7).toString("base64") }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }

let database: ControlPlaneDatabase
beforeAll(async () => {
  database = await miniflareControlPlaneDatabase()
})
afterAll(async () => {
  await database.dispose()
})

const authentication: RequestAuthenticationAdapter = {
  descriptor: {} as RequestAuthenticationAdapter["descriptor"],
  authenticate: async (request) => {
    const person = request.headers.get("authorization")?.replace(/^Bearer /, "")
    if (!person) throw new AuthenticationError(401, "invalid_credentials", "Sign in")
    return {
      userId: person,
      identity: { adapter: "better-auth", issuer: "https://auth.test", subject: person },
    } as unknown as Awaited<ReturnType<RequestAuthenticationAdapter["authenticate"]>>
  },
}

const deviceLogin: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "device-1", user_code: "CODE-1234", interval: 1 })
  if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" })
  if (url.endsWith("/oauth/token")) return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
  throw new Error(`unexpected provider request ${url}`)
}, { preconnect() {} })

let sequence = 0
function rig() {
  const org = `setup-${++sequence}`
  const changes: string[] = []
  const store = (orgId: string) => hostedOrgCredentials(orgId, { database: database.database, env })
  const app = () => hostedCredentialRoutes({
    authentication,
    authConfig,
    resolveOrgId: async () => org,
    credentials: store,
    changed: async (orgId) => void changes.push(orgId),
    pending: d1ProviderAuthPending(database.database, env),
    fetch: deviceLogin,
  })
  return { org, changes, store: () => store(org), app }
}

const call = (app: ReturnType<ReturnType<typeof rig>["app"]>, path: string, init: { method?: string; body?: unknown; person?: string } = {}) =>
  app.request(`https://cp.test${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.person === undefined ? { authorization: "Bearer alice" } : init.person ? { authorization: `Bearer ${init.person}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

const key = (provider_id: string, secret = "test-key") => ({ provider_id, kind: "api_key", source: "managed", label: provider_id, secret })

describe("hosted account setup through the shared credential routes", () => {
  test("a write needs a signed person, lands in the authority's organization as that person, and tells the plane", async () => {
    const { org, changes, store, app } = rig()
    expect((await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("claude-sdk"), person: "" })).status).toBe(401)
    const stored = await call(app(), "/api/claxedo/credentials", { method: "PUT", body: { ...key("claude-sdk"), owner: "bob", org_id: "attacker" } })
    expect(stored.status).toBe(200)
    expect(await store().listCredentials()).toMatchObject([{ owner: "alice", org_id: org, provider_id: "claude-sdk", is_active: true }])
    expect(changes).toEqual([org])
  })

  test("a pasted subscription token keeps its canonical kind, and the plane reports no machine logins", async () => {
    const { store, app } = rig()
    expect((await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("claude-sdk", "sk-ant-oat01-test-setup-token") })).status).toBe(200)
    expect((await store().getCredentialByProvider("claude-sdk", { owner: "alice" }))?.kind).toBe("oauth_token")
    const logins = await call(app(), "/api/claxedo/credentials/machine-logins")
    expect([logins.status, (await logins.json()).error.code]).toEqual([501, "credential_machine_login_unavailable"])
  })

  test("another person cannot list, check, reconnect or delete someone's account", async () => {
    const { store, app } = rig()
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("cursor-sdk") })
    const [row] = await store().listCredentials()
    expect((await (await call(app(), "/api/claxedo/credentials", { person: "bob" })).json()).credentials).toEqual([])
    expect((await call(app(), `/api/claxedo/credentials/${row!.id}/verify`, { method: "POST", body: {}, person: "bob" })).status).toBe(404)
    expect((await call(app(), `/api/claxedo/credentials/${row!.id}/reconnect`, { method: "POST", body: { secret: "replacement" }, person: "bob" })).status).toBe(404)
    expect(await (await call(app(), `/api/claxedo/credentials/${row!.id}`, { method: "DELETE", person: "bob" })).json()).toEqual({ deleted: false })
    expect(await store().resolveCredentialSecretById?.(row!.id)).toBe("test-key")
  })

  test("the effective account follows the person's own or organization selection", async () => {
    const { store, app } = rig()
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("claude-sdk") })
    const orgAccount = await store().putCredential({ owner: null, provider_id: "claude-sdk", kind: "api_key", source: "managed", secret: "org-key" })
    const effective = async () => (await (await call(app(), "/api/claxedo/credentials/effective")).json()).credentials.map((row: { id: string; owner: string | null }) => row.owner)
    expect(await effective()).toEqual(["alice"])
    expect((await call(app(), "/api/claxedo/credentials/account-sources", { method: "PUT", body: { provider_ids: ["claude-sdk"], source: "org" } })).status).toBe(200)
    expect(await effective()).toEqual([null])
    expect(JSON.stringify(await (await call(app(), "/api/claxedo/credentials/account-sources")).json())).toContain(orgAccount.id)
  })

  test("a Codex device login completes on another Worker instance, once, and only for the person who started it", async () => {
    const { store, app } = rig()
    const route = "/provider/codex-app-server/oauth"
    expect((await call(app(), `${route}/authorize`, { method: "POST", body: { method: 0 } })).status).toBe(200)
    const stolen = await call(app(), `${route}/callback`, { method: "POST", body: { method: 0 }, person: "bob" })
    expect(await stolen.json()).toMatchObject({ error: { code: "provider_auth_missing_pending" } })
    expect((await call(app(), `${route}/callback`, { method: "POST", body: { method: 0 } })).status).toBe(200)
    expect((await store().getCredentialByProvider("codex-app-server", { owner: "alice" }))?.kind).toBe("oauth_token")
    expect((await call(app(), `${route}/callback`, { method: "POST", body: { method: 0 } })).status).toBe(400)
  })

  test("a waiting device login is sealed, expires, and has a single consumer", async () => {
    const { org } = rig()
    let at = 1_000_000
    const first = d1ProviderAuthPending(database.database, env, () => at)
    const second = d1ProviderAuthPending(database.database, env, () => at)
    const pending = { org, providerId: "openai" as const, deviceAuthId: "secret-device-code", userCode: "CODE-1234", intervalMs: 1000, startedAt: at }
    const id = JSON.stringify([org, "openai", "alice"])
    await first.put(id, pending)
    const row = await database.database.prepare("select secret_envelope from hosted_provider_auth_attempts where id = ?").bind(id).first<{ secret_envelope: string }>()
    expect(row?.secret_envelope).not.toContain(pending.deviceAuthId)
    expect((await Promise.all([first.take(id), second.take(id)])).filter(Boolean)).toEqual([pending])
    await first.put(id, pending)
    at += 15 * 60 * 1000
    expect(await second.take(id)).toBeUndefined()
  })
})
