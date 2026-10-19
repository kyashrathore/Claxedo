import { createHash, randomBytes } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { BETTER_AUTH_CLI_CLIENT_ID, BETTER_AUTH_DESKTOP_CLIENT_ID, BETTER_AUTH_NATIVE_SCOPES } from "../../../platform/auth/better-auth-d1-foundation"
import { DEVICE_GRANT, deviceGrant } from "../../../test-support/device-grant"
import {
  USER_DEPLOYED_API as API,
  USER_DEPLOYED_APP as APP,
  userDeployedBetterAuthApp,
  type UserDeployedBetterAuthApp,
} from "../../../test-support/user-deployed-better-auth-app"

/**
 * `claxedo login` against the Better Auth + D1 composition the Worker serves:
 * the RFC 8628 device grant for the `claxedo-cli` client the descriptor
 * advertises, the signed-in person's approval on `/device`, the token
 * exchange, and that access token spent on a signed control-plane route.
 */

const CONTROL_PLANE_RESOURCE = `${API}/control-plane`
const MCP_RESOURCE = `${API}/api/claxedo/mcp`

let rig: UserDeployedBetterAuthApp

beforeAll(async () => {
  rig = await userDeployedBetterAuthApp()
}, 60_000)

afterAll(async () => {
  await rig?.dispose()
})

const request = (pathname: string, init?: RequestInit) => rig.request(pathname, init)
const grant = () => deviceGrant(rig.app, API)
const form = (body: Record<string, string>) =>
  ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() })
const json = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "content-type": "application/json", origin: APP, ...headers }, body: JSON.stringify(body) })
const enrollments = (token: string) => request("/api/claxedo/host/enrollments", { headers: { authorization: `Bearer ${token}` } })
const signIn = (email: string) => rig.signIn(email)
const claimOwnership = (person: { cookie: string; origin: string }) => rig.claimOwnership(person)

type McpTokens = { access_token: string; refresh_token: string; clientId: string }

/** An MCP host's whole authorization: RFC 7591 registration, consent, and the code exchange. */
async function mcpGrant(person: { cookie: string; origin: string }, port: number): Promise<McpTokens> {
  const redirect = `http://127.0.0.1:${port}/callback`
  const registered = await request("/api/auth/oauth2/register", json({
    client_name: "Fixture MCP host", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native",
  }))
  expect(registered.status, await registered.clone().text()).toBe(201)
  const clientId = ((await registered.json()) as { client_id: string }).client_id
  const scope = "claxedo:read offline_access"
  const verifier = randomBytes(32).toString("base64url")
  const asked = await request(`/api/auth/oauth2/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: "code", scope, resource: MCP_RESOURCE, state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  })}`, { headers: { cookie: person.cookie }, redirect: "manual" })
  expect(asked.status).toBe(302)
  const consented = await request("/api/auth/oauth2/consent", json(
    { accept: true, oauth_query: new URL(asked.headers.get("location") ?? "", API).search, scope }, person,
  ))
  expect(consented.status, await consented.clone().text()).toBe(200)
  const code = new URL(((await consented.json()) as { url: string }).url).searchParams.get("code")
  if (!code) throw new Error("consent redirected without a code")
  const exchanged = await request("/api/auth/oauth2/token", form({
    grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: MCP_RESOURCE,
  }))
  expect(exchanged.status, await exchanged.clone().text()).toBe(200)
  const tokens = (await exchanged.json()) as Omit<McpTokens, "clientId">
  expect(tokens.refresh_token).toMatch(/\S/)
  return { ...tokens, clientId }
}

const refreshMcp = (tokens: McpTokens) => request("/api/auth/oauth2/token", form({
  grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId, resource: MCP_RESOURCE,
}))

async function oauthTokenRows(clientId: string) {
  const count = async (table: string) => (await rig.authDatabase
    .prepare(`select count(*) as rows from "${table}" where "clientId" = ?`).bind(clientId).first<{ rows: number }>())?.rows
  return { access: await count("oauthAccessToken"), refresh: await count("oauthRefreshToken") }
}

