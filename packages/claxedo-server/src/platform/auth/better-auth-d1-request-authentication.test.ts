import { describe, expect, test, vi } from "vitest"

import {
  AuthenticationError,
  type ApplicationIdentityResolution,
  type AuthAdapterDescriptor,
} from "@claxedo/server-core/platform/auth/authentication"

import { createBetterAuthD1RequestAuthenticationAdapter } from "./better-auth-d1-request-authentication"

const NOW = 1_800_000_000_000
const descriptor = {
  adapter: "better-auth",
  deploymentId: "deployment_1",
  configurationVersion: "auth-v1",
  expiresAt: 4_102_444_800_000,
  issuer: "https://api.example.test/api/auth",
  methods: ["google", "github"],
  browser: {
    transport: "cookie",
    credentialPolicy: "reject-cookie-and-authorization",
    trustedOrigins: ["https://app.example.test"],
    clientId: "claxedo-browser",
    resource: "https://api.example.test/control-plane",
    scopes: ["workspace:read", "workspace:write"],
    cookie: {
      name: "__Secure-claxedo.session_token",
      path: "/",
      secure: true,
      httpOnly: true,
      hostOnly: true,
      sameSite: "lax",
    },
  },
  native: {
    cli: {
      flow: "device-authorization",
      clientId: "claxedo-cli",
      resource: "https://api.example.test/control-plane",
      scopes: ["openid", "profile", "email", "offline_access", "workspace:read", "workspace:write"],
      tokenEndpointOrigin: "https://api.example.test",
      controlPlaneOrigin: "https://api.example.test",
      revocation: {
        protocol: "rfc7009",
        endpoint: "https://api.example.test/api/auth/oauth2/revoke",
        tokenEndpointAuthMethod: "none",
      },
    },
    desktop: {
      flow: "authorization-code-pkce",
      clientId: "claxedo-desktop",
      resource: "https://api.example.test/control-plane",
      scopes: ["openid", "profile", "email", "offline_access", "workspace:read", "workspace:write"],
      tokenEndpointOrigin: "https://api.example.test",
      controlPlaneOrigin: "https://api.example.test",
      revocation: {
        protocol: "rfc7009",
        endpoint: "https://api.example.test/api/auth/oauth2/revoke",
        tokenEndpointAuthMethod: "none",
      },
    },
  },
} as const satisfies AuthAdapterDescriptor

const activeIdentity = async (): Promise<ApplicationIdentityResolution> => ({
  state: "active",
  userId: "app_user_1",
  actorId: "human_actor_1",
})

function browserSession() {
  return {
    user: { id: "better_auth_user_1" },
    session: {
      id: "browser_session_1",
      createdAt: new Date(NOW - 60_000),
    },
  }
}

function nativeIntrospection(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    iss: descriptor.issuer,
    sub: "better_auth_user_1",
    sid: "native_session_1",
    client_id: descriptor.native.cli.clientId,
    aud: descriptor.native.cli.resource,
    scope: "offline_access workspace:read",
    iat: Math.floor((NOW - 60_000) / 1_000),
    exp: Math.floor((NOW + 240_000) / 1_000),
    token_type: "Bearer",
    ...overrides,
  }
}

function setup(overrides: {
  getSession?: () => Promise<unknown>
  oauth2Introspect?: (input: unknown) => Promise<unknown>
  resolveIdentity?: () => Promise<ApplicationIdentityResolution>
} = {}) {
  const getSession = vi.fn(overrides.getSession ?? (async () => browserSession()))
  const oauth2Introspect = vi.fn(overrides.oauth2Introspect ?? (async () => nativeIntrospection()))
  const resolveIdentity = vi.fn(overrides.resolveIdentity ?? activeIdentity)
  const resolveAuthenticationEvidence = vi.fn(async (input: { kind: string }) => input.kind === "browser"
    ? {
        sessionId: "browser_session_1",
        authenticatedAt: NOW - 60_000,
        methods: ["oauth:google"] as const,
        assurance: "single-factor" as const,
      }
    : {
        sessionId: "native_session_1",
        authenticatedAt: NOW - 60_000,
        methods: ["oauth:google"] as const,
        assurance: "single-factor" as const,
      })

  return {
    getSession,
    oauth2Introspect,
    resolveIdentity,
    resolveAuthenticationEvidence,
    adapter: createBetterAuthD1RequestAuthenticationAdapter({
      descriptor,
      auth: { api: { getSession, oauth2Introspect } },
      nativeIntrospectionClient: {
        clientId: "claxedo-control-plane",
        clientSecret: "server-held-introspection-secret",
      },
      resolveAuthenticationEvidence,
      resolveIdentity,
      now: () => NOW,
    }),
  }
}

