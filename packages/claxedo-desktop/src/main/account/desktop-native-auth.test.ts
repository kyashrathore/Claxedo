import { describe, expect, test } from "bun:test"

import { createDesktopNativeAuth, revocationRejectedTheToken } from "./desktop-native-auth"
import { REDIRECT_PATH, type OAuthSeams } from "./oauth-flow"
import type { RefreshExchange } from "./electron-seams"

const NOW = 1_800_000_000_000
const CORE = "https://core.example.com"

function descriptor(adapter: "better-auth" | "clerk" = "better-auth") {
  const issuer = adapter === "better-auth" ? `${CORE}/api/auth` : "https://clerk.example.com"
  return {
    adapter,
    deploymentId: "deployment-1",
    configurationVersion: "auth-v1",
    expiresAt: NOW + 60_000,
    issuer,
    methods: adapter === "better-auth" ? ["github"] : ["clerk"],
    browser: { trustedOrigins: ["https://app.example.com"] },
    native: {
      cli: {},
      desktop: {
        flow: adapter === "better-auth" ? "authorization-code-pkce" : "adapter-native",
        clientId: `desktop-${adapter}`,
        resource: `${CORE}/control-plane`,
        scopes: ["offline_access", "workspace:read"],
        tokenEndpointOrigin: new URL(issuer).origin,
        controlPlaneOrigin: CORE,
        revocation:
          adapter === "better-auth"
            ? {
                protocol: "rfc7009",
                endpoint: `${CORE}/api/auth/oauth2/revoke`,
                tokenEndpointAuthMethod: "none",
              }
            : { protocol: "adapter-native", endpoint: "https://clerk.example.com/native/revoke" },
      },
    },
  }
}

function harness(adapter: "better-auth" | "clerk") {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const exchanges: Parameters<OAuthSeams["exchange"]>[0][] = []
  const refreshes: Parameters<RefreshExchange>[0][] = []
  let callback: ((url: string) => unknown) | undefined
  let opened = ""
  let clock = NOW
  const seams: OAuthSeams = {
    openExternal: async (url) => {
      opened = url
      queueMicrotask(() => {
        const state = new URL(url).searchParams.get("state")
        callback?.(`${REDIRECT_PATH}?code=code-1&state=${state}`)
      })
    },
    listen: async (handler) => {
      callback = handler
      return { port: 51_337, close: async () => {} }
    },
    exchange: async (input) => {
      exchanges.push(input)
      return { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 2_000_000_000 }
    },
    safeStorage: () => ({ available: true, platform: "darwin" }),
    setTimeout: () => ({ cancel: () => {} }),
  }
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    if (String(url) === `${CORE}/api/claxedo/auth/descriptor`) return Response.json(descriptor(adapter))
    return new Response(null, { status: 200 })
  }) as typeof fetch
  const refresh: RefreshExchange = async (input) => {
    refreshes.push(input)
    return {
      ok: true,
      tokens: { accessToken: "access-2", refreshToken: "refresh-2", expiresAt: 2_000_000_100 },
    }
  }
  const auth = createDesktopNativeAuth({ coreOrigin: CORE, seams, fetch: fetchImpl, refresh, now: () => clock })
  return {
    auth,
    requests,
    exchanges,
    refreshes,
    opened: () => opened,
    expireDescriptor: () => {
      clock = NOW + 60_001
    },
  }
}