describe("claxedo login on the Better Auth D1 composition", () => {
  test("a bearer this deployment never issued is a typed 401, whatever its shape", async () => {
    const jwtShaped = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzb21lb25lIn0.c2lnbmF0dXJl"
    for (const token of ["not-a-token", jwtShaped, `clx_at_${jwtShaped}`, "clx_at_never-issued"]) {
      const refused = await enrollments(token)
      expect({ token, status: refused.status, body: await refused.json() })
        .toMatchObject({ token, status: 401, body: { error: { code: "invalid_bearer_token" } } })
    }
  })

  test("device code → approval → token exchange → the access token reaches a signed route; refresh and revoke follow it", async () => {
    const owner = await signIn("owner@device-login.test")
    await claimOwnership(owner)

    const device = await grant().requestCode()
    expect(device.verification_uri).toBe(`${APP}/device`)
    expect(device.user_code).toMatch(/\S/)
    expect(device.interval).toBe(5)
    expect(device.expires_in).toBe(600)

    const pending = await grant().exchange(device.device_code)
    expect(pending.status).toBe(400)
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" })
    const hasty = await grant().exchange(device.device_code)
    expect(await hasty.json()).toMatchObject({ error: "slow_down" })
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (device.interval + 1) * 1000 })

    const claimed = await grant().viewed(device.user_code, owner)
    expect(claimed).toMatchObject({ user_code: device.user_code, status: "pending", client_id: BETTER_AUTH_CLI_CLIENT_ID })
    expect(claimed.transaction).toMatch(/^[0-9a-f]{64}$/)
    const approved = await grant().decide("approve", { userCode: device.user_code, transaction: claimed.transaction }, owner)
    expect(approved.status, await approved.clone().text()).toBe(200)

    const exchanged = await grant().exchange(device.device_code)
    expect(exchanged.status, await exchanged.clone().text()).toBe(200)
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string }
    expect(tokens.token_type).toBe("Bearer")
    expect(tokens.refresh_token).toMatch(/\S/)

    const listed = await enrollments(tokens.access_token)
    expect(listed.status, await listed.clone().text()).toBe(200)
    const who = await request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })
    expect(who.status, await who.clone().text()).toBe(200)
    expect(await who.json()).toMatchObject({ email: "owner@device-login.test" })

    expect((await grant().exchange(device.device_code)).status).toBe(400)

    const refreshed = await request("/api/auth/oauth2/token", form({
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: BETTER_AUTH_CLI_CLIENT_ID, resource: CONTROL_PLANE_RESOURCE,
    }))
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    const rotated = (await refreshed.json()) as { access_token: string }
    expect(rotated.access_token).not.toBe(tokens.access_token)
    expect((await enrollments(rotated.access_token)).status).toBe(200)

    const revoked = await request("/api/auth/oauth2/revoke", form({ token: rotated.access_token, client_id: BETTER_AUTH_CLI_CLIENT_ID }))
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    expect((await enrollments(rotated.access_token)).status).toBe(401)
    vi.useRealTimers()
  })

  test("a decision is refused unless it carries the transaction of the request the approver was shown", async () => {
    const owner = await signIn("transaction@device-login.test")
    const first = await grant().requestCode()
    const second = await grant().requestCode()
    const firstView = await grant().viewed(first.user_code, owner)
    const secondView = await grant().viewed(second.user_code, owner)

    const refusals = {
      absent: await grant().decide("approve", { userCode: second.user_code }, owner),
      stale: await grant().decide("approve", { userCode: second.user_code, transaction: firstView.transaction }, owner),
      guessed: await grant().decide("approve", { userCode: second.user_code, transaction: "0".repeat(64) }, owner),
    }
    for (const [reason, response] of Object.entries(refusals)) {
      expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(403)
      expect(await response.json()).toMatchObject({ error: "access_denied" })
    }
    expect(secondView.transaction).not.toBe(firstView.transaction)
    expect(await (await grant().exchange(second.device_code)).json()).toMatchObject({ error: "authorization_pending" })

    const approved = await grant().decide("approve", { userCode: second.user_code, transaction: secondView.transaction }, owner)
    expect(approved.status, await approved.clone().text()).toBe(200)
    expect((await grant().decide("deny", { userCode: first.user_code, transaction: secondView.transaction }, owner)).status).toBe(403)
    const denied = await grant().decide("deny", { userCode: first.user_code, transaction: firstView.transaction }, owner)
    expect(denied.status, await denied.clone().text()).toBe(200)
  })

  test("the transaction reaches only the person who owns the request", async () => {
    const owner = await signIn("owner@transaction-holder.test")
    const intruder = await signIn("intruder@transaction-holder.test")
    const device = await grant().requestCode()

    const ownerView = await grant().viewed(device.user_code, owner)
    expect(ownerView.transaction).toMatch(/^[0-9a-f]{64}$/)
    expect(await grant().viewed(device.user_code, intruder)).toEqual({ user_code: device.user_code, status: "pending" })

    const stolen = await grant().decide("approve", { userCode: device.user_code, transaction: ownerView.transaction }, intruder)
    expect(stolen.status).toBe(403)
    expect(await (await grant().exchange(device.device_code)).json()).toMatchObject({ error: "authorization_pending" })
  })

  test("no GET or HEAD approves, denies or consumes a device request", async () => {
    const owner = await signIn("read-only@device-login.test")
    const device = await grant().requestCode()
    const view = await grant().viewed(device.user_code, owner)

    const decision = new URLSearchParams({ userCode: device.user_code, transaction: view.transaction ?? "" })
    for (const kind of ["approve", "deny"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await grant().request(`/api/auth/device/${kind}?${decision}`, { method, headers: owner })
        expect(response.status, `${method} /api/auth/device/${kind}`).toBe(404)
      }
    }
    const exchangeQuery = new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: BETTER_AUTH_CLI_CLIENT_ID, resource: CONTROL_PLANE_RESOURCE })
    expect((await grant().request(`/api/auth/oauth2/token?${exchangeQuery}`, { method: "GET" })).status).not.toBe(200)
    expect(await grant().viewed(device.user_code, owner)).toMatchObject({ status: "pending" })
    expect(await (await grant().exchange(device.device_code)).json()).toMatchObject({ error: "authorization_pending" })
  })

  test("a cookie-bearing approval is refused from a foreign origin and accepted from the app origin", async () => {
    const owner = await signIn("hostile-origin@device-login.test")
    const device = await grant().requestCode()
    const view = await grant().viewed(device.user_code, owner)
    const decide = (origin: string) => grant().decide("approve", { userCode: device.user_code, transaction: view.transaction }, { ...owner, origin })

    const hostile = await decide("https://evil.example.test")
    expect(hostile.status).toBe(403)
    expect(await (await grant().exchange(device.device_code)).json()).toMatchObject({ error: "authorization_pending" })
    const exact = await decide(APP)
    expect(exact.status, await exact.clone().text()).toBe(200)
  })

  test("the device grant needs the client the descriptor names", async () => {
    const anonymous = await request("/api/auth/device/code", json({}))
    expect(anonymous.status).toBe(400)
    expect(await anonymous.json()).toMatchObject({ error_description: "client_id is required" })
    const impostor = await request("/api/auth/device/code", json({ client_id: "someone-else", scope: "openid", resource: CONTROL_PLANE_RESOURCE }))
    expect(impostor.status).not.toBe(200)
    expect(rig.descriptor.native.cli).toMatchObject({
      flow: "device-authorization", clientId: BETTER_AUTH_CLI_CLIENT_ID, resource: CONTROL_PLANE_RESOURCE, scopes: BETTER_AUTH_NATIVE_SCOPES,
    })
  })

  test("a browser session cannot mint a self-contained JWT for the control plane", async () => {
    const owner = await signIn("jwt-mint@device-login.test")

    for (const path of ["/api/auth/token", "/api/auth/jwks"]) {
      const minted = await request(path, { headers: { cookie: owner.cookie } })
      expect(minted.status, `${path}: ${await minted.clone().text()}`).toBe(404)
    }
  })

  test("a client that registered itself cannot obtain a user code to phish an approval with", async () => {
    const registered = await request("/api/auth/oauth2/register", json({
      client_name: "Terminal helper", grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      token_endpoint_auth_method: "none", application_type: "native",
    }))
    expect(registered.status, await registered.clone().text()).toBe(201)
    const clientId = ((await registered.json()) as { client_id: string }).client_id

    const asked = await request("/api/auth/device/code", json({
      client_id: clientId, scope: "claxedo:read claxedo:act claxedo:approve offline_access", resource: MCP_RESOURCE,
    }))
    expect(asked.status, await asked.clone().text()).toBe(400)
    expect(await asked.json()).toMatchObject({ error: "invalid_client" })
  })

  test("a token an MCP host obtained for the MCP resource is not a control-plane credential", async () => {
    const owner = await signIn("mcp-host-owner@device-login.test")
    const { access_token } = await mcpGrant(owner, 51789)
    expect((await enrollments(access_token)).status).toBe(401)
    expect((await enrollments("not-a-token")).status).toBe(401)
  })

  test("a password reset ends the person's MCP grants along with their sessions", async () => {
    const email = "mcp-reset@device-login.test"
    const owner = await signIn(email)
    const mcp = await mcpGrant(owner, 51791)

    expect((await request("/api/auth/request-password-reset", json({ email, redirectTo: `${APP}/reset-password` }))).status).toBe(200)
    const token = rig.mail.findLast((message) => message.recipient === email && message.kind === "password-reset")?.token
    if (!token) throw new Error(`no password-reset mail for ${email}`)
    const reset = await request("/api/auth/reset-password", json({ token, newPassword: "a-brand-new-correct-horse" }))
    expect(reset.status, await reset.clone().text()).toBe(200)

    expect((await refreshMcp(mcp)).status).toBe(400)
    expect(await oauthTokenRows(mcp.clientId)).toEqual({ access: 0, refresh: 0 })
  })

  test("signing out everywhere ends the person's MCP grants and leaves another person's", async () => {
    const owner = await signIn("mcp-revoke@device-login.test")
    const bystander = await signIn("mcp-bystander@device-login.test")
    const mcp = await mcpGrant(owner, 51792)
    const kept = await mcpGrant(bystander, 51793)

    const revoked = await request("/api/auth/revoke-sessions", json({}, owner))
    expect(revoked.status, await revoked.clone().text()).toBe(200)

    expect((await refreshMcp(mcp)).status).toBe(400)
    expect(await oauthTokenRows(mcp.clientId)).toEqual({ access: 0, refresh: 0 })
    expect((await refreshMcp(kept)).status).toBe(200)
  })

  test("every desktop authorization shows the consent screen, even to a person who consented before", async () => {
    const owner = await signIn("desktop-consent@device-login.test")
    const authorize = (port: number, prompt?: string) => request(`/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id: BETTER_AUTH_DESKTOP_CLIENT_ID, redirect_uri: `http://127.0.0.1:${port}/claxedo/auth/callback`, response_type: "code",
      scope: BETTER_AUTH_NATIVE_SCOPES.join(" "), resource: CONTROL_PLANE_RESOURCE, state: "s",
      code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"), code_challenge_method: "S256",
      ...(prompt ? { prompt } : {}),
    })}`, { headers: { cookie: owner.cookie }, redirect: "manual" })
    const consentPage = `${APP}/oauth/consent?`

    const first = await authorize(51801)
    expect(first.headers.get("location")?.startsWith(consentPage), first.headers.get("location") ?? "").toBe(true)
    const consented = await request("/api/auth/oauth2/consent", json(
      { accept: true, oauth_query: new URL(first.headers.get("location") ?? "", API).search }, owner,
    ))
    expect(consented.status, await consented.clone().text()).toBe(200)
    expect(new URL(((await consented.json()) as { url: string }).url).searchParams.get("code")).toMatch(/\S/)

    const replay = (await authorize(51802)).headers.get("location") ?? ""
    expect(replay.startsWith(consentPage), replay).toBe(true)
    const silent = new URL((await authorize(51803, "none")).headers.get("location") ?? "", API)
    expect(silent.searchParams.get("code"), silent.toString()).toBeNull()
    expect(silent.searchParams.get("error")).toBe("invalid_request")
  })

  test("the device grant cannot be pre-bound to a person by whoever requests it", async () => {
    const victim = await signIn("prebound@device-login.test")
    const victimId = ((await (await request("/api/auth/get-session", { headers: victim })).json()) as { user: { id: string } }).user.id
    const base = { client_id: BETTER_AUTH_CLI_CLIENT_ID, scope: BETTER_AUTH_NATIVE_SCOPES.join(" "), resource: CONTROL_PLANE_RESOURCE }
    const attempts = {
      json: await request("/api/auth/device/code", json({ ...base, user_id: victimId })),
      form: await request("/api/auth/device/code", form({ ...base, user_id: victimId })),
      repeated: await request("/api/auth/device/code", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `${new URLSearchParams(base)}&user_id=${encodeURIComponent(victimId)}&user_id=`,
      }),
    }
    for (const [shape, response] of Object.entries(attempts)) {
      expect(response.status, `${shape}: ${await response.clone().text()}`).toBe(400)
      expect(await response.json()).toMatchObject({ error: "invalid_request" })
    }
    expect((await grant().requestCode()).user_code).toMatch(/\S/)
  })

  test("an unauthenticated client may not send codes to an arbitrary https host or borrow this deployment's name", async () => {
    const register = (metadata: Record<string, unknown>) => request("/api/auth/oauth2/register", json({
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", ...metadata,
    }))
    const phishing = await register({ client_name: "Fixture MCP host", redirect_uris: ["https://evil.example/cb"] })
    expect(phishing.status).toBe(400)
    expect(await phishing.json()).toMatchObject({ error: "invalid_redirect_uri" })
    const smuggled = await register({
      client_name: "Fixture MCP host", redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"],
    })
    expect(smuggled.status).toBe(400)
    const impostor = await register({
      client_name: "Claxedo Desktop", redirect_uris: ["http://127.0.0.1:51790/callback"], application_type: "native",
    })
    expect(impostor.status).toBe(400)
    expect(await impostor.json()).toMatchObject({ error: "invalid_client_metadata" })
    const hosted = await register({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })
    expect(hosted.status, await hosted.clone().text()).toBe(201)
  })

  test("one address may register five clients a minute and no more", async () => {
    const register = (address: string) => request("/api/auth/oauth2/register", json({
      client_name: "Fixture MCP host", redirect_uris: ["http://127.0.0.1:51792/callback"], grant_types: ["authorization_code"],
      response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native",
    }, { "cf-connecting-ip": address }))
    for (let attempt = 0; attempt < 5; attempt++) expect((await register("203.0.113.7")).status).toBe(201)
    expect((await register("203.0.113.7")).status).toBe(429)
    expect((await register("203.0.113.8")).status).toBe(201)
  })
})
