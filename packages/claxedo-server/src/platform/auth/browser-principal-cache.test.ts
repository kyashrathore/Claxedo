import { describe, expect, test, vi } from "vitest"
import type { AuthAdapterDescriptor } from "@claxedo/account-contract/auth"
import type { ControlPlanePrincipal } from "@claxedo/server-core/platform/auth/authentication"
import { BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS, retireBrowserPrincipalCache, withBrowserPrincipalCache } from "./browser-principal-cache"

const NOW = 1_800_000_000_000
const APP = "https://app.example.test"
const SECRET = "better-auth-secret-that-is-at-least-thirty-two-bytes"
const SESSION = "__Secure-claxedo.session_token"
const native = {
  resource: `${APP}/control-plane`,
  scopes: ["workspace:read"],
  tokenEndpointOrigin: APP,
  controlPlaneOrigin: APP,
  revocation: { protocol: "rfc7009", endpoint: `${APP}/api/auth/oauth2/revoke`, tokenEndpointAuthMethod: "none" },
} as const

const descriptor = {
  adapter: "better-auth",
  deploymentId: "deployment_1",
  configurationVersion: "auth-v1",
  expiresAt: NOW + 3_600_000,
  issuer: `${APP}/api/auth`,
  methods: ["github"],
  browser: {
    transport: "cookie",
    credentialPolicy: "reject-cookie-and-authorization",
    trustedOrigins: [APP],
    clientId: "claxedo-browser",
    resource: `${APP}/control-plane`,
    scopes: ["workspace:read", "workspace:write"],
    cookie: { name: SESSION, path: "/", secure: true, httpOnly: true, hostOnly: true, sameSite: "lax" },
  },
  native: {
    cli: { ...native, flow: "device-authorization", clientId: "claxedo-cli" },
    desktop: { ...native, flow: "authorization-code-pkce", clientId: "claxedo-desktop" },
  },
} as const satisfies AuthAdapterDescriptor

function principal(origin = APP): ControlPlanePrincipal {
  return {
    userId: "usr_1",
    actorId: "act_1",
    actorKind: "human",
    deploymentId: descriptor.deploymentId,
    sessionId: "session_1",
    authenticatedAt: NOW - 60_000,
    methods: ["oauth:github"],
    assurance: "single-factor",
    client: {
      kind: "browser",
      tokenKind: "browser-session",
      id: descriptor.browser.clientId,
      resource: descriptor.browser.resource,
      scopes: descriptor.browser.scopes,
      origin,
    },
    identity: { adapter: "better-auth", issuer: descriptor.issuer, subject: "ba_user_1" },
  }
}

function setup(options: { descriptor?: AuthAdapterDescriptor; now?: () => number } = {}) {
  const authenticate = vi.fn(async (request: Request) => principal(request.headers.get("origin") ?? APP))
  const verifyIdentity = vi.fn<(request: Request) => Promise<ControlPlanePrincipal["identity"]>>(async () => principal().identity)
  const adapter = withBrowserPrincipalCache(
    { descriptor: options.descriptor ?? descriptor, authenticate, verifyIdentity },
    { secret: SECRET, now: options.now ?? (() => NOW) },
  )
  return { adapter, authenticate, verifyIdentity }
}

function request(cookie: string, headers: Record<string, string> = {}) {
  return new Request(`${APP}/api/workspace`, { headers: { origin: APP, cookie, ...headers } })
}

async function issuedCache(adapter: ReturnType<typeof setup>["adapter"], session = `${SESSION}=token.sig`) {
  const live = request(session)
  await adapter.authenticate(live)
  const [cookie = ""] = adapter.responseCookies(live)
  return cookie.slice(0, cookie.indexOf(";"))
}

