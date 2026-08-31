import { describe, expect, test, vi } from "vitest"

import {
  AuthenticationError,
  authenticateControlPlaneRequest,
  createControlPlaneAuthenticationAdapter,
  type ApplicationIdentityResolution,
  type AuthAccountLifecycle,
  type AuthAccountOperationStatus,
  type AuthAdapterDescriptor,
  type VerifiedAuthSession,
} from "./authentication"

const NOW = 1_800_000_000_000

const betterAuthDescriptor = {
  adapter: "better-auth",
  deploymentId: "deployment_1",
  configurationVersion: "auth-v1",
  expiresAt: 4_102_444_800_000,
  issuer: "https://auth.example.test",
  methods: ["google", "github"],
  browser: {
    transport: "cookie",
    credentialPolicy: "reject-cookie-and-authorization",
    trustedOrigins: ["https://app.example.test"],
    clientId: "claxedo-browser",
    resource: "https://api.example.test",
    scopes: ["control-plane:read", "control-plane:write"],
    cookie: {
      name: "better-auth.session_token",
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
      resource: "https://api.example.test",
      scopes: ["control-plane:read", "control-plane:write"],
      tokenEndpointOrigin: "https://auth.example.test",
      controlPlaneOrigin: "https://api.example.test",
      revocation: {
        protocol: "rfc7009",
        endpoint: "https://auth.example.test/oauth2/revoke",
        tokenEndpointAuthMethod: "none",
      },
    },
    desktop: {
      flow: "authorization-code-pkce",
      clientId: "claxedo-desktop",
      resource: "https://api.example.test",
      scopes: ["control-plane:read", "control-plane:write"],
      tokenEndpointOrigin: "https://auth.example.test",
      controlPlaneOrigin: "https://api.example.test",
      revocation: {
        protocol: "rfc7009",
        endpoint: "https://auth.example.test/oauth2/revoke",
        tokenEndpointAuthMethod: "none",
      },
    },
  },
} as const satisfies AuthAdapterDescriptor

function browserSession(overrides: Record<string, unknown> = {}): unknown {
  return {
    adapter: "better-auth",
    issuer: "https://auth.example.test",
    subject: "provider_subject_1",
    sessionId: "session_1",
    authenticatedAt: NOW - 60_000,
    methods: ["oauth:google"],
    assurance: "single-factor",
    client: {
      id: "claxedo-browser",
      kind: "browser",
      resource: "https://api.example.test",
      scopes: ["control-plane:read", "control-plane:write"],
      tokenKind: "browser-session",
      origin: "https://app.example.test",
    },
    ...overrides,
  }
}

function nativeSession(overrides: Record<string, unknown> = {}): unknown {
  return {
    adapter: "better-auth",
    issuer: "https://auth.example.test",
    subject: "provider_subject_1",
    sessionId: "session_native_1",
    authenticatedAt: NOW - 60_000,
    methods: ["oauth:google"],
    assurance: "single-factor",
    client: {
      id: "claxedo-cli",
      kind: "cli",
      resource: "https://api.example.test",
      scopes: ["control-plane:read"],
      tokenKind: "access-token",
      deploymentId: "deployment_1",
      adapter: "better-auth",
      issuer: "https://auth.example.test",
      tokenEndpointOrigin: "https://auth.example.test",
      controlPlaneOrigin: "https://api.example.test",
    },
    ...overrides,
  }
}

const activeIdentity = async (): Promise<ApplicationIdentityResolution> => ({
  state: "active",
  userId: "user_1",
  actorId: "actor_human_1",
})

function adapter(input: {
  verify?: () => Promise<unknown>
  resolveIdentity?: () => Promise<ApplicationIdentityResolution>
  descriptor?: AuthAdapterDescriptor
} = {}) {
  return createControlPlaneAuthenticationAdapter({
    descriptor: input.descriptor ?? betterAuthDescriptor,
    verify: input.verify ?? (async () => browserSession()),
    resolveIdentity: input.resolveIdentity ?? activeIdentity,
    now: () => NOW,
  })
}

