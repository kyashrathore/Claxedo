import { afterAll, beforeEach, describe, expect, test } from "bun:test"

/**
 * The bearer this transport is given, and how it was asked for.
 *
 * `api.ts` used to import `getAuthToken` from `@/platform/auth/auth-client`,
 * and this file used to `mock.module` that import away. Both are gone: the
 * transport now takes a bearer source through `configureApiRuntime`, so the
 * test installs a real one instead of replacing a module it no longer imports.
 * `tokenRequests` records the options each call carried, which is what proves
 * the force-refresh retry actually asks for a fresh JWT rather than the cached
 * one it was just told is invalid.
 */
let token: string | null = null
const tokenRequests: Array<{ skipCache?: boolean } | undefined> = []
const calls: Array<{
  auth: string | null
  body: string
  cache: RequestCache
  credentials: RequestCredentials
  dir: string | null
  url: string
}> = []
const originalFetch = globalThis.fetch
const originalOpencode = window.__OPENCODE__

// Use an absolute path with a cache-busting query to bypass any stale
// mock.module("./api") may be registered by other API client tests.
// Bun treats distinct specifiers as distinct module instances, so this
// always evaluates the real api.ts.
const {
  api,
  apiBearerToken,
  authFetch,
  configureApiRuntime,
  fixDir,
  getClaxedoServerUrl,
  getConfiguredClaxedoServerUrl,
  getDefaultBaseUrl,
  isHostedAppHostname,
  isDemoMode,
  isDemoPath,
  isEmbedMode,
  resetApiRuntime,
} = await import(`${import.meta.dir}/api.ts?test`)

const originalClaxedoServerUrl = import.meta.env.VITE_CLAXEDO_SERVER_URL
const originalLegacyBackendUrl = import.meta.env.VITE_OPENCODE_BACKEND_URL

function setServerEnv(input: { claxedo?: string; legacy?: string }) {
  import.meta.env.VITE_CLAXEDO_SERVER_URL = input.claxedo
  import.meta.env.VITE_OPENCODE_BACKEND_URL = input.legacy
}

/**
 * Put the DOM in the shape the PACKAGED desktop renderer actually has.
 *
 * The desktop main process loads the window with `win.loadFile(...)`, so the
 * renderer is a file:// page. Setting `location.href` alone is NOT enough to
 * reproduce it: happy-dom serializes a file:// page's origin as the string
 * "null" (the spec's opaque-origin serialization), but real Chromium/Electron
 * reports the literal string "file://" with an empty hostname — measured
 * directly in the shipped app's devtools console.
 *
 * That one-value divergence is why this bug shipped. `getClaxedoServerUrl()`
 * only rejected the origin spelled "null" and only bailed on a loopback
 * *hostname*, so under happy-dom the guard fired and the suite stayed green,
 * while in the real app the app handed back its own "file://" origin as the API
 * base — every call then resolved to `file:///session?...` /
 * `file:///api/workspace/resolve?...` and failed with ERR_FILE_NOT_FOUND, so no
 * session would start and no harness would switch.
 *
 * So pin `origin` to the browser-truthful value rather than trusting the
 * test DOM. Do NOT call `configureApiRuntime()` alongside this: production
 * never calls it, and setting `cfg.base` short-circuits the entire fallback
 * chain — which is why the pre-existing file:// test above never caught this.
 */
function asPackagedDesktopRenderer() {
  window.location.href = "file:///Applications/Claxedo.app/Contents/Resources/app.asar/out/renderer/index.html"
  Object.defineProperty(window.location, "origin", {
    configurable: true,
    get: () => "file://",
  })
}