describe("withBrowserPrincipalCache", () => {
  test("a live verification issues the cache, and the next request is answered from it with the request's own origin", async () => {
    const { adapter, authenticate } = setup()
    const cache = await issuedCache(adapter)
    expect(authenticate).toHaveBeenCalledTimes(1)
    const next = request(`${SESSION}=token.sig; ${cache}`)
    expect(await adapter.authenticate(next)).toEqual(principal())
    expect(adapter.responseCookies(next)).toEqual([])
    expect(authenticate).toHaveBeenCalledTimes(1)
  })

  test("one request asked several times verifies once", async () => {
    const { adapter, authenticate } = setup()
    const live = request(`${SESSION}=token.sig`)
    await Promise.all([adapter.authenticate(live), adapter.authenticate(live)])
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(adapter.responseCookies(live)).toHaveLength(1)
  })

  test("a request with an Authorization header, an untrusted origin, no session cookie or two of them goes to the adapter and is issued nothing", async () => {
    const { adapter, authenticate } = setup()
    const cache = await issuedCache(adapter)
    authenticate.mockClear()
    const delegated = [
      request(`${SESSION}=token.sig; ${cache}`, { authorization: "Bearer token" }),
      request(`${SESSION}=token.sig; ${cache}`, { origin: "https://evil.example.test" }),
      request(cache),
      request(`${SESSION}=token.sig; ${SESSION}=token.sig; ${cache}`),
    ]
    for (const each of delegated) {
      await adapter.authenticate(each)
      expect(adapter.responseCookies(each)).toEqual([])
    }
    expect(authenticate).toHaveBeenCalledTimes(delegated.length)
  })

  test("a cache from another deployment, configuration or secret, or one sent twice, is not used", async () => {
    const other = await issuedCache(setup({ descriptor: { ...descriptor, deploymentId: "deployment_2" } }).adapter)
    const reconfigured = await issuedCache(setup({ descriptor: { ...descriptor, configurationVersion: "auth-v2" } }).adapter)
    const { adapter, authenticate } = setup()
    const own = await issuedCache(adapter)
    authenticate.mockClear()
    for (const cache of [other, reconfigured, `${own}; ${own}`]) await adapter.authenticate(request(`${SESSION}=token.sig; ${cache}`))
    expect(authenticate).toHaveBeenCalledTimes(3)
  })

  test("the cache lives exactly its maximum age", async () => {
    let now = NOW
    const { adapter, authenticate } = setup({ now: () => now })
    const cache = await issuedCache(adapter)
    now = NOW + BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS - 1
    await adapter.authenticate(request(`${SESSION}=token.sig; ${cache}`))
    expect(authenticate).toHaveBeenCalledTimes(1)
    now = NOW + BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS
    await adapter.authenticate(request(`${SESSION}=token.sig; ${cache}`))
    expect(authenticate).toHaveBeenCalledTimes(2)
  })

  test("a refused live verification issues nothing, and the enrollment check never reads the cache", async () => {
    const { adapter, authenticate, verifyIdentity } = setup()
    const cache = await issuedCache(adapter)
    authenticate.mockRejectedValueOnce(new Error("refused"))
    const refused = request(`${SESSION}=other.sig; ${cache}`)
    await expect(adapter.authenticate(refused)).rejects.toThrow("refused")
    expect(adapter.responseCookies(refused)).toEqual([])
    await adapter.verifyIdentity(request(`${SESSION}=token.sig; ${cache}`))
    expect(verifyIdentity).toHaveBeenCalledTimes(1)
  })
})

describe("retireBrowserPrincipalCache", () => {
  test("clears the cache on an answer that sets or clears the session cookie, and leaves any other answer alone", () => {
    const signedOut = new Response(null, { headers: [["set-cookie", `${SESSION}=; Max-Age=0; Path=/`]] })
    expect(retireBrowserPrincipalCache(signedOut, SESSION).headers.getSetCookie()).toEqual([
      `${SESSION}=; Max-Age=0; Path=/`,
      "__Host-claxedo.principal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    ])
    const other = new Response(null, { headers: [["set-cookie", "__Secure-claxedo.state=x; Path=/"]] })
    expect(retireBrowserPrincipalCache(other, SESSION).headers.getSetCookie()).toEqual(["__Secure-claxedo.state=x; Path=/"])
  })
})