describe("Better Auth D1 request authentication", () => {
  test("verifies the exact browser session cookie through Better Auth and delegates identity mapping", async () => {
    const configured = setup()
    const request = new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "unrelated=ok; __Secure-claxedo.session_token=opaque-session",
        origin: "https://app.example.test",
      },
    })

    await expect(configured.adapter.authenticate(request)).resolves.toMatchObject({
      userId: "app_user_1",
      actorId: "human_actor_1",
      sessionId: "browser_session_1",
      authenticatedAt: NOW - 60_000,
      methods: ["oauth:google"],
      assurance: "single-factor",
      identity: {
        adapter: "better-auth",
        issuer: descriptor.issuer,
        subject: "better_auth_user_1",
      },
      client: {
        kind: "browser",
        tokenKind: "browser-session",
        origin: "https://app.example.test",
      },
    })
    expect(configured.getSession).toHaveBeenCalledWith({
      headers: request.headers,
      query: { disableCookieCache: true, disableRefresh: true },
    })
    expect(configured.resolveIdentity).toHaveBeenCalledWith({
      adapter: "better-auth",
      issuer: descriptor.issuer,
      subject: "better_auth_user_1",
    }, expect.any(Request))
  })

  test("verifies a native opaque bearer through Better Auth introspection", async () => {
    const configured = setup()

    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: { authorization: "Bearer clx_at_native-secret" },
    }))).resolves.toMatchObject({
      identity: { subject: "better_auth_user_1" },
      client: {
        kind: "cli",
        id: "claxedo-cli",
        tokenKind: "access-token",
        resource: descriptor.native.cli.resource,
        scopes: ["offline_access", "workspace:read"],
        deploymentId: descriptor.deploymentId,
      },
    })
    expect(configured.oauth2Introspect).toHaveBeenCalledWith({
      body: {
        client_id: "claxedo-control-plane",
        client_secret: "server-held-introspection-secret",
        token: "clx_at_native-secret",
        token_type_hint: "access_token",
      },
    })
  })

  test("accepts the issuer's own userinfo endpoint as an extra audience on openid tokens", async () => {
    // With the `openid` scope Better Auth adds `${issuer}/oauth2/userinfo` to
    // `aud`. Rejecting it signed the desktop out on its first product request.
    const configured = setup({
      oauth2Introspect: async () => nativeIntrospection({
        aud: [descriptor.native.cli.resource, `${descriptor.issuer}/oauth2/userinfo`],
        scope: "openid profile email offline_access workspace:read",
      }),
    })

    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: { authorization: "Bearer clx_at_native-secret" },
    }))).resolves.toMatchObject({
      identity: { subject: "better_auth_user_1" },
      client: {
        kind: "cli",
        tokenKind: "access-token",
        resource: descriptor.native.cli.resource,
        scopes: ["openid", "profile", "email", "offline_access", "workspace:read"],
      },
    })
  })

  test("rejects cookie plus Authorization before either Better Auth API is called", async () => {
    const configured = setup()

    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "__Secure-claxedo.session_token=opaque-session",
        authorization: "Bearer clx_at_native-secret",
        origin: "https://app.example.test",
      },
    }))).rejects.toMatchObject({ status: 401, code: "ambiguous_credentials" })
    expect(configured.getSession).not.toHaveBeenCalled()
    expect(configured.oauth2Introspect).not.toHaveBeenCalled()
  })

  test("does not let unrelated cookies switch a valid native bearer to browser auth", async () => {
    const configured = setup()

    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "unrelated=ok",
        authorization: "Bearer clx_at_native-secret",
      },
    }))).resolves.toMatchObject({ client: { kind: "cli" } })
    expect(configured.getSession).not.toHaveBeenCalled()
    expect(configured.oauth2Introspect).toHaveBeenCalledTimes(1)
  })

  test("binds browser sessions to the trusted request origin", async () => {
    const configured = setup()
    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "__Secure-claxedo.session_token=opaque-session",
        origin: "https://lookalike.example.test",
      },
    }))).rejects.toMatchObject({ status: 401, code: "invalid_credentials" })
    expect(configured.resolveIdentity).not.toHaveBeenCalled()
  })

  test.each([
    ["inactive token", nativeIntrospection({ active: false })],
    ["wrong issuer", nativeIntrospection({ iss: "https://other.example.test/api/auth" })],
    ["wrong audience", nativeIntrospection({ aud: "https://other.example.test/control-plane" })],
    ["a foreign audience alongside the control plane", nativeIntrospection({
      aud: [descriptor.native.cli.resource, "https://other.example.test/control-plane"],
    })],
    ["only the userinfo audience", nativeIntrospection({ aud: `${descriptor.issuer}/oauth2/userinfo` })],
    ["unknown client", nativeIntrospection({ client_id: "other-client" })],
    ["missing subject", nativeIntrospection({ sub: undefined })],
  ])("rejects an introspection result with %s", async (_name, result) => {
    const configured = setup({ oauth2Introspect: async () => result })
    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: { authorization: "Bearer clx_at_native-secret" },
    }))).rejects.toMatchObject({ status: 401, code: "invalid_credentials" })
    expect(configured.resolveIdentity).not.toHaveBeenCalled()
  })

  test("rejects native scopes or persisted evidence outside the introspected credential", async () => {
    const excessiveScope = setup({
      oauth2Introspect: async () => nativeIntrospection({ scope: "workspace:read admin" }),
    })
    await expect(excessiveScope.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: { authorization: "Bearer clx_at_native-secret" },
    }))).rejects.toMatchObject({ status: 401, code: "invalid_credentials" })

    const mismatchedSession = setup()
    mismatchedSession.resolveAuthenticationEvidence.mockResolvedValueOnce({
      sessionId: "different_session",
      authenticatedAt: NOW - 60_000,
      methods: ["oauth:google"],
      assurance: "single-factor",
    })
    await expect(mismatchedSession.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: { authorization: "Bearer clx_at_native-secret" },
    }))).rejects.toMatchObject({ status: 401, code: "invalid_credentials" })
  })

  test("rejects malformed or absent credentials without calling Better Auth", async () => {
    for (const authorization of [undefined, "Basic secret", "Bearer", "Bearer one two"]) {
      const configured = setup()
      const headers = authorization ? { authorization } : undefined
      await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", { headers })))
        .rejects.toMatchObject({ status: 401, code: "invalid_credentials" })
      expect(configured.getSession).not.toHaveBeenCalled()
      expect(configured.oauth2Introspect).not.toHaveBeenCalled()
    }
  })

  test("fails closed when Better Auth or authentication evidence is unavailable", async () => {
    const betterAuthUnavailable = setup({ getSession: async () => { throw new Error("D1 unavailable") } })
    await expect(betterAuthUnavailable.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "__Secure-claxedo.session_token=opaque-session",
        origin: "https://app.example.test",
      },
    }))).rejects.toEqual(new AuthenticationError(503, "auth_unavailable", "Authentication verifier is unavailable"))

    const evidenceUnavailable = setup()
    evidenceUnavailable.resolveAuthenticationEvidence.mockRejectedValueOnce(new Error("evidence unavailable"))
    await expect(evidenceUnavailable.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "__Secure-claxedo.session_token=opaque-session",
        origin: "https://app.example.test",
      },
    }))).rejects.toMatchObject({ status: 503, code: "auth_unavailable" })
  })

  test("never creates an application user when identity mapping is not active", async () => {
    const configured = setup({ resolveIdentity: async () => ({ state: "provisioning", retryAfterMs: 100 }) })
    await expect(configured.adapter.authenticate(new Request("https://api.example.test/bootstrap", {
      headers: {
        cookie: "__Secure-claxedo.session_token=opaque-session",
        origin: "https://app.example.test",
      },
    }))).rejects.toMatchObject({ status: 503, code: "identity_provisioning" })
  })
})