beforeEach(() => {
  // Drop any `origin` override a previous test installed (see
  // asPackagedDesktopRenderer) so it cannot leak into unrelated cases.
  Reflect.deleteProperty(window.location, "origin")
  window.location.href = "http://localhost/"
  window.__OPENCODE__ = originalOpencode ? { ...originalOpencode } : undefined
  token = null
  tokenRequests.length = 0
  calls.length = 0
  setServerEnv({
    claxedo: originalClaxedoServerUrl,
    legacy: originalLegacyBackendUrl,
  })
  resetApiRuntime()
  // After the reset, or it would clear the binding it is meant to install.
  configureApiRuntime({
    bearerToken: async (options) => {
      tokenRequests.push(options)
      return token
    },
  })
  globalThis.fetch = (async (input, init) => {
    const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
    calls.push({
      auth: req.headers.get("Authorization"),
      body: await req.clone().text(),
      cache: init?.cache ?? req.cache ?? "default",
      credentials: init?.credentials ?? req.credentials,
      dir: req.headers.get("x-opencode-directory"),
      url: req.url,
    })
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  window.__OPENCODE__ = originalOpencode
})

describe("demo routing", () => {
  test("matches only the demo path prefix", () => {
    expect(isDemoPath("/")).toBe(false)
    expect(isDemoPath("/demo")).toBe(true)
    expect(isDemoPath("/demo/")).toBe(true)
    expect(isDemoPath("/demo/foo")).toBe(true)
    expect(isDemoPath("/foo/demo")).toBe(false)
  })

  test("ignores the old demo query on the live root", () => {
    window.location.href = "http://localhost/?demo=1"
    expect(isDemoMode()).toBe(false)
  })

  test("enables demo mode under /demo", () => {
    window.location.href = "http://localhost/demo/?demo=1"
    expect(isDemoMode()).toBe(true)
  })

  test("keeps embed detection query-based", () => {
    window.location.href = "http://localhost/demo/?embed=1"
    expect(isEmbedMode()).toBe(true)
  })

  test("matches hosted app hostnames exactly", () => {
    expect(isHostedAppHostname("claxedo.com")).toBe(true)
    expect(isHostedAppHostname("app.claxedo.com")).toBe(true)
    expect(isHostedAppHostname("notclaxedo.com")).toBe(false)
    expect(isHostedAppHostname("claxedo.com.evil.test")).toBe(false)
    expect(isHostedAppHostname(undefined)).toBe(false)
  })

  // Upstream's hosted app is not ours; it must not be treated as first-party.
  test("does not match opencode.ai hostnames", () => {
    expect(isHostedAppHostname("opencode.ai")).toBe(false)
    expect(isHostedAppHostname("app.opencode.ai")).toBe(false)
  })
})

describe("authFetch", () => {
  test("prefers bearer auth over configured desktop basic auth", async () => {
    token = "tok_123"
    configureApiRuntime({ password: "desk-secret" })

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.auth).toBe("Bearer tok_123")
  })

  test("bypasses Chromium's HTTP cache for local API responses", async () => {
    await authFetch("http://127.0.0.1:2593/api/claxedo/bootstrap")

    expect(calls[0]?.cache).toBe("no-store")
  })

  test("uses configured desktop basic auth when no token exists", async () => {
    configureApiRuntime({ password: "desk-secret" })

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.auth).toBe(`Basic ${btoa("opencode:desk-secret")}`)
  })

  test("sends no bearer, and asks for none, when the build bound no source", async () => {
    // The local product's shape. `app/entry/local.tsx` calls no
    // `configureApiRuntime({ bearerToken })`, which is the whole reason it can
    // ship without an identity provider in its bundle. A token is deliberately
    // available here: if this transport had ANY other route to one, the header
    // below would carry it.
    resetApiRuntime()
    token = "tok_123"

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.auth).toBeNull()
    expect(tokenRequests).toEqual([])
  })

  test("includes the browser session cookie only when the selected adapter binds cookie transport", async () => {
    configureApiRuntime({ browserCredentials: "include" })

    await authFetch("https://api.example.test/api/claxedo/bootstrap")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.credentials).toBe("include")
    expect(calls[0]?.auth).toBeNull()
  })

  test("force-refreshes the bearer once when the server rejects it as invalid", async () => {
    // The retry that keeps a stale Clerk JWT from wedging every panel in
    // "loading" forever. It is also the only caller that passes an option
    // through the bearer seam, so it is what proves the seam carries one.
    token = "tok_stale"
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      calls.push({
        auth: req.headers.get("Authorization"),
        body: await req.clone().text(),
        cache: init?.cache ?? req.cache ?? "default",
        credentials: init?.credentials ?? req.credentials,
        dir: req.headers.get("x-opencode-directory"),
        url: req.url,
      })
      if (calls.length === 1) {
        token = "tok_fresh"
        return Response.json({ error: { code: "invalid_bearer_token" } }, { status: 401 })
      }
      return Response.json({ ok: true })
    }) as typeof fetch

    const res = await authFetch("http://localhost/test")

    expect(res.status).toBe(200)
    expect(calls.map((call) => call.auth)).toEqual(["Bearer tok_stale", "Bearer tok_fresh"])
    expect(tokenRequests).toEqual([undefined, { skipCache: true }])
  })

  test("preserves an explicit authorization header", async () => {
    token = "tok_123"
    configureApiRuntime({ password: "desk-secret" })

    await authFetch("http://localhost/test", {
      headers: { Authorization: "Bearer custom" },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.auth).toBe("Bearer custom")
  })

  test("does not inject x-opencode-directory from window globals", async () => {
    window.__OPENCODE__ ??= {}
    window.__OPENCODE__.activeDirectory = "/tmp/project"

    await authFetch("http://localhost/test")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.dir).toBeNull()
  })

  test("retries local-only signed-cloud-disabled responses without bearer auth", async () => {
    token = "tok_123"
    globalThis.fetch = (async (input, init) => {
      const req = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      calls.push({
        auth: req.headers.get("Authorization"),
        body: await req.clone().text(),
        cache: init?.cache ?? req.cache ?? "default",
        credentials: init?.credentials ?? req.credentials,
        dir: req.headers.get("x-opencode-directory"),
        url: req.url,
      })
      if (calls.length === 1) {
        return Response.json({ error: { code: "signed_cloud_auth_disabled" } }, { status: 403 })
      }
      return Response.json({ ok: true })
    }) as typeof fetch

    const res = await authFetch("http://localhost/api/control/test", {
      method: "PUT",
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(200)
    expect(calls.map((call) => call.auth)).toEqual(["Bearer tok_123", null])
  })

  test("serializes falsey JSON bodies instead of dropping them", async () => {
    await api.post("http://localhost/test", false)
    await api.put("http://localhost/test", 0)
    await api.patch("http://localhost/test", "")

    expect(calls.map((call) => call.body)).toEqual(["false", "0", '""'])
  })

  test("routes root-relative API calls through the configured desktop server", async () => {
    window.location.href = "file:///Applications/Claxedo%20Dev.app/Contents/Resources/app.asar/out/renderer/index.html"
    configureApiRuntime({ baseUrl: "http://127.0.0.1:64144/" })

    await api.get("/api/control/sessions")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("http://127.0.0.1:64144/api/control/sessions")
  })
})

