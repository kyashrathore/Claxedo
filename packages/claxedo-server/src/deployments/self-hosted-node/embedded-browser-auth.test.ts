import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import {
  embeddedBrowserAuthDescriptor,
  embeddedBrowserAuthSecurity,
  embeddedBrowserSessionBearer,
} from "./embedded-browser-auth"
import { createDefaultLocalControlPlaneServices, createSelfHostedApp } from "./app"
import { resetEmbeddedAuthForTests } from "./embedded-auth"
import { deviceGrant } from "../../test-support/device-grant"

const ORIGIN = "https://localhost:4449"
const env = { BETTER_AUTH_URL: ORIGIN } as NodeJS.ProcessEnv

function app() {
  const descriptor = embeddedBrowserAuthDescriptor({ env, now: () => 1_000 })!
  const routes = new Hono()
  routes.use("/api/*", embeddedBrowserAuthSecurity(descriptor))
  routes.use("/api/*", embeddedBrowserSessionBearer(descriptor))
  routes.all("/api/echo", (c) => c.json({ authorization: c.req.raw.headers.get("authorization") }))
  return { descriptor, routes }
}

describe("embedded browser auth", () => {
  test("describes the embedded issuer in the contract the web client validates", () => {
    const descriptor = embeddedBrowserAuthDescriptor({ env, now: () => 1_000 })
    expect(descriptor).toMatchObject({
      adapter: "better-auth",
      issuer: `${ORIGIN}/api/auth`,
      methods: ["email-password"],
      expiresAt: 1_000 + 365 * 24 * 60 * 60_000,
      browser: {
        transport: "cookie",
        credentialPolicy: "reject-cookie-and-authorization",
        trustedOrigins: [ORIGIN],
        resource: `${ORIGIN}/control-plane`,
        cookie: { name: "__Secure-claxedo.session_token", path: "/", secure: true, httpOnly: true, hostOnly: true, sameSite: "lax" },
      },
    })
    expect(new URL(descriptor!.browser.resource).origin).toBe(ORIGIN)
  })

  test("serves no browser descriptor over a plain-HTTP public origin", () => {
    expect(embeddedBrowserAuthDescriptor({ env: { BETTER_AUTH_URL: "http://localhost:2597" } as NodeJS.ProcessEnv })).toBeUndefined()
    expect(embeddedBrowserAuthDescriptor({ env: {} as NodeJS.ProcessEnv })).toBeUndefined()
  })

  test("presents the exact session cookie as the bearer credential, and only when no bearer was sent", async () => {
    const { routes } = app()
    const cookie = "__Secure-claxedo.session_token=tok.sig; other=1"
    const bridged = await routes.request("https://localhost:4449/api/echo", { headers: { cookie } })
    expect(await bridged.json()).toEqual({ authorization: "Bearer tok.sig" })
    const explicit = await routes.request("https://localhost:4449/api/echo", { headers: { authorization: "Bearer other" } })
    expect(await explicit.json()).toEqual({ authorization: "Bearer other" })
    const lookalike = await routes.request("https://localhost:4449/api/echo", { headers: { cookie: "x__Secure-claxedo.session_token=nope" } })
    expect(await lookalike.json()).toEqual({ authorization: null })
  })

  test("rejects a request carrying both the session cookie and a bearer, matching or not", async () => {
    const { routes } = app()
    for (const authorization of ["Bearer other", "Bearer tok.sig"]) {
      const res = await routes.request("https://localhost:4449/api/echo", {
        headers: { cookie: "__Secure-claxedo.session_token=tok.sig", authorization },
      })
      expect(res.status, authorization).toBe(401)
      expect(await res.json()).toEqual({
        error: { code: "ambiguous_credentials", message: "Multiple authentication credentials are not accepted" },
      })
    }
    // A lookalike cookie name is not the session credential: bearer alone passes.
    const lookalike = await routes.request("https://localhost:4449/api/echo", {
      headers: { cookie: "x__Secure-claxedo.session_token=nope", authorization: "Bearer other" },
    })
    expect(await lookalike.json()).toEqual({ authorization: "Bearer other" })
  })

  test("refuses a cookie-authenticated mutation without a JSON content type or from another site", async () => {
    const { routes } = app()
    const cookie = "__Secure-claxedo.session_token=tok.sig"
    const noType = await routes.request("https://localhost:4449/api/echo", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin" },
      body: "{}",
    })
    expect(noType.status).toBe(415)
    const crossSite = await routes.request("https://localhost:4449/api/echo", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: "{}",
    })
    expect(crossSite.status).toBe(403)
    const ok = await routes.request("https://localhost:4449/api/echo", {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: "{}",
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ authorization: "Bearer tok.sig" })
  })
})

