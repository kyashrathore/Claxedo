import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createSqliteCentralStore } from "../../authority/adapters/sqlite/central-store"
import { createControlPlaneServices } from "../../authority/services"
import { API_CONTENT_SECURITY_POLICY, HSTS_VALUE } from "@claxedo/server-core/platform/http/security-headers"
import {
  createApp,
  SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY,
  SELF_HOST_DOCUMENT_FRAME_ANCESTORS,
  selfHostDocumentSecurityHeaderEntries,
} from "./app"

/**
 * The local / self-host server is the ONE surface that answers both response
 * classes: JSON/SSE API routes AND — when `CLAXEDO_APP_DIST_DIR` is set — the
 * built claxedo-app bundle plus its index.html, same origin, same Hono app.
 *
 * The hosted middleware (security-headers.test.ts) and the Cloudflare Pages
 * `_headers` file each cover exactly one of those. Neither covers this server,
 * which shipped with no security headers at all. These are the pins for the
 * split policy that fixes that, and in particular for the failure mode that
 * makes the split necessary: blanket `default-src 'none'` white-screens the
 * self-hosted UI.
 */

const REQUIRED = ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"] as const

function createTestApp() {
  const centralStore = createSqliteCentralStore({ mode: () => "workspace_replicated" })
  return createApp(
    createControlPlaneServices(
      {
        projectionStore: centralStore.projectionStore,
        durableSessionLog: centralStore.durableSessionLog,
      },
      { localExecution: { enabled: true }, telemetry: { capture: () => {} } },
    ),
  ).app
}

/**
 * A miniature `dist/` with the two shapes that matter: the SPA document, and a
 * same-origin MODULE worker (the real bundle ships
 * `assets/markdown-shiki.worker-*.js`), whose own response CSP becomes its
 * global CSP.
 */
function writeFakeAppDist(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-spa-dist-")))
  fs.mkdirSync(path.join(dir, "assets"))
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><html style="color-scheme: dark"><head><style id="claxedo-initial-paint"></style>' +
      '<script type="module" crossorigin src="/assets/main.js"></script></head><body></body></html>',
  )
  fs.writeFileSync(path.join(dir, "assets", "main.js"), "export const main = 1\n")
  fs.writeFileSync(path.join(dir, "assets", "markdown-shiki.worker.js"), "export const worker = 1\n")
  return dir
}

describe("self-host API responses carry the hosted lockdown policy", () => {
  test("stamps every required header on an API response", async () => {
    const res = await createTestApp().request("http://localhost:3001/api/claxedo/health")

    expect(res.status).toBe(200)
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    // Byte-identical to the hosted control plane: same constant, not a copy.
    expect(res.headers.get("content-security-policy")).toBe(API_CONTENT_SECURITY_POLICY)
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'")
    // An API response is not a document, so nothing is report-only here.
    expect(res.headers.get("content-security-policy-report-only")).toBeNull()
    expect(res.headers.get("cache-control")).toBe("no-store")
    // Still a working API response, not a locked-down brick.
    expect(await res.json()).toMatchObject({ ok: true })
  })

  test("stamps the required headers on a 404 when no app bundle is mounted", async () => {
    // With CLAXEDO_APP_DIST_DIR unset there is no SPA mount at all, so an
    // unmatched GET is an API-class response and gets the strict policy.
    expect(process.env.CLAXEDO_APP_DIST_DIR).toBeUndefined()
    const res = await createTestApp().request("http://localhost:3001/nothing-here")

    expect(res.status).toBe(404)
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
    expect(res.headers.get("content-security-policy")).toBe(API_CONTENT_SECURITY_POLICY)
  })

  test("stamps the required headers on the CORS preflight CORS short-circuits", async () => {
    // Mounted ahead of cors() precisely so the preflight is covered too.
    const res = await createTestApp().request("http://localhost:3001/api/claxedo/health", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:4444", "access-control-request-method": "GET" },
    })

    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4444")
  })
})

