import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import type { Hono } from "hono"
import { createDefaultLocalControlPlaneServices, createSelfHostedApp } from "./app"
import { nativeAccessTokenSubject, resetEmbeddedAuthForTests } from "./embedded-auth"
import { embeddedBrowserAuthDescriptor } from "./embedded-browser-auth"
import { BETTER_AUTH_NATIVE_SCOPES } from "../../platform/auth/better-auth-d1-foundation"
import { BETTER_AUTH_CLI_CLIENT_ID } from "../../platform/auth/better-auth-native-clients"
import { DEVICE_GRANT, deviceGrant } from "../../test-support/device-grant"

/**
 * `claxedo login` against the self-hosted node, end to end through the routes
 * the CLI calls: the RFC 8628 device grant the box's own Better Auth serves
 * for the `claxedo-cli` client its descriptor advertises, the owner's
 * approval, the token exchange, and that access token spent on a signed
 * control-plane route. The hosted D1 plane proves the same flow in
 * better-auth-d1-worker-spike.test.ts; this is the other composition.
 */

const ORIGIN = "http://localhost:2593"
const ISSUER = `${ORIGIN}/api/auth`
const CONTROL_PLANE_RESOURCE = `${ORIGIN}/control-plane`
const MCP_RESOURCE = `${ORIGIN}/api/claxedo/mcp`

let dataDir: string
let savedEnv: Record<string, string | undefined>
let app: Hono
let services: ReturnType<typeof createDefaultLocalControlPlaneServices>
let composed: ReturnType<typeof createSelfHostedApp>

beforeAll(async () => {
  savedEnv = {
    CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
    CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
    CLAXEDO_EMBEDDED_AUTH: process.env.CLAXEDO_EMBEDDED_AUTH,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  }
  dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-device-login-"))
  process.env.CLAXEDO_DATA_DIR = dataDir
  process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
  process.env.CLAXEDO_EMBEDDED_AUTH = "1"
  delete process.env.BETTER_AUTH_URL
  resetEmbeddedAuthForTests()
  services = createDefaultLocalControlPlaneServices()
  composed = createSelfHostedApp(services)
  app = composed.app
}, 60_000)

