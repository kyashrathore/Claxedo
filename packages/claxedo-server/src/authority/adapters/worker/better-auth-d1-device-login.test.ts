import { createHash, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import type { AuthEmailMessage } from "../../../platform/auth/better-auth-configuration"
import { composeBetterAuthD1UserDeployedControlPlane } from "./better-auth-d1-compose"
import { createHostedCoreApp } from "../../../deployments/hosted-shared/hosted-core-app"
import { createIdempotencyCoordinator, memoryIdempotencyStore } from "../../http/idempotency"
import { BETTER_AUTH_NATIVE_SCOPES } from "../../../platform/auth/better-auth-d1-foundation"
import {
  BETTER_AUTH_CLI_CLIENT_ID,
  betterAuthIntrospectionClientSecretCiphertext,
  betterAuthNativeClientProvisioningStatements,
} from "../../../platform/auth/better-auth-native-clients"
import { DEVICE_GRANT, deviceGrant } from "../../../test-support/device-grant"
import { miniflareControlPlaneDatabase } from "../../../test-support/control-plane-migrations"
import { generateCanonicalOwnerClaim, ownerClaimMutationSql, ownerClaimProvisioning } from "../../../../scripts/deploy/claim-owner"
import { USER_DEPLOYED_OWNER_CLAIM_HEADER } from "../d1/owner-identity"

/**
 * `claxedo login` against the Better Auth + D1 composition the Worker serves:
 * the RFC 8628 device grant for the `claxedo-cli` client the descriptor
 * advertises, the signed-in person's approval on `/device`, the token
 * exchange, and that access token spent on a signed control-plane route.
 */

const API = "https://api.example.test"
const APP = "https://app.example.test"
const CONTROL_PLANE_RESOURCE = `${API}/control-plane`
const MCP_RESOURCE = `${API}/api/claxedo/mcp`
const AUTH_MIGRATIONS = ["0001_better_auth.sql", "0003_authentication_evidence.sql"]
const BETTER_AUTH_SECRET = "better-auth-secret-that-is-at-least-thirty-two-bytes"
const INTROSPECTION_SECRET = "introspection-secret-that-is-also-at-least-thirty-two-bytes"

let instance: Miniflare
let disposeControlPlane: () => Promise<void>
let controlPlaneDatabase: D1Database
let app: Hono
let descriptor: ReturnType<typeof composeBetterAuthD1UserDeployedControlPlane>["options"]["authentication"]["descriptor"]
const mail: AuthEmailMessage[] = []

async function migrateAuth(database: D1Database) {
  for (const name of AUTH_MIGRATIONS) {
    const sql = (await readFile(fileURLToPath(new URL(`../../../../migrations/auth/${name}`, import.meta.url)), "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of sql.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) await database.prepare(statement).run()
  }
}

beforeAll(async () => {
  instance = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: "2025-05-01", d1Databases: ["AUTH_DB"] })
  const authDatabase = await instance.getD1Database("AUTH_DB")
  await migrateAuth(authDatabase)
  const ciphertext = await betterAuthIntrospectionClientSecretCiphertext(BETTER_AUTH_SECRET, INTROSPECTION_SECRET)
  for (const sql of betterAuthNativeClientProvisioningStatements(API, ciphertext)) await authDatabase.prepare(sql).run()
  const controlPlane = await miniflareControlPlaneDatabase()
  const keys = await generateKeyPair("EdDSA", { extractable: true })
  disposeControlPlane = () => controlPlane.dispose()
  controlPlaneDatabase = controlPlane.database
  const composed = composeBetterAuthD1UserDeployedControlPlane({
    env: {
      CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
      CLAXEDO_PRODUCT_POSTURE: "user-deployed",
      CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
      CLAXEDO_DEPLOYMENT_ID: "deployment-1",
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_AUTH_METHODS: "email-password",
      CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth-configuration",
      BETTER_AUTH_URL: API,
      CLAXEDO_APP_ORIGIN: APP,
      BETTER_AUTH_SECRET,
      CLAXEDO_AUTH_INTROSPECTION_SECRET: INTROSPECTION_SECRET,
      CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(keys.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(keys.publicKey),
    },
    emailSender: { send: async (message) => { mail.push(message) } },
    authDatabase,
    controlPlaneDatabase: controlPlane.database,
    descriptorExpiresAt: Date.now() + 3_600_000,
    product: { kind: "user-deployed", organization: { id: "org_deployment", name: "Deployment" }, ownerBootstrap: "one-use-claim" },
  })
  await composed.authReady
  descriptor = composed.options.authentication.descriptor
  const core = createHostedCoreApp(composed.plane, {
    ...composed.options,
    idempotency: createIdempotencyCoordinator(memoryIdempotencyStore()),
    liveSyncRoom: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) },
    sharedRateLimitStore: { periodSeconds: 60, check: async () => ({ allowed: true }) },
  })
  let requests = 0
  app = new Hono()
  // The Cloudflare edge stamps every request with its client address, and Better Auth budgets each address.
  app.use((c, next) => {
    c.req.raw.headers.set("cf-connecting-ip", `10.0.${Math.floor(++requests / 250)}.${requests % 250}`)
    return next()
  })
  app.all("/api/auth/*", (c) => composed.authHandler(c.req.raw))
  app.all("*", (c) => core.fetch(c.req.raw))
}, 60_000)

