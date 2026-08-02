import fs from "node:fs"
import path from "node:path"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { describe, expect, test } from "vitest"
import {
  API_CONTENT_SECURITY_POLICY,
  HSTS_VALUE,
  requestIsHttps,
  securityHeaderEntries,
  securityHeaders,
  withSecurityHeaders,
} from "./security-headers"

/**
 * Regression pin for §6.8 of the 2026-07-27 Cloud security review ("no CSP /
 * X-Frame-Options / X-Content-Type-Options / Referrer-Policy / HSTS anywhere").
 *
 * Two surfaces, two sets, both pinned here:
 *   - the hosted control plane (this Hono middleware), and
 *   - the SolidJS SPA on Cloudflare Pages, whose only header channel is
 *     packages/claxedo-app/public/_headers — the Worker never serves it.
 */

const REQUIRED = ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"] as const

function appWithMiddleware() {
  const app = new Hono()
  app.use(securityHeaders())
  app.use(cors({ origin: (origin) => (origin === "https://app.claxedo.test" ? origin : undefined) }))
  app.get("/ok", (c) => c.json({ ok: true }))
  app.get("/boom", () => {
    throw new Error("route exploded")
  })
  app.get("/refused", () => {
    throw new HTTPException(400, { message: "nope" })
  })
  return app
}

describe("hosted security headers middleware", () => {
  test("stamps every required header on a normal response", async () => {
    const res = await appWithMiddleware().request("https://cp.test/ok")

    expect(res.status).toBe(200)
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    expect(res.headers.get("content-security-policy")).toBe(API_CONTENT_SECURITY_POLICY)
    // Still a working API response, not a locked-down brick.
    expect(await res.json()).toEqual({ ok: true })
  })

  test("the API CSP is enforcing and locks the surface to nothing", () => {
    const policy = API_CONTENT_SECURITY_POLICY
    // Enforcing on purpose: this app serves no HTML, so `default-src 'none'`
    // denies nothing it needs. If a future route starts serving a document,
    // THIS is the assertion that should force the conversation.
    expect(policy).toContain("default-src 'none'")
    // These three do not inherit from default-src, so each must be explicit.
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("form-action 'none'")
  })

  test("stamps headers on responses produced by onError", async () => {
    // Hono resolves a thrown route inside the innermost dispatch frame, so the
    // middleware's post-next() write still runs. A 500 without `nosniff` is
    // exactly the response worth sniffing into a document.
    const res = await appWithMiddleware().request("https://cp.test/boom")

    expect(res.status).toBe(500)
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
  })

  test("stamps headers on an HTTPException response", async () => {
    const res = await appWithMiddleware().request("https://cp.test/refused")

    expect(res.status).toBe(400)
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
  })

  test("stamps headers on the 404 handler", async () => {
    const res = await appWithMiddleware().request("https://cp.test/nothing-here")

    expect(res.status).toBe(404)
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
  })

  test("stamps headers on the CORS preflight CORS short-circuits", async () => {
    // Registered ahead of `cors()` precisely so the preflight — which cors
    // answers without reaching a route — is covered too.
    const res = await appWithMiddleware().request("https://cp.test/ok", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.claxedo.test",
        "access-control-request-method": "GET",
      },
    })

    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
    // The anchored allowlist stays intact — this middleware must not disturb it.
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.claxedo.test")
  })

  test("does not reflect a CORS origin outside the allowlist", async () => {
    const res = await appWithMiddleware().request("https://cp.test/ok", {
      headers: { origin: "https://evil.test" },
    })

    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
  })
})

describe("HSTS is gated on real HTTPS", () => {
  test("sends HSTS over https", async () => {
    const res = await appWithMiddleware().request("https://control-plane.claxedo.test/ok")

    expect(res.headers.get("strict-transport-security")).toBe(HSTS_VALUE)
    expect(HSTS_VALUE).toBe("max-age=31536000; includeSubDomains")
  })

  test("never sends HSTS over plaintext localhost", async () => {
    // A one-year HSTS pin on `localhost` would force HTTPS on every other
    // plaintext dev server on that machine. This is the guard for that.
    for (const url of ["http://localhost:3001/ok", "http://127.0.0.1:3001/ok", "http://[::1]:3001/ok"]) {
      const res = await appWithMiddleware().request(url)
      expect(res.headers.get("strict-transport-security"), url).toBeNull()
      // The other four are transport-neutral and must still be present.
      for (const header of REQUIRED) expect(res.headers.get(header), `${url} ${header}`).toBeTruthy()
    }
  })

  test("ignores a spoofed x-forwarded-proto on loopback", async () => {
    const res = await appWithMiddleware().request("http://localhost:3001/ok", {
      headers: { "x-forwarded-proto": "https" },
    })

    expect(res.headers.get("strict-transport-security")).toBeNull()
  })

  test("honours x-forwarded-proto behind a TLS-terminating proxy on a real host", () => {
    const header = (value?: string) => (name: string) => (name === "x-forwarded-proto" ? value : undefined)

    expect(requestIsHttps({ url: "http://control.claxedo.test/ok", header: header("https") })).toBe(true)
    expect(requestIsHttps({ url: "http://control.claxedo.test/ok", header: header("https, http") })).toBe(true)
    expect(requestIsHttps({ url: "http://control.claxedo.test/ok", header: header("http") })).toBe(false)
    expect(requestIsHttps({ url: "http://control.claxedo.test/ok", header: header() })).toBe(false)
    expect(requestIsHttps({ url: "https://control.claxedo.test/ok", header: header() })).toBe(true)
  })
})