afterAll(async () => {
  await composed.dispose()
  services.close()
  const { closeAuthorityDatabases } = await import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store")
  closeAuthorityDatabases()
  resetEmbeddedAuthForTests()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const request = (pathname: string, init?: RequestInit) => app.request(new URL(pathname, ORIGIN).toString(), init)

const form = (body: Record<string, string>, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() })

const json = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

async function signUpResponse(email: string) {
  const response = await request("/api/auth/sign-up/email", json({ email, password: "correct-horse-battery", name: "Box Owner" }))
  expect(response.status).toBe(200)
  return response
}

async function signUp(email: string) {
  const token = (await signUpResponse(email)).headers.get("set-auth-token")
  if (!token) throw new Error("the embedded issuer minted no session token")
  return token
}

/** The session cookie a sign-up sets over this plain-HTTP public origin, as a browser would carry it back. */
async function signUpCookie(email: string) {
  const header = (await signUpResponse(email)).headers.getSetCookie().find((value) => value.startsWith("claxedo.session_token="))
  if (!header) throw new Error("the embedded issuer set no session cookie")
  return header.split(";", 1)[0]
}

const grant = () => deviceGrant(app, ORIGIN)
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

const enrollments = (bearer: string) => request("/api/claxedo/host/enrollments", { headers: { authorization: `Bearer ${bearer}` } })

describe("claxedo login on the self-hosted node", () => {
  test("device code → owner approves → token exchange → the access token reaches a signed route; refresh and revoke follow it", async () => {
    const owner = await signUp("owner@device-login.test")

    const device = await grant().requestCode()
    expect(device.verification_uri).toBe(`${ORIGIN}/device`)
    expect(device.user_code).toMatch(/\S/)
    expect(device.interval).toBe(5)
    expect(device.expires_in).toBe(600)

    const pending = await grant().exchange(device.device_code)
    expect(pending.status).toBe(400)
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" })
    // Polling again inside the interval is refused; the CLI waits it out.
    const hasty = await grant().exchange(device.device_code)
    expect(hasty.status).toBe(400)
    expect(await hasty.json()).toMatchObject({ error: "slow_down" })
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (device.interval + 1) * 1000 })

    // The `/device` page: the signed-in owner looks the code up (which claims
    // it for their user and mints the transaction only they were shown), then
    // approves that transaction.
    const claimed = await grant().viewed(device.user_code, bearer(owner))
    expect(claimed).toMatchObject({ user_code: device.user_code, status: "pending", client_id: BETTER_AUTH_CLI_CLIENT_ID })
    expect(claimed.transaction).toMatch(/^[0-9a-f]{64}$/)
    const approved = await grant().decide("approve", { userCode: device.user_code, transaction: claimed.transaction }, bearer(owner))
    expect(approved.status, await approved.clone().text()).toBe(200)

    const exchanged = await grant().exchange(device.device_code)
    expect(exchanged.status, await exchanged.clone().text()).toBe(200)
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number }
    expect(tokens.token_type).toBe("Bearer")
    expect(tokens.refresh_token).toMatch(/\S/)
    expect(tokens.expires_in).toBe(300)

    const listed = await enrollments(tokens.access_token)
    expect(listed.status, await listed.clone().text()).toBe(200)

    // The CLI's "Signed in as …" line and `whoami` read this.
    const who = await request("/api/auth/oauth2/userinfo", { headers: { authorization: `Bearer ${tokens.access_token}` } })
    expect(who.status, await who.clone().text()).toBe(200)
    expect(await who.json()).toMatchObject({ email: "owner@device-login.test" })

    // A second exchange of the same device code is a replay.
    expect((await grant().exchange(device.device_code)).status).toBe(400)

    const refreshed = await request("/api/auth/oauth2/token", form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: BETTER_AUTH_CLI_CLIENT_ID,
      resource: CONTROL_PLANE_RESOURCE,
    }))
    expect(refreshed.status, await refreshed.clone().text()).toBe(200)
    const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string }
    expect(rotated.access_token).not.toBe(tokens.access_token)
    expect((await enrollments(rotated.access_token)).status).toBe(200)

    const revoked = await request("/api/auth/oauth2/revoke", form({ token: rotated.access_token, client_id: BETTER_AUTH_CLI_CLIENT_ID }))
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    expect((await enrollments(rotated.access_token)).status).toBe(401)
    vi.useRealTimers()
  })

  test("a decision is refused unless it carries the transaction of the request the approver was shown", async () => {
    const owner = await signUp("transaction@device-login.test")
    const first = await grant().requestCode()
    const second = await grant().requestCode()

    const firstView = await grant().viewed(first.user_code, bearer(owner))
    const secondView = await grant().viewed(second.user_code, bearer(owner))

    const refusals = {
      absent: await grant().decide("approve", { userCode: second.user_code }, bearer(owner)),
      stale: await grant().decide("approve", { userCode: second.user_code, transaction: firstView.transaction }, bearer(owner)),
      guessed: await grant().decide("approve", { userCode: second.user_code, transaction: "0".repeat(64) }, bearer(owner)),
    }
    for (const [reason, response] of Object.entries(refusals)) {
      expect(response.status, `${reason}: ${await response.clone().text()}`).toBe(403)
      expect(await response.json()).toMatchObject({ error: "access_denied" })
    }
    expect(firstView.transaction).toMatch(/^[0-9a-f]{64}$/)
    expect(secondView.transaction).not.toBe(firstView.transaction)
    // A refused decision spends nothing: the CLI is still polling this request.
    expect(await (await grant().exchange(second.device_code)).json()).toMatchObject({ error: "authorization_pending" })

    const approved = await grant().decide("approve", { userCode: second.user_code, transaction: secondView.transaction }, bearer(owner))
    expect(approved.status, await approved.clone().text()).toBe(200)

    const crossedDeny = await grant().decide("deny", { userCode: first.user_code, transaction: secondView.transaction }, bearer(owner))
    expect(crossedDeny.status).toBe(403)
    const denied = await grant().decide("deny", { userCode: first.user_code, transaction: firstView.transaction }, bearer(owner))
    expect(denied.status, await denied.clone().text()).toBe(200)
  })

  test("the transaction reaches only the user who owns the request, and does not travel to another session", async () => {
    const owner = await signUp("owner@transaction-holder.test")
    const intruder = await signUp("intruder@transaction-holder.test")
    const device = await grant().requestCode()

    const ownerView = await grant().viewed(device.user_code, bearer(owner))
    expect(ownerView.transaction).toMatch(/^[0-9a-f]{64}$/)

    const intruderView = await grant().viewed(device.user_code, bearer(intruder))
    expect(intruderView).toEqual({ user_code: device.user_code, status: "pending" })

    const stolen = await grant().decide("approve", { userCode: device.user_code, transaction: ownerView.transaction }, bearer(intruder))
    expect(stolen.status).toBe(403)
    expect(await (await grant().exchange(device.device_code)).json()).toMatchObject({ error: "authorization_pending" })
  })

  test("no GET or HEAD approves, denies or consumes a device request", async () => {
    const owner = await signUp("read-only@device-login.test")
    const device = await grant().requestCode()
    const view = await grant().viewed(device.user_code, bearer(owner))

    const decision = new URLSearchParams({ userCode: device.user_code, transaction: view.transaction ?? "" })
    for (const kind of ["approve", "deny"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await grant().request(`/api/auth/device/${kind}?${decision}`, { method, headers: bearer(owner) })
        expect(response.status, `${method} /api/auth/device/${kind}`).toBe(404)
      }
    }
    const readBack = await grant().request(`/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`, {
      method: "HEAD",
      headers: bearer(owner),
    })
    expect(readBack.status).toBe(404)

    const exchangeQuery = new URLSearchParams({
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
      client_id: BETTER_AUTH_CLI_CLIENT_ID,
      resource: `${ORIGIN}/control-plane`,
    })
    const readExchange = await grant().request(`/api/auth/oauth2/token?${exchangeQuery}`, { method: "GET" })
    expect(readExchange.status).not.toBe(200)

    expect(await grant().viewed(device.user_code, bearer(owner))).toMatchObject({ status: "pending" })
    expect(await (await grant().exchange(device.device_code)).json()).toMatchObject({ error: "authorization_pending" })
  })

  test("a cookie-bearing approval is refused from a second localhost origin and accepted from the exact public one", async () => {
    const cookie = await signUpCookie("hostile-origin@device-login.test")
    const device = await grant().requestCode()
    const view = await grant().viewed(device.user_code, { cookie })

    const decide = (origin: string) =>
      grant().decide("approve", { userCode: device.user_code, transaction: view.transaction }, { cookie, origin })

    const hostile = await decide("http://localhost:9999")
    expect(hostile.status).toBe(403)
    expect(await hostile.json()).toMatchObject({ code: "INVALID_ORIGIN" })
    expect(await (await grant().exchange(device.device_code)).json()).toMatchObject({ error: "authorization_pending" })

    const exact = await decide(ORIGIN)
    expect(exact.status, await exact.clone().text()).toBe(200)
  })

  test("the device grant needs the client the descriptor names; an unknown or absent client is refused before any code exists", async () => {
    const anonymous = await request("/api/auth/device/code", json({}))
    expect(anonymous.status).toBe(400)
    expect(await anonymous.json()).toMatchObject({ error_description: "client_id is required" })

    const impostor = await request("/api/auth/device/code", json({ client_id: "someone-else", scope: "openid", resource: CONTROL_PLANE_RESOURCE }))
    expect(impostor.status).not.toBe(200)
  })

  test("a token an MCP host obtained for the MCP resource is not a control-plane credential", async () => {
    const owner = await signUp("mcp-host-owner@device-login.test")
    const redirect = "http://127.0.0.1:51789/callback"
    const registered = await request("/api/auth/oauth2/register", json({
      client_name: "Fixture MCP host",
      redirect_uris: [redirect],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }))
    expect(registered.status).toBe(201)
    const clientId = ((await registered.json()) as { client_id: string }).client_id
    const verifier = randomBytes(32).toString("base64url")
    const asked = await request(`/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: "claxedo:read",
      resource: MCP_RESOURCE,
      state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })}`, { headers: { authorization: `Bearer ${owner}` }, redirect: "manual" })
    expect(asked.status).toBe(302)
    const consented = await request("/api/auth/oauth2/consent", json(
      { accept: true, oauth_query: new URL(asked.headers.get("location") ?? "", ORIGIN).search, scope: "claxedo:read" },
      { authorization: `Bearer ${owner}` },
    ))
    expect(consented.status, await consented.clone().text()).toBe(200)
    const code = new URL(((await consented.json()) as { url: string }).url).searchParams.get("code")
    if (!code) throw new Error("consent redirected without a code")
    const exchanged = await request("/api/auth/oauth2/token", form({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_RESOURCE,
    }))
    expect(exchanged.status).toBe(200)
    const { access_token } = (await exchanged.json()) as { access_token: string }

    expect((await enrollments(access_token)).status).toBe(401)
    expect((await enrollments("not-a-token")).status).toBe(401)
  })

  test("the descriptor the CLI reads names the client, resource and scopes the box registered", () => {
    const descriptor = embeddedBrowserAuthDescriptor({ env: { BETTER_AUTH_URL: "https://box.example.test" } })
    expect(descriptor?.native.cli).toMatchObject({
      flow: "device-authorization",
      clientId: BETTER_AUTH_CLI_CLIENT_ID,
      resource: "https://box.example.test/control-plane",
      scopes: BETTER_AUTH_NATIVE_SCOPES,
      tokenEndpointOrigin: "https://box.example.test",
    })
    expect(descriptor?.issuer).toBe("https://box.example.test/api/auth")
  })
})