describe("provider-neutral control-plane authentication", () => {
  test("maps one verified adapter identity to one application user and immutable human actor", async () => {
    const verify = vi.fn(async () => browserSession())
    const resolveIdentity = vi.fn(activeIdentity)
    const selected = adapter({ verify, resolveIdentity })

    await expect(authenticateControlPlaneRequest(new Request("https://api.example.test", {
      headers: { cookie: "better-auth.session_token=opaque" },
    }), selected)).resolves.toMatchObject({
      userId: "user_1",
      actorId: "actor_human_1",
      actorKind: "human",
      deploymentId: "deployment_1",
      sessionId: "session_1",
      assurance: "single-factor",
      identity: {
        adapter: "better-auth",
        issuer: "https://auth.example.test",
        subject: "provider_subject_1",
      },
    })
    expect(resolveIdentity).toHaveBeenCalledWith(
      {
        adapter: "better-auth",
        issuer: "https://auth.example.test",
        subject: "provider_subject_1",
      },
      expect.any(Request),
    )
  })

  test("verifies an enrollment identity without creating or resolving an application account", async () => {
    const verify = vi.fn(async () => browserSession())
    const resolveIdentity = vi.fn(activeIdentity)
    const selected = adapter({ verify, resolveIdentity })

    await expect(selected.verifyIdentity(new Request("https://api.example.test", {
      headers: { cookie: "better-auth.session_token=opaque" },
    }))).resolves.toEqual({
      adapter: "better-auth",
      issuer: "https://auth.example.test",
      subject: "provider_subject_1",
    })
    expect(verify).toHaveBeenCalledOnce()
    expect(resolveIdentity).not.toHaveBeenCalled()
  })

  test("uses the selected adapter once and preserves invalid proof versus verifier outage", async () => {
    const invalid = vi.fn(async () => {
      throw new AuthenticationError(401, "invalid_credentials", "credential rejected")
    })
    await expect(adapter({ verify: invalid }).authenticate(new Request("https://api.example.test"))).rejects.toMatchObject({
      status: 401,
      code: "invalid_credentials",
    })
    expect(invalid).toHaveBeenCalledTimes(1)

    const unavailable = vi.fn(async () => {
      throw new Error("provider detail that must not cross the boundary")
    })
    await expect(adapter({ verify: unavailable }).authenticate(new Request("https://api.example.test"))).rejects.toEqual(
      new AuthenticationError(503, "auth_unavailable", "Authentication verifier is unavailable"),
    )
    expect(unavailable).toHaveBeenCalledTimes(1)
  })

  test("classifies every application identity lifecycle state without recreating an account", async () => {
    const cases: Array<[ApplicationIdentityResolution, number, string]> = [
      [{ state: "provisioning", retryAfterMs: 100 }, 503, "identity_provisioning"],
      [{ state: "suspended" }, 403, "account_suspended"],
      [{ state: "deleted" }, 403, "account_deleted"],
      [{ state: "unavailable" }, 503, "auth_unavailable"],
    ]
    for (const [resolution, status, code] of cases) {
      await expect(adapter({ resolveIdentity: async () => resolution }).authenticate(
        new Request("https://api.example.test"),
      )).rejects.toMatchObject({ status, code })
    }

    await expect(adapter({ resolveIdentity: async () => { throw new Error("D1 unavailable") } }).authenticate(
      new Request("https://api.example.test"),
    )).rejects.toEqual(
      new AuthenticationError(503, "auth_unavailable", "Application identity mapping is unavailable"),
    )
  })

  test("rejects exact session-cookie plus Authorization ambiguity before verification", async () => {
    const verify = vi.fn(async () => browserSession())
    const selected = adapter({ verify })

    await expect(selected.authenticate(new Request("https://api.example.test", {
      headers: {
        cookie: "unrelated=ok; better-auth.session_token=opaque",
        authorization: "Bearer other",
      },
    }))).rejects.toMatchObject({ status: 401, code: "ambiguous_credentials" })
    expect(verify).not.toHaveBeenCalled()

    await expect(selected.authenticate(new Request("https://api.example.test", {
      headers: { cookie: "unrelated=ok", authorization: "Bearer selected-adapter-value" },
    }))).resolves.toMatchObject({ userId: "user_1" })
    expect(verify).toHaveBeenCalledTimes(1)
  })

  test("rejects output from a different adapter, issuer, or browser origin", async () => {
    for (const verified of [
      browserSession({ adapter: "clerk" }),
      browserSession({ issuer: "https://other-issuer.example.test" }),
      browserSession({
        client: {
          ...(browserSession() as VerifiedAuthSession).client,
          origin: "https://lookalike.example.test",
        },
      }),
    ]) {
      await expect(adapter({ verify: async () => verified }).authenticate(
        new Request("https://api.example.test"),
      )).rejects.toMatchObject({ status: 401, code: "invalid_credentials" })
    }
  })

  test("accepts a fully deployment-bound native credential", async () => {
    await expect(adapter({ verify: async () => nativeSession() }).authenticate(
      new Request("https://api.example.test", { headers: { authorization: "Bearer native" } }),
    )).resolves.toMatchObject({
      client: {
        kind: "cli",
        deploymentId: "deployment_1",
        adapter: "better-auth",
        issuer: "https://auth.example.test",
        tokenEndpointOrigin: "https://auth.example.test",
        controlPlaneOrigin: "https://api.example.test",
      },
    })
  })

  test.each([
    ["deploymentId", "deployment_2"],
    ["adapter", "clerk"],
    ["issuer", "https://other-auth.example.test"],
    ["tokenEndpointOrigin", "https://other-auth.example.test"],
    ["controlPlaneOrigin", "https://other-api.example.test"],
    ["id", "other-client"],
    ["resource", "https://other-api.example.test"],
    ["tokenKind", "browser-session"],
  ])("rejects a native credential with mismatched %s", async (field, value) => {
    const valid = nativeSession() as VerifiedAuthSession
    await expect(adapter({
      verify: async () => nativeSession({ client: { ...valid.client, [field]: value } }),
    }).authenticate(new Request("https://api.example.test"))).rejects.toMatchObject({
      status: 401,
      code: "invalid_credentials",
    })
  })

  test("runtime-validates every adapter field and downgrades missing assurance", async () => {
    const malformed: unknown[] = [
      browserSession({ assurance: "magic" }),
      browserSession({ authenticatedAt: Number.NaN }),
      browserSession({ authenticatedAt: NOW + 60_001 }),
      browserSession({ methods: [""] }),
      browserSession({ methods: ["oauth:google", "oauth:google"] }),
      browserSession({ methods: ["provider-private-value"] }),
      browserSession({ client: { ...(browserSession() as VerifiedAuthSession).client, kind: "robot" } }),
      browserSession({ client: { ...(browserSession() as VerifiedAuthSession).client, id: 123 } }),
      browserSession({ client: { ...(browserSession() as VerifiedAuthSession).client, tokenKind: "access-token" } }),
      browserSession({ client: { ...(browserSession() as VerifiedAuthSession).client, scopes: ["control-plane:read", "control-plane:read"] } }),
    ]
    for (const verified of malformed) {
      await expect(adapter({ verify: async () => verified }).authenticate(
        new Request("https://api.example.test"),
      )).rejects.toMatchObject({ status: 401, code: "invalid_credentials" })
    }

    const withoutAssurance = browserSession()
    delete (withoutAssurance as Record<string, unknown>).assurance
    await expect(adapter({ verify: async () => withoutAssurance }).authenticate(
      new Request("https://api.example.test"),
    )).resolves.toMatchObject({ assurance: "insufficient" })
  })

  test("rejects invalid descriptor origins, methods, cookie posture, and Better Auth native flows", () => {
    const invalidDescriptors: AuthAdapterDescriptor[] = [
      { ...betterAuthDescriptor, issuer: "http://auth.example.test" },
      { ...betterAuthDescriptor, methods: ["google", "google"] },
      { ...betterAuthDescriptor, methods: ["unknown"] as never },
      {
        ...betterAuthDescriptor,
        browser: { ...betterAuthDescriptor.browser, trustedOrigins: ["https://*.example.test"] },
      },
      {
        ...betterAuthDescriptor,
        browser: { ...betterAuthDescriptor.browser, cookie: { ...betterAuthDescriptor.browser.cookie, secure: false as true } },
      },
      {
        ...betterAuthDescriptor,
        native: { ...betterAuthDescriptor.native, cli: { ...betterAuthDescriptor.native.cli, flow: "adapter-native" } },
      },
    ]

    for (const descriptor of invalidDescriptors) {
      expect(() => adapter({ descriptor })).toThrowError(AuthenticationError)
    }
  })

  test("accepts an exact HTTPS issuer path and rejects non-exact issuer URLs", () => {
    expect(() => adapter({
      descriptor: {
        ...betterAuthDescriptor,
        issuer: "https://auth.example.test/api/auth",
        native: {
          cli: {
            ...betterAuthDescriptor.native.cli,
            revocation: {
              ...betterAuthDescriptor.native.cli.revocation,
              endpoint: "https://auth.example.test/api/auth/oauth2/revoke",
            },
          },
          desktop: {
            ...betterAuthDescriptor.native.desktop,
            revocation: {
              ...betterAuthDescriptor.native.desktop.revocation,
              endpoint: "https://auth.example.test/api/auth/oauth2/revoke",
            },
          },
        },
      },
    })).not.toThrow()

    for (const issuer of [
      "https://auth.example.test/api/auth?deployment=other",
      "https://auth.example.test/api/auth#other",
      "https://*.example.test/api/auth",
    ]) {
      expect(() => adapter({ descriptor: { ...betterAuthDescriptor, issuer } })).toThrowError(AuthenticationError)
    }
  })

  test("binds native RFC 7009 revocation to the selected issuer, deployment origin, and resource", () => {
    expect(() => adapter({ descriptor: betterAuthDescriptor })).not.toThrow()

    const invalidDescriptors: AuthAdapterDescriptor[] = [
      {
        ...betterAuthDescriptor,
        native: {
          ...betterAuthDescriptor.native,
          cli: {
            ...betterAuthDescriptor.native.cli,
            revocation: {
              ...betterAuthDescriptor.native.cli.revocation,
              endpoint: "https://other-auth.example.test/oauth2/revoke",
            },
          },
        },
      },
      {
        ...betterAuthDescriptor,
        native: {
          ...betterAuthDescriptor.native,
          cli: {
            ...betterAuthDescriptor.native.cli,
            revocation: {
              ...betterAuthDescriptor.native.cli.revocation,
              endpoint: "https://auth.example.test/other/revoke",
            },
          },
        },
      },
      {
        ...betterAuthDescriptor,
        native: {
          ...betterAuthDescriptor.native,
          cli: {
            ...betterAuthDescriptor.native.cli,
            revocation: {
              ...betterAuthDescriptor.native.cli.revocation,
              tokenEndpointAuthMethod: "client_secret_post" as "none",
            },
          },
        },
      },
      {
        ...betterAuthDescriptor,
        native: {
          ...betterAuthDescriptor.native,
          cli: { ...betterAuthDescriptor.native.cli, resource: "https://other-api.example.test/control-plane" },
        },
      },
    ]
    for (const descriptor of invalidDescriptors) {
      expect(() => adapter({ descriptor })).toThrowError(AuthenticationError)
    }
  })

  test("rejects missing or unknown native revocation contracts at the runtime descriptor boundary", () => {
    const clerkDescriptor = {
      ...betterAuthDescriptor,
      adapter: "clerk",
      issuer: "https://clerk.example.test",
      methods: ["clerk"],
      browser: {
        transport: "bearer",
        credentialPolicy: "authorization-only",
        trustedOrigins: betterAuthDescriptor.browser.trustedOrigins,
        clientId: betterAuthDescriptor.browser.clientId,
        resource: betterAuthDescriptor.browser.resource,
        scopes: betterAuthDescriptor.browser.scopes,
      },
      native: {
        cli: {
          ...betterAuthDescriptor.native.cli,
          flow: "adapter-native",
          tokenEndpointOrigin: "https://clerk.example.test",
          revocation: {
            protocol: "adapter-native",
            endpoint: "https://clerk.example.test/native/revoke",
          },
        },
        desktop: {
          ...betterAuthDescriptor.native.desktop,
          flow: "adapter-native",
          tokenEndpointOrigin: "https://clerk.example.test",
          revocation: {
            protocol: "adapter-native",
            endpoint: "https://clerk.example.test/native/revoke",
          },
        },
      },
    } as const satisfies AuthAdapterDescriptor

    const invalidDescriptors = [
      {
        ...clerkDescriptor,
        native: {
          ...clerkDescriptor.native,
          cli: { ...clerkDescriptor.native.cli, revocation: undefined },
        },
      },
      {
        ...clerkDescriptor,
        native: {
          ...clerkDescriptor.native,
          cli: {
            ...clerkDescriptor.native.cli,
            revocation: {
              protocol: "unknown",
              endpoint: clerkDescriptor.native.cli.revocation.endpoint,
            },
          },
        },
      },
      {
        ...clerkDescriptor,
        native: {
          ...clerkDescriptor.native,
          cli: {
            ...clerkDescriptor.native.cli,
            revocation: {
              protocol: "rfc7009",
              endpoint: clerkDescriptor.native.cli.revocation.endpoint,
            },
          },
        },
      },
    ] as unknown as AuthAdapterDescriptor[]

    for (const descriptor of invalidDescriptors) {
      expect(() => adapter({ descriptor })).toThrowError(AuthenticationError)
    }
  })

  test("Clerk and Better Auth execute through the same neutral principal boundary", async () => {
    const clerkDescriptor = {
      ...betterAuthDescriptor,
      adapter: "clerk",
      issuer: "https://clerk.example.test",
      methods: ["clerk"],
      browser: {
        transport: "bearer",
        credentialPolicy: "authorization-only",
        trustedOrigins: betterAuthDescriptor.browser.trustedOrigins,
        clientId: betterAuthDescriptor.browser.clientId,
        resource: betterAuthDescriptor.browser.resource,
        scopes: betterAuthDescriptor.browser.scopes,
      },
      native: {
        cli: {
          ...betterAuthDescriptor.native.cli,
          flow: "adapter-native",
          tokenEndpointOrigin: "https://clerk.example.test",
          revocation: {
            protocol: "adapter-native",
            endpoint: "https://clerk.example.test/native/revoke",
          },
        },
        desktop: {
          ...betterAuthDescriptor.native.desktop,
          flow: "adapter-native",
          tokenEndpointOrigin: "https://clerk.example.test",
          revocation: {
            protocol: "adapter-native",
            endpoint: "https://clerk.example.test/native/revoke",
          },
        },
      },
    } as const satisfies AuthAdapterDescriptor

    const selected = adapter({
      descriptor: clerkDescriptor,
      verify: async () => ({
        ...(browserSession() as Record<string, unknown>),
        adapter: "clerk",
        issuer: "https://clerk.example.test",
      }),
    })
    await expect(selected.authenticate(new Request("https://api.example.test", {
      headers: { authorization: "Bearer clerk" },
    }))).resolves.toMatchObject({ identity: { adapter: "clerk" }, actorKind: "human" })
  })

  test("the lifecycle port supports durable idempotent terminal deletion operations", async () => {
    const operations = new Map<string, AuthAccountOperationStatus>()
    const complete = async (operationId: string, kind: AuthAccountOperationStatus["kind"]) => {
      const existing = operations.get(operationId)
      if (existing) return existing
      const result = { state: "completed", operationId, kind, completedAt: NOW } as const
      operations.set(operationId, result)
      return result
    }
    const lifecycle: AuthAccountLifecycle = {
      disableAccount: ({ operationId }) => complete(operationId, "disable-account"),
      revokeAllSessions: ({ operationId }) => complete(operationId, "revoke-all-sessions"),
      deleteAccount: ({ operationId }) => complete(operationId, "delete-account"),
      operationStatus: async (operationId) => operations.get(operationId) ?? {
        state: "terminal-failure",
        operationId,
        kind: "delete-account",
        code: "operation_unknown",
      },
    }

    const first = await lifecycle.deleteAccount({ operationId: "delete_1", userId: "user_1" })
    const retry = await lifecycle.deleteAccount({ operationId: "delete_1", userId: "user_1" })
    expect(retry).toEqual(first)
    expect(await lifecycle.operationStatus("delete_1")).toEqual(first)
    expect("restore" in lifecycle).toBe(false)
  })
})
