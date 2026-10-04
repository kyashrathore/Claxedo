import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { AuthenticationError, type RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "./index"
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

const upstream: string[] = []
const claims = Buffer.from(JSON.stringify({ email: "alice@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct_alice" } })).toString("base64url")
const deviceLogin: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  upstream.push(url)
  if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "device-secret", user_code: "WXYZ-1234", interval: 1 })
  if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" })
  return Response.json({ id_token: `h.${claims}.s`, access_token: "chatgpt-access", refresh_token: "chatgpt-refresh", expires_in: 3600 })
}, { preconnect() {} })

let sequence = 0
function rig() {
  const org = `setup-${++sequence}`
  const changes: string[] = []
  let at = 1_000
  const store = (orgId: string) => hostedOrgCredentials(orgId, { database: database.database, env }, { now: () => ++at })
  const app = () => hostedCredentialRoutes({
    authentication,
    authConfig,
    resolveOrgId: async () => org,
    credentials: store,
    changed: async (orgId) => void changes.push(orgId),
    keys: envelopeKeyProviderFromEnv(env),
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
    expect((await call(app(), `/api/claxedo/credentials/${row.id}/verify`, { method: "POST", body: {}, person: "bob" })).status).toBe(404)
    expect((await call(app(), `/api/claxedo/credentials/${row.id}/reconnect`, { method: "POST", body: { secret: "replacement" }, person: "bob" })).status).toBe(404)
    expect(await (await call(app(), `/api/claxedo/credentials/${row.id}`, { method: "DELETE", person: "bob" })).json()).toEqual({ deleted: false })
    expect(await store().resolveCredentialSecretById?.(row.id)).toBe("test-key")
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

  test("a ChatGPT sign-in started on one Worker instance completes on another, as the person who started it", async () => {
    const { org, changes, store, app } = rig()
    const methods = await (await call(app(), "/provider/auth")).json()
    expect(methods["codex-app-server"].map((method: { type: string }) => method.type)).toEqual(["oauth", "api"])
    expect(methods.openai).toEqual([{ type: "api", label: "API Key" }])

    const started = await (await call(app(), "/provider/codex-app-server/oauth/authorize", { method: "POST", body: { method: 0 } })).json()
    expect(started).toMatchObject({ method: "auto", instructions: "Enter code: WXYZ-1234" })
    expect(started.attempt).not.toContain("device-secret")
    const stolen = await call(app(), "/provider/codex-app-server/oauth/callback", { method: "POST", body: { method: 0, attempt: started.attempt }, person: "bob" })
    expect([stolen.status, (await stolen.json()).error.code]).toEqual([400, "provider_auth_missing_pending"])
    expect(await store().listCredentials()).toEqual([])

    const done = await call(app(), "/provider/codex-app-server/oauth/callback", { method: "POST", body: { method: 0, attempt: started.attempt } })
    expect([done.status, await done.json()]).toEqual([200, true])
    expect(await store().listCredentials()).toMatchObject([{
      owner: "alice", org_id: org, provider_id: "codex-app-server", kind: "oauth_token", label: "alice@example.com", account_id: "acct_alice",
    }])
    expect(changes).toEqual([org])
    const row = await database.database.prepare("select secret_envelope from hosted_provider_credentials where org_id = ?").bind(org).first<{ secret_envelope: string }>()
    expect(row?.secret_envelope).not.toContain("chatgpt-refresh")
    expect(upstream.filter((url) => url.endsWith("/deviceauth/usercode"))).toHaveLength(1)
  })

  test("a save marks an account only on a vendor host the person has none on; choosing one makes it the most recent mark, and only their own can be chosen", async () => {
    const { store, app } = rig()
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("claude-sdk", "sk-ant-oat01-alice") })
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("anthropic", "sk-ant-api03-alice") })
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("openai", "sk-openai-alice") })
    const marked = async () => (await (await call(app(), "/api/claxedo/credentials/effective")).json()).credentials.map((row: { provider_id: string }) => row.provider_id)
    expect(await marked()).toEqual(["openai", "claude-sdk"])
    const anthropic = (await store().listCredentials()).find((row) => row.provider_id === "anthropic")!
    expect((await call(app(), "/api/claxedo/credentials/activate", { method: "POST", body: { ids: [anthropic.id] }, person: "bob" })).status).toBe(404)
    expect(await marked()).toEqual(["openai", "claude-sdk"])
    expect((await call(app(), "/api/claxedo/credentials/activate", { method: "POST", body: { ids: [anthropic.id] } })).status).toBe(200)
    expect(await marked()).toEqual(["anthropic", "openai", "claude-sdk"])
  })
})