describe("nativeAccessTokenSubject", () => {
  const expected = { issuer: ISSUER, resource: CONTROL_PLANE_RESOURCE }
  const active = { active: true, iss: ISSUER, token_type: "Bearer", sub: "user_1", client_id: BETTER_AUTH_CLI_CLIENT_ID, aud: CONTROL_PLANE_RESOURCE, sid: "sess_1" }

  test("accepts a native client's token for this control plane", () => {
    expect(nativeAccessTokenSubject(active, expected)).toEqual({ subject: "user_1", tokenIdentifier: "sess_1" })
    expect(nativeAccessTokenSubject({ ...active, client_id: "claxedo-desktop", aud: [CONTROL_PLANE_RESOURCE, `${ISSUER}/oauth2/userinfo`] }, expected))
      .toMatchObject({ subject: "user_1" })
  })

  test("refuses everything else", () => {
    expect(nativeAccessTokenSubject({ ...active, active: false }, expected)).toBeUndefined()
    expect(nativeAccessTokenSubject({ ...active, iss: "https://elsewhere.test/api/auth" }, expected)).toBeUndefined()
    expect(nativeAccessTokenSubject({ ...active, client_id: "dyn_mcp_host" }, expected)).toBeUndefined()
    expect(nativeAccessTokenSubject({ ...active, aud: MCP_RESOURCE }, expected)).toBeUndefined()
    expect(nativeAccessTokenSubject({ ...active, sub: "" }, expected)).toBeUndefined()
    expect(nativeAccessTokenSubject({ ...active, token_type: "DPoP" }, expected)).toBeUndefined()
    expect(nativeAccessTokenSubject(undefined, expected)).toBeUndefined()
  })
})