describe("the composed self-hosted app behind an HTTPS public origin", () => {
  let dataDir: string
  let savedEnv: Record<string, string | undefined>
  let services: ReturnType<typeof createDefaultLocalControlPlaneServices>
  let composed: ReturnType<typeof createSelfHostedApp>

  beforeAll(() => {
    savedEnv = {
      CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
      CLAXEDO_SIGNED_CLOUD_AUTH: process.env.CLAXEDO_SIGNED_CLOUD_AUTH,
      CLAXEDO_EMBEDDED_AUTH: process.env.CLAXEDO_EMBEDDED_AUTH,
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    }
    dataDir = mkdtempSync(path.join(tmpdir(), "claxedo-embedded-browser-auth-"))
    process.env.CLAXEDO_DATA_DIR = dataDir
    process.env.CLAXEDO_SIGNED_CLOUD_AUTH = "1"
    process.env.CLAXEDO_EMBEDDED_AUTH = "1"
    process.env.BETTER_AUTH_URL = ORIGIN
    resetEmbeddedAuthForTests()
    services = createDefaultLocalControlPlaneServices()
    composed = createSelfHostedApp(services)
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

  test("guards a cookie-bearing /api/auth mutation before Better Auth answers it", async () => {
    const signup = await composed.app.request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "browser@selfhost.test", password: "correct-horse-battery", name: "Browser User" }),
    })
    expect(signup.status, await signup.clone().text()).toBe(200)
    const cookie = signup.headers.getSetCookie().find((value) => value.startsWith("__Secure-claxedo.session_token="))?.split(";", 1)[0]
    if (!cookie) throw new Error(`no secure session cookie among: ${signup.headers.getSetCookie().join(" | ")}`)
    const rename = (headers: Record<string, string>) =>
      composed.app.request(`${ORIGIN}/api/auth/update-user`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, ...headers },
        body: JSON.stringify({ name: "Renamed" }),
      })

    // The refusal is this composition's own, not Better Auth's INVALID_ORIGIN:
    // that is what shows the guard ran first.
    const otherPort = await rename({ origin: "https://localhost:9999", "sec-fetch-site": "same-site" })
    expect(otherPort.status).toBe(403)
    expect(await otherPort.json()).toMatchObject({ error: { code: "browser_auth_origin_forbidden" } })

    const crossSite = await rename({ origin: ORIGIN, "sec-fetch-site": "cross-site" })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toMatchObject({ error: { code: "browser_auth_cross_site_forbidden" } })

    const exact = await rename({ origin: ORIGIN, "sec-fetch-site": "same-origin" })
    expect(exact.status, await exact.clone().text()).toBe(200)
  })

  test("a device approval passes the guard and still needs the transaction the page was shown", async () => {
    const signup = await composed.app.request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "device@selfhost.test", password: "correct-horse-battery", name: "Device Owner" }),
    })
    expect(signup.status, await signup.clone().text()).toBe(200)
    const cookie = signup.headers.getSetCookie().find((value) => value.startsWith("__Secure-claxedo.session_token="))?.split(";", 1)[0]
    if (!cookie) throw new Error(`no secure session cookie among: ${signup.headers.getSetCookie().join(" | ")}`)

    const grant = deviceGrant(composed.app, ORIGIN)
    const device = await grant.requestCode()
    const viewed = await grant.viewed(device.user_code, { cookie })

    const approve = (body: Record<string, unknown>, headers: Record<string, string>) =>
      grant.decide("approve", { userCode: device.user_code, ...body }, { cookie, ...headers })

    const otherPort = await approve(
      { transaction: viewed.transaction },
      { origin: "https://localhost:9999", "sec-fetch-site": "same-site" },
    )
    expect(otherPort.status).toBe(403)
    expect(await otherPort.json()).toMatchObject({ error: { code: "browser_auth_origin_forbidden" } })

    const crossSite = await approve({ transaction: viewed.transaction }, { origin: ORIGIN, "sec-fetch-site": "cross-site" })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toMatchObject({ error: { code: "browser_auth_cross_site_forbidden" } })

    const untransacted = await approve({}, { origin: ORIGIN, "sec-fetch-site": "same-origin" })
    expect(untransacted.status, await untransacted.clone().text()).toBe(403)
    expect(await untransacted.json()).toMatchObject({ error: "access_denied" })

    const exact = await approve({ transaction: viewed.transaction }, { origin: ORIGIN, "sec-fetch-site": "same-origin" })
    expect(exact.status, await exact.clone().text()).toBe(200)
  })
})
