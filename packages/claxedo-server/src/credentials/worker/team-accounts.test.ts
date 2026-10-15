import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { CREDENTIALS_KEK_ENV, envelopeKeyProviderFromEnv } from "@claxedo/server-core/credentials/envelope"
import { d1Authority } from "../../test-support/d1-authority"
import { HOSTED_CREDENTIALS_FLAG, hostedOrgCredentials } from "./index"
import { hostedOrgAdministers } from "./org-administers"
import { UNDELIVERED_CREDENTIAL_CHANGE } from "./org-routed"
import { hostedCredentialRoutes } from "./routes"

const env = { [HOSTED_CREDENTIALS_FLAG]: "1", [CREDENTIALS_KEK_ENV]: Buffer.alloc(32, 5).toString("base64") }
const authConfig = { enabled: true as const, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" }

let fixture: Awaited<ReturnType<typeof d1Authority>>
let people: Record<"owner" | "member", SignedControlPlaneAuth>
let orgId: string
const vendorSaw: Array<{ url: string; apiKey: string | null }> = []
const captured: Array<{ event: string; properties?: Record<string, unknown> }> = []
const changes: string[] = []

beforeAll(async () => {
  fixture = await d1Authority()
  people = { owner: await fixture.signIn("owner"), member: await fixture.signIn("member") }
  orgId = (await fixture.authority.usersMe(people.owner) as { org_id: string }).org_id
  await fixture.addMember(people.owner, people.member, orgId)
})
afterAll(async () => {
  await fixture.dispose()
})

const authentication: RequestAuthenticationAdapter = {
  descriptor: {} as RequestAuthenticationAdapter["descriptor"],
  authenticate: async (request) => people[request.headers.get("authorization")?.replace(/^Bearer /, "") as keyof typeof people].principal!,
}

const vendor: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init)
  vendorSaw.push({ url: request.url, apiKey: request.headers.get("x-api-key") })
  return Response.json({ data: [] })
}, { preconnect() {} })

const store = () => hostedOrgCredentials(orgId, { database: fixture.database, env })

function app() {
  return hostedCredentialRoutes({
    authentication,
    authConfig,
    resolveOrgId: async () => orgId,
    credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
    change: async (org) => { changes.push(org); return async () => {} },
    administers: hostedOrgAdministers(fixture.database),
    keys: envelopeKeyProviderFromEnv(env),
    fetch: vendor,
    telemetry: { capture: (_distinctId, event, properties) => void captured.push({ event, properties }) },
  })
}