/**
 * The bearer read on its own, for the callers that build an `Authorization`
 * header themselves rather than going through `authFetch`.
 *
 * `project-actions.tsx` (destroying a cloud sandbox) and
 * `agent-runtime-client.ts` (the signed control-plane init) used to import
 * `getAuthToken` for one call each, which is how Clerk reached the LOCAL
 * bundle through two modules the local shell needs. They read this instead, so
 * "no build bound a source" has to be a first-class ANSWER here, not a throw.
 */
describe("apiBearerToken", () => {
  test("resolves null when the build bound no source", async () => {
    // The local product's shape, and the reason this returns a value rather
    // than throwing the way an unbound `*-port.ts` operation does. A token is
    // deliberately available: if the reader had any other route to one, it
    // would come back below.
    resetApiRuntime()
    token = "tok_123"

    expect(await apiBearerToken()).toBeNull()
    expect(tokenRequests).toEqual([])
  })

  test("hands back the bound source's token, and asks it with the caller's options", async () => {
    token = "tok_123"

    expect(await apiBearerToken()).toBe("tok_123")
    expect(await apiBearerToken({ skipCache: true })).toBe("tok_123")
    expect(tokenRequests).toEqual([undefined, { skipCache: true }])
  })
})

describe("authFetch workspace routing boundary", () => {
  test("leaves unrelated remote URLs on the normal authenticated fetch path", async () => {
    token = "tok_123"
    setServerEnv({
      claxedo: "https://control.test/",
      legacy: undefined,
    })
    await authFetch("https://control.test/provider?directory=%2Frepo%2Fmain")

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      auth: "Bearer tok_123",
      cache: "default",
      dir: null,
      url: "https://control.test/provider?directory=%2Frepo%2Fmain",
    })
  })

  test("keeps local session URLs on the normal authenticated fetch path", async () => {
    token = "tok_123"
    setServerEnv({
      claxedo: "http://127.0.0.1:3001/",
      legacy: undefined,
    })
    await authFetch("http://127.0.0.1:3001/session?directory=%2Frepo%2Fmain")

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      auth: "Bearer tok_123",
      dir: null,
      url: "http://127.0.0.1:3001/session?directory=%2Frepo%2Fmain",
    })
  })
})