describe("self-host SPA bundle responses carry the document policy", () => {
  let distDir: string
  let previousDistDir: string | undefined

  beforeAll(() => {
    previousDistDir = process.env.CLAXEDO_APP_DIST_DIR
    distDir = writeFakeAppDist()
    process.env.CLAXEDO_APP_DIST_DIR = distDir
  })

  afterAll(() => {
    if (previousDistDir === undefined) delete process.env.CLAXEDO_APP_DIST_DIR
    else process.env.CLAXEDO_APP_DIST_DIR = previousDistDir
    fs.rmSync(distDir, { recursive: true, force: true })
  })

  test("serves the SPA document with every required header", async () => {
    const res = await createTestApp().request("http://localhost:3001/s/some-session", {
      headers: { accept: "text/html" },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    for (const header of REQUIRED) expect(res.headers.get(header)).toBeTruthy()
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    // SAMEORIGIN, matching `frame-ancestors 'self'` — see the note on
    // selfHostDocumentSecurityHeaderEntries.
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(await res.text()).toContain("<!doctype html>")
  })

  test("the DOCUMENT policy is never `default-src 'none'`", async () => {
    // The direct pin against the white-screen failure mode. `default-src
    // 'none'` on the self-hosted document blocks its own scripts, styles,
    // fonts and workers — the UI renders as a blank page with no clue why.
    const res = await createTestApp().request("http://localhost:3001/s/some-session", {
      headers: { accept: "text/html" },
    })

    const enforcing = res.headers.get("content-security-policy") ?? ""
    const reportOnly = res.headers.get("content-security-policy-report-only") ?? ""
    expect(enforcing).not.toContain("default-src 'none'")
    expect(reportOnly).not.toContain("default-src 'none'")
    expect(reportOnly).toContain("default-src 'self'")
    // Every relaxation below is load-bearing for this bundle; dropping any one
    // of them breaks a real surface. See packages/claxedo-app/public/_headers,
    // which is the source of truth and where each was validated in a browser.
    expect(reportOnly).toContain("'wasm-unsafe-eval'") // Shiki compiles inlined WASM
    expect(reportOnly).toContain("style-src 'self' 'unsafe-inline'") // inline <style> + style attr
    expect(reportOnly).toContain("worker-src 'self' blob:")
    expect(reportOnly).toContain("https://*.i.posthog.com")
    expect(reportOnly).toContain("https://challenges.cloudflare.com")
    expect(reportOnly).toContain("frame-src https:")
  })

  test("the document CSP is REPORT-ONLY; only frame-ancestors is enforcing", async () => {
    // Asserted explicitly so promoting the full policy to enforcing is a
    // visible, reviewable diff rather than a silent one-word edit. It stays
    // report-only because it has NOT been validated against a running
    // self-hosted app with a live backend — see the promotion checklist on
    // SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY. "No compat debt pre-launch"
    // is not evidence.
    const res = await createTestApp().request("http://localhost:3001/s/some-session", {
      headers: { accept: "text/html" },
    })

    // Enforcing: embedding only. It governs who may frame us and nothing else,
    // so it cannot break resource loading — safe without browser validation.
    expect(res.headers.get("content-security-policy")).toBe(SELF_HOST_DOCUMENT_FRAME_ANCESTORS)
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'")
    // Report-only: the full policy, carrying every fetch directive.
    expect(res.headers.get("content-security-policy-report-only")).toBe(
      SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY,
    )
  })

  test("connect-src allows the plaintext loopback control plane", async () => {
    // Self-host talks to `http://127.0.0.1:<port>` for real. The Pages policy
    // only allows `https:`/`wss:` and recorded plaintext loopback as a KNOWN
    // GAP it would report; here it would be a broken app, not a report.
    const res = await createTestApp().request("http://localhost:3001/s/some-session", {
      headers: { accept: "text/html" },
    })
    const reportOnly = res.headers.get("content-security-policy-report-only") ?? ""

    const connectSrc = reportOnly.split("; ").find((directive) => directive.startsWith("connect-src "))
    expect(connectSrc).toBeTruthy()
    for (const source of ["'self'", "https:", "wss:", "http://localhost:*", "http://127.0.0.1:*", "ws://localhost:*", "ws://127.0.0.1:*"]) {
      expect(connectSrc, source).toContain(source)
    }
  })

  test("a bundle module worker does NOT get `default-src 'none'`", async () => {
    // `assets/*.worker-*.js` are same-origin MODULE workers, and a worker's
    // own response CSP becomes its global CSP. `default-src 'none'` on these
    // bytes kills Shiki's WASM compile inside the worker with no
    // document-level violation to explain it — which is why the policy split
    // is by "did the SPA bundle answer this?" and not by Content-Type.
    const app = createTestApp()

    for (const asset of ["/assets/main.js", "/assets/markdown-shiki.worker.js"]) {
      const res = await app.request(`http://localhost:3001${asset}`)
      expect(res.status, asset).toBe(200)
      expect(res.headers.get("content-security-policy"), asset).toBe(SELF_HOST_DOCUMENT_FRAME_ANCESTORS)
      expect(res.headers.get("content-security-policy"), asset).not.toContain("default-src")
      expect(res.headers.get("content-security-policy-report-only"), asset).toContain("'wasm-unsafe-eval'")
      expect(res.headers.get("x-content-type-options"), asset).toBe("nosniff")
      expect(res.headers.get("cache-control"), asset).not.toBe("no-store")
    }
  })

  test("API routes keep the strict policy while the bundle is mounted", async () => {
    // The SPA mount is registered last and only answers what no API route
    // finalized. Mounting it must not relax the API surface.
    const res = await createTestApp().request("http://localhost:3001/api/claxedo/health")

    expect(res.status).toBe(200)
    expect(res.headers.get("content-security-policy")).toBe(API_CONTENT_SECURITY_POLICY)
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("content-security-policy-report-only")).toBeNull()
  })
})

describe("HSTS is gated on real HTTPS, exactly as the hosted middleware gates it", () => {
  let distDir: string
  let previousDistDir: string | undefined

  beforeAll(() => {
    previousDistDir = process.env.CLAXEDO_APP_DIST_DIR
    distDir = writeFakeAppDist()
    process.env.CLAXEDO_APP_DIST_DIR = distDir
  })

  afterAll(() => {
    if (previousDistDir === undefined) delete process.env.CLAXEDO_APP_DIST_DIR
    else process.env.CLAXEDO_APP_DIST_DIR = previousDistDir
    fs.rmSync(distDir, { recursive: true, force: true })
  })

  test("never sends HSTS over plaintext http, on either response class", async () => {
    // Self-host is the surface where this actually bites: a one-year HSTS pin
    // on `localhost` forces HTTPS on every other plaintext dev server on that
    // machine, with no obvious cause and no easy undo.
    const app = createTestApp()

    for (const url of ["http://localhost:3001/api/claxedo/health", "http://127.0.0.1:3001/api/claxedo/health"]) {
      const res = await app.request(url)
      expect(res.headers.get("strict-transport-security"), url).toBeNull()
      for (const header of REQUIRED) expect(res.headers.get(header), `${url} ${header}`).toBeTruthy()
    }

    const document = await app.request("http://localhost:3001/s/some-session", { headers: { accept: "text/html" } })
    expect(document.headers.get("strict-transport-security")).toBeNull()
    expect(document.headers.get("content-security-policy")).toBe(SELF_HOST_DOCUMENT_FRAME_ANCESTORS)
  })

  test("sends HSTS over https, on either response class", async () => {
    const app = createTestApp()

    const api = await app.request("https://localhost/api/claxedo/health")
    expect(api.headers.get("strict-transport-security")).toBe(HSTS_VALUE)
    expect(HSTS_VALUE).toBe("max-age=31536000; includeSubDomains")

    const document = await app.request("https://localhost/s/some-session", { headers: { accept: "text/html" } })
    expect(document.headers.get("strict-transport-security")).toBe(HSTS_VALUE)
    expect(document.headers.get("content-security-policy-report-only")).toBe(
      SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY,
    )
  })

  test("ignores a spoofed x-forwarded-proto on loopback", async () => {
    const res = await createTestApp().request("http://localhost:3001/api/claxedo/health", {
      headers: { "x-forwarded-proto": "https" },
    })

    expect(res.headers.get("strict-transport-security")).toBeNull()
  })
})

describe("selfHostDocumentSecurityHeaderEntries derives from the hosted set", () => {
  test("overrides exactly two headers and appends the report-only policy", () => {
    const entries = new Map(selfHostDocumentSecurityHeaderEntries({ https: true }))

    // Reused verbatim from ./security-headers — one definition, three surfaces.
    expect(entries.get("x-content-type-options")).toBe("nosniff")
    expect(entries.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
    expect(entries.get("strict-transport-security")).toBe(HSTS_VALUE)
    // The two a document surface must relax.
    expect(entries.get("content-security-policy")).toBe(SELF_HOST_DOCUMENT_FRAME_ANCESTORS)
    expect(entries.get("x-frame-options")).toBe("SAMEORIGIN")
    // Plus the report-only policy.
    expect(entries.get("content-security-policy-report-only")).toBe(SELF_HOST_DOCUMENT_CONTENT_SECURITY_POLICY)
  })

  test("omits HSTS when the transport is plaintext", () => {
    const entries = new Map(selfHostDocumentSecurityHeaderEntries({ https: false }))

    expect(entries.has("strict-transport-security")).toBe(false)
    expect(entries.get("x-content-type-options")).toBe("nosniff")
  })
})

describe("app.ts mounts the middleware outermost", () => {
  test("localSecurityHeaders() is registered before the CORS middleware", () => {
    // Source-level ratchet, same idiom as the hosted pin in
    // security-headers.test.ts: the guarantee is "no local route can miss
    // these", which only holds if the middleware is composed once, at the top.
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "app.ts"), "utf-8")
    const mount = source.indexOf("app.use(localSecurityHeaders())")
    const corsMount = source.indexOf("app.use(\n    cors({")

    expect(mount).toBeGreaterThan(-1)
    expect(corsMount).toBeGreaterThan(-1)
    expect(mount).toBeLessThan(corsMount)
  })

  test("the SPA bundle mount marks its requests so they get the document policy", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "app.ts"), "utf-8")

    expect(source).toContain('app.get("*", markSpaBundleRequest, serveStatic({ root }))')
  })
})
