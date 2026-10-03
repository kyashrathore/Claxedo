import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { AuthenticationError, type RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV } from "@claxedo/server-core/credentials/envelope"
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

  test("no provider device login is served", async () => {
    const { store, app } = rig()
    expect((await call(app(), "/provider/auth")).status).toBe(404)
    expect((await call(app(), "/provider/codex-app-server/oauth/authorize", { method: "POST", body: { method: 0 } })).status).toBe(404)
    expect(await store().listCredentials()).toEqual([])
  })

  test("choosing an account makes it the person's most recent mark, and only their own can be chosen", async () => {
    const { store, app } = rig()
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("anthropic", "sk-ant-api03-alice") })
    await call(app(), "/api/claxedo/credentials", { method: "PUT", body: key("claude-sdk", "sk-ant-oat01-alice") })
    const marked = async () => (await (await call(app(), "/api/claxedo/credentials/effective")).json()).credentials.map((row: { provider_id: string }) => row.provider_id)
    expect(await marked()).toEqual(["claude-sdk", "anthropic"])
    const anthropic = (await store().listCredentials()).find((row) => row.provider_id === "anthropic")!
    expect((await call(app(), "/api/claxedo/credentials/activate", { method: "POST", body: { ids: [anthropic.id] }, person: "bob" })).status).toBe(404)
    expect(await marked()).toEqual(["claude-sdk", "anthropic"])
    expect((await call(app(), "/api/claxedo/credentials/activate", { method: "POST", body: { ids: [anthropic.id] } })).status).toBe(200)
    expect(await marked()).toEqual(["anthropic", "claude-sdk"])
  })
})
