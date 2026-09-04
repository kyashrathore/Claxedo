import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import {
  embeddedBrowserAuthDescriptor,
  embeddedBrowserAuthSecurity,
  embeddedBrowserSessionBearer,
} from "./embedded-browser-auth"

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
    const explicit = await routes.request("https://localhost:4449/api/echo", { headers: { cookie, authorization: "Bearer other" } })
    expect(await explicit.json()).toEqual({ authorization: "Bearer other" })
    const lookalike = await routes.request("https://localhost:4449/api/echo", { headers: { cookie: "x__Secure-claxedo.session_token=nope" } })
    expect(await lookalike.json()).toEqual({ authorization: null })
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