describe("getDefaultBaseUrl", () => {
  test("prefers configured runtime base url over fallback detection", () => {
    configureApiRuntime({ baseUrl: "http://127.0.0.1:7777/" })
    expect(getDefaultBaseUrl()).toBe("http://127.0.0.1:7777")
  })

  test("points localhost app development at claxedo-server", () => {
    window.location.href = "http://localhost:4444/workspace"
    expect(getDefaultBaseUrl()).toBe("http://127.0.0.1:2593")
  })

  test("points IPv4 app development at claxedo-server", () => {
    window.location.href = "http://127.0.0.1:4444/workspace"
    expect(getDefaultBaseUrl()).toBe("http://127.0.0.1:2593")
  })

  test("points the packaged desktop renderer at claxedo-server", () => {
    asPackagedDesktopRenderer()
    expect(getDefaultBaseUrl()).toBe("http://127.0.0.1:2593")
  })

  test("never resolves API paths against the file:// origin", () => {
    asPackagedDesktopRenderer()
    expect(new URL("/session", getDefaultBaseUrl()).toString()).toBe("http://127.0.0.1:2593/session")
  })
})

describe("getClaxedoServerUrl on the packaged desktop renderer", () => {
  test("falls through to claxedo-server rather than the file:// origin", () => {
    asPackagedDesktopRenderer()
    setServerEnv({ claxedo: undefined, legacy: undefined })
    expect(getClaxedoServerUrl()).toBe("http://127.0.0.1:2593")
  })
})

describe("configured server env", () => {
  test("prefers VITE_CLAXEDO_SERVER_URL over the legacy OpenCode backend alias", () => {
    setServerEnv({
      claxedo: "http://claxedo.test/",
      legacy: "http://legacy.test/",
    })

    expect(getConfiguredClaxedoServerUrl()).toBe("http://claxedo.test")
  })

  test("keeps VITE_OPENCODE_BACKEND_URL only as a compatibility alias", () => {
    setServerEnv({
      claxedo: "",
      legacy: "http://legacy.test/",
    })

    expect(getConfiguredClaxedoServerUrl()).toBe("http://legacy.test")
  })

  test("does not send remote deployments to a local configured server URL", () => {
    window.location.href = "https://app.example.com/workspace"
    setServerEnv({
      claxedo: "http://127.0.0.1:3001/",
      legacy: undefined,
    })

    expect(getClaxedoServerUrl()).toBe("https://app.example.com")
  })

  test("normalizes local configured servers to IPv4 loopback", () => {
    window.location.href = "http://127.0.0.1:4444/workspace"
    setServerEnv({
      claxedo: "http://localhost:3001/",
      legacy: undefined,
    })

    expect(getClaxedoServerUrl()).toBe("http://127.0.0.1:3001")
  })

  test("normalizes IPv6 loopback app hosts to IPv4 loopback backend", () => {
    window.location.href = "http://[::1]:4444/workspace"
    setServerEnv({
      claxedo: "http://127.0.0.1:3001/",
      legacy: undefined,
    })

    expect(getClaxedoServerUrl()).toBe("http://127.0.0.1:3001")
  })
})

describe("fixDir", () => {
  test("preserves absolute paths", () => {
    expect(fixDir("/absolute/path")).toBe("/absolute/path")
  })

  test("returns undefined for missing input", () => {
    expect(fixDir(undefined)).toBeUndefined()
  })
})
