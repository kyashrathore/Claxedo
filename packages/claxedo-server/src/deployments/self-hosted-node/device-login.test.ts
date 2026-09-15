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
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"

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

async function signUp(email: string) {
  const response = await request("/api/auth/sign-up/email", json({ email, password: "correct-horse-battery", name: "Box Owner" }))
  expect(response.status).toBe(200)
  const token = response.headers.get("set-auth-token")
  if (!token) throw new Error("the embedded issuer minted no session token")
  return token
}

type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }

/** What `claxedo login` sends: the descriptor's client, scopes and resource. */
async function requestDeviceCode() {
  const response = await request("/api/auth/device/code", json({
    client_id: BETTER_AUTH_CLI_CLIENT_ID,
    scope: BETTER_AUTH_NATIVE_SCOPES.join(" "),
    resource: CONTROL_PLANE_RESOURCE,
  }))
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as DeviceCode
}

function exchangeDeviceCode(deviceCode: string) {
  return request("/api/auth/oauth2/token", form({
    grant_type: DEVICE_GRANT,
    device_code: deviceCode,
    client_id: BETTER_AUTH_CLI_CLIENT_ID,
    resource: CONTROL_PLANE_RESOURCE,
  }))
}

const enrollments = (bearer: string) => request("/api/claxedo/host/enrollments", { headers: { authorization: `Bearer ${bearer}` } })

describe("claxedo login on the self-hosted node", () => {
  test("device code → owner approves → token exchange → the access token reaches a signed route; refresh and revoke follow it", async () => {
    const owner = await signUp("owner@device-login.test")

    const device = await requestDeviceCode()
    expect(device.verification_uri).toBe(`${ORIGIN}/device`)
    expect(device.user_code).toMatch(/\S/)
    expect(device.interval).toBe(5)
    expect(device.expires_in).toBe(600)

    const pending = await exchangeDeviceCode(device.device_code)
    expect(pending.status).toBe(400)
    expect(await pending.json()).toMatchObject({ error: "authorization_pending" })
    // Polling again inside the interval is refused; the CLI waits it out.
    const hasty = await exchangeDeviceCode(device.device_code)
    expect(hasty.status).toBe(400)
    expect(await hasty.json()).toMatchObject({ error: "slow_down" })
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + (device.interval + 1) * 1000 })

    // The `/device` page: the signed-in owner looks the code up (which claims
    // it for their session) and then approves it.
    const claimed = await request(`/api/auth/device?user_code=${encodeURIComponent(device.user_code)}`, {
      headers: { authorization: `Bearer ${owner}` },
    })
    expect(claimed.status, await claimed.clone().text()).toBe(200)
    expect(await claimed.json()).toMatchObject({ user_code: device.user_code, status: "pending", client_id: BETTER_AUTH_CLI_CLIENT_ID })
    const approved = await request("/api/auth/device/approve", json({ userCode: device.user_code }, { authorization: `Bearer ${owner}` }))
    expect(approved.status, await approved.clone().text()).toBe(200)

    const exchanged = await exchangeDeviceCode(device.device_code)
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
    expect((await exchangeDeviceCode(device.device_code)).status).toBe(400)

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
