import { Hono } from "hono"
import { describe, expect, test } from "vitest"

import type { BrowserAuthDescriptor } from "@claxedo/account-contract/auth"

import { browserAuthHttpSecurity } from "./browser-auth-security"

const COOKIE_BROWSER = {
  transport: "cookie",
  credentialPolicy: "reject-cookie-and-authorization",
  trustedOrigins: ["https://app.example.test"],
  clientId: "claxedo-browser",
  resource: "https://api.example.test",
  scopes: ["control-plane:read", "control-plane:write"],
  cookie: {
    name: "__Secure-claxedo.session_token",
    path: "/",
    secure: true,
    httpOnly: true,
    hostOnly: true,
    sameSite: "lax",
  },
} as const satisfies BrowserAuthDescriptor

const BEARER_BROWSER = {
  transport: "bearer",
  credentialPolicy: "authorization-only",
  trustedOrigins: ["https://app.example.test"],
  clientId: "claxedo-browser",
  resource: "https://api.example.test",
  scopes: ["control-plane:read", "control-plane:write"],
} as const satisfies BrowserAuthDescriptor

function app(browser: BrowserAuthDescriptor) {
  const instance = new Hono()
  instance.use(browserAuthHttpSecurity(browser))
  instance.get("/read", (context) => context.json({ ok: true }))
  instance.post("/write", (context) => context.json({ ok: true }))
  return instance
}

describe("provider-neutral browser auth HTTP security", () => {
  test("grants no CORS to any origin and answers no preflight, since the app shares the origin", async () => {
    for (const origin of ["https://app.example.test", "https://evil.example.test"]) {
      const read = await app(COOKIE_BROWSER).fetch(new Request("https://api.example.test/read", { headers: { origin } }))
      expect(read.status).toBe(200)
      expect(read.headers.get("access-control-allow-origin")).toBeNull()
      expect(read.headers.get("access-control-allow-credentials")).toBeNull()
      expect(read.headers.get("timing-allow-origin")).toBeNull()
      const preflight = await app(COOKIE_BROWSER).fetch(
        new Request("https://api.example.test/write", {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        }),
      )
      expect(preflight.status).toBe(404)
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
    }
  })

  test("rejects cookie-authenticated unsafe requests with missing, null, or wrong Origin", async () => {
    for (const origin of [undefined, "null", "https://evil.example.test"]) {
      const response = await app(COOKIE_BROWSER).fetch(
        new Request("https://api.example.test/write", {
          method: "POST",
          headers: {
            cookie: "__Secure-claxedo.session_token=opaque",
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: "{}",
        }),
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: "browser_auth_origin_forbidden" } })
    }

    const trusted = await app(COOKIE_BROWSER).fetch(
      new Request("https://api.example.test/write", {
        method: "POST",
        headers: {
          cookie: "__Secure-claxedo.session_token=opaque",
          "content-type": "application/json; charset=utf-8",
          origin: "https://app.example.test",
        },
        body: "{}",
      }),
    )
    expect(trusted.status).toBe(200)
  })

  test("rejects cookie-authenticated unsafe requests reported as cross-site", async () => {
    const response = await app(COOKIE_BROWSER).fetch(
      new Request("https://api.example.test/write", {
        method: "POST",
        headers: {
          cookie: "__Secure-claxedo.session_token=opaque",
          "content-type": "application/json",
          origin: "https://app.example.test",
          "sec-fetch-site": "cross-site",
        },
        body: "{}",
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "browser_auth_cross_site_forbidden" } })
  })

  test("rejects non-JSON content types on cookie-authenticated unsafe requests", async () => {
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "application/octet-stream",
      "application/+json",
    ]) {
      const response = await app(COOKIE_BROWSER).fetch(
        new Request("https://api.example.test/write", {
          method: "POST",
          headers: {
            cookie: "__Secure-claxedo.session_token=opaque",
            "content-type": contentType,
            origin: "https://app.example.test",
          },
          body: "payload",
        }),
      )
      expect(response.status, contentType).toBe(415)
      expect(await response.json()).toMatchObject({ error: { code: "browser_auth_content_type_unsupported" } })
    }

    for (const contentType of ["application/json", "application/merge-patch+json; charset=utf-8"]) {
      const response = await app(COOKIE_BROWSER).fetch(
        new Request("https://api.example.test/write", {
          method: "POST",
          headers: {
            cookie: "__Secure-claxedo.session_token=opaque",
            "content-type": contentType,
            origin: "https://app.example.test",
          },
          body: "{}",
        }),
      )
      expect(response.status, contentType).toBe(200)
    }
  })

  test("gates only the configured exact session cookie and only on unsafe methods", async () => {
    for (const cookie of [
      "unrelated=opaque",
      "prefix__Secure-claxedo.session_token=opaque",
      "__Secure-claxedo.session_token_suffix=opaque",
    ]) {
      const response = await app(COOKIE_BROWSER).fetch(
        new Request("https://api.example.test/write", {
          method: "POST",
          headers: { cookie, "content-type": "text/plain" },
          body: "payload",
        }),
      )
      expect(response.status, cookie).toBe(200)
    }

    const safe = await app(COOKIE_BROWSER).fetch(
      new Request("https://api.example.test/read", {
        headers: { cookie: "__Secure-claxedo.session_token=opaque" },
      }),
    )
    expect(safe.status).toBe(200)
  })

  test("does not apply the cookie CSRF policy to a bearer browser transport", async () => {
    const response = await app(BEARER_BROWSER).fetch(
      new Request("https://api.example.test/write", {
        method: "POST",
        headers: {
          authorization: "Bearer opaque",
          cookie: "__Secure-claxedo.session_token=unselected-adapter-cookie",
          "content-type": "text/plain",
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
        },
        body: "payload",
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
  })
})