afterAll(async () => {
  await instance?.dispose()
  await disposeControlPlane?.()
})

const request = (pathname: string, init?: RequestInit) => app.request(new URL(pathname, API).toString(), init)
const grant = () => deviceGrant(app, API)
const form = (body: Record<string, string>) =>
  ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() })
const json = (body: unknown, headers: Record<string, string> = {}) =>
  ({ method: "POST", headers: { "content-type": "application/json", origin: APP, ...headers }, body: JSON.stringify(body) })
const enrollments = (token: string) => request("/api/claxedo/host/enrollments", { headers: { authorization: `Bearer ${token}` } })

/** A verified person's session cookie plus the app origin a browser sends with it. */
async function signIn(email: string) {
  const password = "correct-horse-battery-staple"
  expect((await request("/api/auth/sign-up/email", json({ email, password, name: email }))).status).toBe(200)
  const verification = mail.findLast((message) => message.recipient === email)?.actionUrl
  if (!verification) throw new Error(`no verification mail for ${email}`)
  expect([200, 302]).toContain((await app.request(verification)).status)
  const signedIn = await request("/api/auth/sign-in/email", json({ email, password }))
  const cookie = /__Secure-claxedo\.session_token=[^;]+/.exec(signedIn.headers.get("set-cookie") ?? "")?.[0]
  if (!cookie) throw new Error(`sign-in set no session cookie: ${signedIn.status} ${await signedIn.text()}`)
  return { cookie, origin: APP }
}

/** The deployer's `claim-owner` step: register a one-use claim for the signed-in account and redeem it. */
async function claimOwnership(person: { cookie: string; origin: string }) {
  const session = await request("/api/auth/get-session", { headers: person })
  const subject = ((await session.json()) as { user: { id: string } }).user.id
  const claim = generateCanonicalOwnerClaim()
  await controlPlaneDatabase.prepare(ownerClaimMutationSql(await ownerClaimProvisioning({ deploymentId: "deployment-1", apiOrigin: API, subject, claim }))).run()
  const redeemed = await request("/api/claxedo/auth/bootstrap-owner", json({}, { ...person, [USER_DEPLOYED_OWNER_CLAIM_HEADER]: claim }))
  expect(redeemed.status, await redeemed.clone().text()).toBe(200)
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
    expect(descriptor.native.cli).toMatchObject({
      flow: "device-authorization", clientId: BETTER_AUTH_CLI_CLIENT_ID, resource: CONTROL_PLANE_RESOURCE, scopes: BETTER_AUTH_NATIVE_SCOPES,
    })
  })

  test("a token an MCP host obtained for the MCP resource is not a control-plane credential", async () => {
    const owner = await signIn("mcp-host-owner@device-login.test")
    const redirect = "http://127.0.0.1:51789/callback"
    const registered = await request("/api/auth/oauth2/register", json({
      client_name: "Fixture MCP host", redirect_uris: [redirect], grant_types: ["authorization_code"],
      response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native",
    }))
    expect(registered.status, await registered.clone().text()).toBe(201)
    const clientId = ((await registered.json()) as { client_id: string }).client_id
    const verifier = randomBytes(32).toString("base64url")
    const asked = await request(`/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: "code", scope: "claxedo:read", resource: MCP_RESOURCE, state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    })}`, { headers: { cookie: owner.cookie }, redirect: "manual" })
    expect(asked.status).toBe(302)
    const consented = await request("/api/auth/oauth2/consent", json(
      { accept: true, oauth_query: new URL(asked.headers.get("location") ?? "", API).search, scope: "claxedo:read" }, owner,
    ))
    expect(consented.status, await consented.clone().text()).toBe(200)
    const code = new URL(((await consented.json()) as { url: string }).url).searchParams.get("code")
    if (!code) throw new Error("consent redirected without a code")
    const exchanged = await request("/api/auth/oauth2/token", form({
      grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: MCP_RESOURCE,
    }))
    expect(exchanged.status, await exchanged.clone().text()).toBe(200)
    const { access_token } = (await exchanged.json()) as { access_token: string }
    expect((await enrollments(access_token)).status).toBe(401)
    expect((await enrollments("not-a-token")).status).toBe(401)
  })
})