describe("descriptor-selected desktop native auth", () => {
  test("runs Better Auth authorization code + S256 PKCE on an OS-assigned loopback port", async () => {
    const h = harness("better-auth")
    const signed = await h.auth.signIn()

    expect(signed).toMatchObject({ ok: true, credential: { binding: { adapter: "better-auth" } } })
    const authorize = new URL(h.opened())
    expect(authorize.origin + authorize.pathname).toBe(`${CORE}/api/auth/oauth2/authorize`)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("resource")).toBe(`${CORE}/control-plane`)
    expect(authorize.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:51337${REDIRECT_PATH}`)
    expect(h.exchanges).toEqual([
      expect.objectContaining({
        tokenUrl: `${CORE}/api/auth/oauth2/token`,
        clientId: "desktop-better-auth",
        resource: `${CORE}/control-plane`,
        redirectUri: `http://127.0.0.1:51337${REDIRECT_PATH}`,
      }),
    ])
  })

  test("uses only Clerk's adapter-native OAuth endpoints and never sends Better Auth resource syntax", async () => {
    const h = harness("clerk")
    const signed = await h.auth.signIn()
    if (!signed.ok) throw new Error(signed.detail)
    await h.auth.refresh(signed.credential)
    const revocation = await h.auth.revoke(signed.credential)

    expect(new URL(h.opened()).origin + new URL(h.opened()).pathname).toBe("https://clerk.example.com/oauth/authorize")
    expect(new URL(h.opened()).searchParams.get("resource")).toBeNull()
    expect(h.exchanges[0]).toMatchObject({ tokenUrl: "https://clerk.example.com/oauth/token" })
    expect(h.exchanges[0]).not.toHaveProperty("resource")
    expect(h.refreshes).toEqual([
      {
        tokenUrl: "https://clerk.example.com/oauth/token",
        clientId: "desktop-clerk",
        refreshToken: "refresh-1",
      },
    ])
    expect(revocation).toMatchObject({ state: "uncertain" })
    expect(h.requests.map((request) => request.url)).not.toContain("https://clerk.example.com/native/revoke")
  })

  test("revalidates descriptor expiry and immutable config before refresh and API use", async () => {
    const h = harness("better-auth")
    const signed = await h.auth.signIn()
    if (!signed.ok) throw new Error(signed.detail)
    ;(signed.credential.binding as { configurationVersion: string }).configurationVersion = "auth-v0"

    await expect(h.auth.validate(signed.credential)).rejects.toThrow(/selected authentication deployment/)
    await expect(h.auth.refresh(signed.credential)).rejects.toThrow(/selected authentication deployment/)
  })

  test("revokes Better Auth remotely with the bound public client and refresh token", async () => {
    const h = harness("better-auth")
    const signed = await h.auth.signIn()
    if (!signed.ok) throw new Error(signed.detail)

    await expect(h.auth.revoke(signed.credential)).resolves.toEqual({ state: "confirmed" })
    const request = h.requests.find((candidate) => candidate.url.endsWith("/oauth2/revoke"))
    expect(request?.init?.redirect).toBe("manual")
    const body = new URLSearchParams(String(request?.init?.body))
    expect(body.get("client_id")).toBe("desktop-better-auth")
    expect(body.get("token")).toBe("refresh-1")
    expect(body.get("resource")).toBeNull()
  })

  test("rechecks descriptor expiry before refresh, API validation, and logout", async () => {
    const h = harness("better-auth")
    const signed = await h.auth.signIn()
    if (!signed.ok) throw new Error(signed.detail)
    h.expireDescriptor()

    await expect(h.auth.validate(signed.credential)).rejects.toThrow(/expired/)
    await expect(h.auth.refresh(signed.credential)).rejects.toThrow(/expired/)
    await expect(h.auth.revoke(signed.credential)).resolves.toMatchObject({ state: "uncertain" })
    expect(h.requests.filter((request) => request.url.endsWith("/oauth2/revoke"))).toEqual([])
  })
})

describe("revocationRejectedTheToken", () => {
  test("treats a server rejection of the token as revoked", async () => {
    // Better Auth's answer for a token it does not recognize. Reading this as
    // merely uncertain left a pending intent that could never confirm, and
    // signIn refuses to start while one is pending.
    expect(
      await revocationRejectedTheToken(
        Response.json({ error: "invalid_request", error_description: "Invalid access token" }, { status: 400 }),
      ),
    ).toBe(true)
    expect(
      await revocationRejectedTheToken(Response.json({ error: "invalid_token" }, { status: 401 })),
    ).toBe(true)
    // Both shapes observed live on the same deployment, in either word order.
    expect(
      await revocationRejectedTheToken(
        Response.json({ error: "invalid_request", error_description: "token not found" }, { status: 400 }),
      ),
    ).toBe(true)
    expect(
      await revocationRejectedTheToken(
        Response.json({ error: "invalid_token", error_description: "refresh token not found" }, { status: 400 }),
      ),
    ).toBe(true)
  })

  test("keeps every answer that says nothing about the credential uncertain", async () => {
    expect(await revocationRejectedTheToken(Response.json({ error: "server_error" }, { status: 500 }))).toBe(false)
    expect(await revocationRejectedTheToken(Response.json({ error: "slow_down" }, { status: 429 }))).toBe(false)
    expect(await revocationRejectedTheToken(new Response("nope", { status: 400 }))).toBe(false)
    // A 400 that blames OUR request, not the token, is our bug to fix.
    expect(
      await revocationRejectedTheToken(
        Response.json({ error: "invalid_request", error_description: "client_id is required" }, { status: 400 }),
      ),
    ).toBe(false)
  })
})