describe("withSecurityHeaders", () => {
  test("rebuilds a response whose headers are immutable", async () => {
    // `fetch()` responses carry an immutable header guard on the Workers
    // runtime; a proxied hosted route must not lose its headers to that.
    const original = new Response("payload", { status: 202, headers: { "content-type": "text/plain" } })
    const guarded = new Proxy(new Headers(original.headers), {
      get(target, prop) {
        if (prop === "set" || prop === "append" || prop === "delete") {
          return () => {
            throw new TypeError("immutable")
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    Object.defineProperty(original, "headers", { get: () => guarded })

    const stamped = withSecurityHeaders(original, securityHeaderEntries({ https: true }))

    expect(stamped).not.toBe(original)
    expect(stamped.status).toBe(202)
    expect(await stamped.text()).toBe("payload")
    expect(stamped.headers.get("content-type")).toBe("text/plain")
    expect(stamped.headers.get("x-content-type-options")).toBe("nosniff")
    expect(stamped.headers.get("strict-transport-security")).toBe(HSTS_VALUE)
  })
})

describe("hosted-app mounts the middleware outermost", () => {
  test("securityHeaders() is registered before the CORS middleware", () => {
    // Source-level ratchet, same idiom as architecture.test.ts's mount pins:
    // the guarantee is "no hosted route can miss these", which only holds if
    // the middleware is composed once, at the top, ahead of CORS.
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../deployments/hosted-shared/hosted-app.ts"), "utf-8")
    // The CORS *mount*, not `corsMiddleware`'s definition further up the file.
    const corsMount = source.indexOf("app.use(\n    corsMiddleware(")

    expect(source).toContain("app.use(securityHeaders())")
    expect(corsMount).toBeGreaterThan(-1)
    expect(source.indexOf("app.use(securityHeaders())")).toBeLessThan(corsMount)
  })
})

describe("Cloudflare Pages headers for the SPA", () => {
  // The web app is served by Pages, not by the Worker, so this file is the
  // only surface its headers can land on. Without this test the Hono
  // middleware above would look like full coverage while the actual HTML
  // document shipped bare.
  const headersFile = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../claxedo-app/public/_headers"),
    "utf-8",
  )

  test("carries the four enforcing headers on a global rule", () => {
    expect(headersFile).toMatch(/^\/\*$/m)
    expect(headersFile).toMatch(/^ {2}X-Content-Type-Options: nosniff$/m)
    expect(headersFile).toMatch(/^ {2}Referrer-Policy: strict-origin-when-cross-origin$/m)
    expect(headersFile).toMatch(/^ {2}Strict-Transport-Security: max-age=31536000; includeSubDomains$/m)
    expect(headersFile).toMatch(/^ {2}X-Frame-Options: SAMEORIGIN$/m)
  })

  test("the enforcing CSP is frame-ancestors only", () => {
    const enforcing = headersFile.match(/^ {2}Content-Security-Policy: (.+)$/m)?.[1]

    expect(enforcing).toBeTruthy()
    // An enforcing policy that governs only who may embed us cannot break
    // resource loading. If this ever grows a fetch directive it stops being
    // risk-free and must be validated against real traffic first.
    expect(enforcing).toBe("frame-ancestors 'self' https://claxedo.com https://www.claxedo.com")
  })

  test("the full SPA policy ships REPORT-ONLY", () => {
    // Deliberate and asserted so promoting it to enforcing is a visible,
    // reviewable diff rather than a silent one-word edit. See the promotion
    // checklist in _headers.
    const reportOnly = headersFile.match(/^ {2}Content-Security-Policy-Report-Only: (.+)$/m)?.[1]

    expect(reportOnly).toBeTruthy()
    expect(reportOnly).toContain("default-src 'self'")
    expect(reportOnly).toContain("object-src 'none'")
    expect(reportOnly).toContain("base-uri 'self'")
    // Load-bearing relaxations — each one white-screens the app if dropped.
    // Shiki compiles an inlined WASM module on the main thread and in workers.
    expect(reportOnly).toContain("'wasm-unsafe-eval'")
    // index.html has an inline <style> and an inline style attribute on <html>.
    expect(reportOnly).toContain("style-src 'self' 'unsafe-inline'")
    // posthog-js lazy-loads recorder/exception-autocapture from the assets host.
    expect(reportOnly).toContain("https://*.i.posthog.com")
    // Clerk renders Cloudflare Turnstile in an iframe from this origin.
    expect(reportOnly).toContain("https://challenges.cloudflare.com")
    // The relay origin arrives at runtime in an API response body, so it
    // cannot be pinned from a static file. This is the single reason the
    // policy is not enforcing.
    expect(reportOnly).toContain("connect-src 'self' https: wss:")
  })
})