const call = async (person: keyof typeof people, path: string, method = "GET", body?: unknown) => {
  const response = await app().request(`https://cp.test/api/claxedo/credentials${path}`, {
    method,
    headers: { authorization: `Bearer ${person}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() as Record<string, any> }
}

const teamKey = (secret = "sk-ant-api03-team-key", label = "Team Anthropic") =>
  ({ provider_id: "anthropic", kind: "api_key", secret, label, owner: "org" })
const CLAUDE = ["claude-sdk", "claude-acp", "anthropic"]

describe("an organization's team accounts on the hosted plane", () => {
  test("only an owner or admin adds one; it is the organization's row, not a person's", async () => {
    const refused = await call("member", "", "PUT", teamKey())
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "org_accounts_forbidden" } } })
    expect(await store().listCredentials()).toEqual([])

    const added = await call("owner", "", "PUT", teamKey())
    expect(added.status).toBe(200)
    expect(added.body.credential).toMatchObject({ owner: null, provider_id: "anthropic", kind: "api_key", label: "Team Anthropic" })
    expect(await store().listCredentials()).toMatchObject([{ owner: null, provider_id: "anthropic", kind: "api_key" }])
    expect(await store().resolveCredentialSecretById?.(added.body.credential.id)).toBe("sk-ant-api03-team-key")
    expect((await call("owner", "")).body.credentials).toEqual([])
    expect(changes.at(-1)).toBe(orgId)
  })

  test("a personal plan is refused as a team account, whatever field it was pasted into", async () => {
    for (const body of [
      teamKey("sk-ant-oat01-plan-token"),
      { ...teamKey("sk-ant-oat01-plan-token"), kind: "oauth_token" },
      { provider_id: "openai", kind: "api_key", owner: "org", secret: JSON.stringify({ tokens: { access_token: "chatgpt-access", account_id: "acct" } }) },
      { provider_id: "claude-sdk", kind: "api_key", owner: "org", secret: "sk-ant-api03-binding" },
      teamKey("sk-ant-ort01-refresh-token"),
      { provider_id: "openai", kind: "api_key", owner: "org", secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature" },
      { provider_id: "openai", kind: "api_key", owner: "org", secret: "sk-ant-api03-another-vendor" },
      { provider_id: "groq", kind: "api_key", owner: "org", secret: "not-a-groq-key" },
    ]) {
      const answer = await call("owner", "", "PUT", body)
      expect(answer.status, JSON.stringify(body)).toBe(400)
      expect(answer.body.error.code).toMatch(/^org_account_(plan_refused|provider_unsupported)$/)
    }
    expect((await call("owner", "", "PUT", teamKey("sk-ant-oat01-plan-token"))).body.error).toMatchObject({
      code: "org_account_plan_refused",
      message: expect.stringContaining("API keys only"),
    })
    expect(await store().listCredentials()).toHaveLength(1)
  })

  test("a member sees the team account's label, provider and health, never its secret, and cannot check, rotate or remove it", async () => {
    const [team] = await store().listCredentials()
    await fixture.database.prepare("update hosted_provider_credentials set last_error = 'auth_failed: 401 authentication_error acct_internal' where id = ?").bind(team.id).run()
    const listing = await call("member", "/account-sources")
    expect(listing.body.org[0].last_error).toBeNull()
    expect((await call("owner", "/account-sources")).body.org[0].last_error).toBe("auth_failed: 401 authentication_error acct_internal")
    expect(listing.body).toMatchObject({ can_manage_org_accounts: false, org: [{ id: team.id, label: "Team Anthropic", provider_id: "anthropic", health: null, owner: null }] })
    expect(JSON.stringify(listing.body)).not.toContain("sk-ant-api03-team-key")
    expect((await call("owner", "/account-sources")).body.can_manage_org_accounts).toBe(true)

    expect((await call("member", `/${team.id}/verify`, "POST", {})).status).toBe(404)
    expect((await call("member", `/${team.id}/reconnect`, "POST", { secret: "sk-ant-api03-member-swap" })).status).toBe(404)
    expect((await call("member", `/${team.id}/status`, "PATCH", { status: "revoked" })).status).toBe(404)
    expect((await call("member", `/${team.id}`, "DELETE")).body).toEqual({ deleted: false })
    expect((await call("member", "", "PUT", teamKey("sk-ant-api03-member-swap"))).status).toBe(403)
    expect(await store().resolveCredentialSecretById?.(team.id)).toBe("sk-ant-api03-team-key")
  })

  test("an admin checks it, recorded as an org-scoped verdict with no id or secret, and rotates it in place", async () => {
    const [team] = await store().listCredentials()
    const checked = await call("owner", `/${team.id}/verify`, "POST", {})
    expect(checked.body).toMatchObject({ health: "ok" })
    expect(vendorSaw.at(-1)).toEqual({ url: expect.stringMatching(/^https:\/\/api\.anthropic\.com\/v1\//), apiKey: "sk-ant-api03-team-key" })
    const event = captured.findLast((row) => row.event === "credential_checked")
    expect(event?.properties).toMatchObject({ provider: "anthropic", kind: "api_key", verdict: "ok", scope: "org" })
    expect(JSON.stringify(event?.properties)).not.toContain(team.id)
    expect(JSON.stringify(event?.properties)).not.toContain("sk-ant")

    expect(await call("owner", `/${team.id}/reconnect`, "POST", { secret: "sk-ant-api03-by-reconnect" })).toMatchObject({ status: 409, body: { error: { code: "org_account_rotate_by_put" } } })
    const rotated = await call("owner", "", "PUT", teamKey("sk-ant-api03-team-rotated"))
    expect(rotated.body.credential).toMatchObject({ id: team.id, owner: null })
    expect(await store().getCredential?.(team.id)).toMatchObject({ revision: 2 })
    expect(await store().resolveCredentialSecretById?.(team.id)).toBe("sk-ant-api03-team-rotated")
  })

  test("a person chooses the team account only for a provider the organization holds one for", async () => {
    const missing = await call("member", "/account-sources", "PUT", { provider_ids: ["codex-app-server", "openai"], source: "org" })
    expect(missing).toMatchObject({ status: 409, body: { error: { code: "org_account_missing" } } })
    expect((await call("member", "/account-sources")).body.sources).toEqual({})
    const mixed = await call("member", "/account-sources", "PUT", { provider_ids: ["anthropic", "openai"], source: "org" })
    expect(mixed).toMatchObject({ status: 409, body: { error: { code: "org_account_missing" } } })

    const chosen = await call("member", "/account-sources", "PUT", { provider_ids: CLAUDE, source: "org" })
    expect(chosen).toMatchObject({ status: 200, body: { sources: { "claude-sdk": "org", "claude-acp": "org", anthropic: "org" } } })
    const effective = await call("member", "/effective?scope=shared")
    expect(effective.body.credentials).toMatchObject([{ owner: null, provider_id: "anthropic", label: "Team Anthropic" }])
    expect((await call("member", "/account-sources", "PUT", { provider_ids: ["codex-app-server", "openai"], source: "own" })).status).toBe(200)
  })

  test("a write passed by an admin check that went stale is refused by the write itself: a demoted admin adds, rotates and removes nothing", async () => {
    const stale = hostedCredentialRoutes({
      authentication, authConfig, resolveOrgId: async () => orgId, credentials: (org) => hostedOrgCredentials(org, { database: fixture.database, env }),
      change: UNDELIVERED_CREDENTIAL_CHANGE, administers: async () => true, keys: envelopeKeyProviderFromEnv(env),
    })
    const asMember = (path: string, method: string, body?: unknown) => stale.request(`https://cp.test/api/claxedo/credentials${path}`, {
      method, headers: { authorization: "Bearer member", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const [team] = await store().listCredentials()
    const rotated = await asMember("", "PUT", teamKey("sk-ant-api03-demoted-rotation"))
    expect(rotated.status).toBe(403)
    expect(await store().resolveCredentialSecretById?.(team.id)).not.toBe("sk-ant-api03-demoted-rotation")
    const added = await asMember("", "PUT", { provider_id: "openai", kind: "api_key", owner: "org", secret: "sk-proj-demoted" })
    expect(added.status).toBe(403)
    expect(await (await asMember(`/${team.id}`, "DELETE")).json()).toEqual({ deleted: false })
    expect((await store().listCredentials()).map((row) => row.id)).toEqual([team.id])
  })

  test("an admin removes it; the person who chose it keeps the choice, now naming an account that is gone", async () => {
    const [team] = await store().listCredentials()
    expect((await call("owner", `/${team.id}`, "DELETE")).body).toEqual({ deleted: true })
    expect(await store().listCredentials()).toEqual([])
    expect((await call("member", "/account-sources")).body).toMatchObject({ sources: { anthropic: "org" }, org: [] })
  })
})
