import { describe, expect, test } from "bun:test"
import { browserAuthUnavailable, loadBrowserAuthDescriptor } from "./browser-auth"

const betterAuthDescriptor = {
  adapter: "better-auth",
  deploymentId: "deployment_1",
  configurationVersion: "auth-v1",
  expiresAt: 4_102_444_800_000,
  issuer: "https://api.example.test/api/auth",
  methods: ["github", "email-password"],
  browser: {
    transport: "cookie",
    credentialPolicy: "reject-cookie-and-authorization",
    trustedOrigins: ["https://app.example.test"],
    clientId: "claxedo-browser",
    resource: "https://api.example.test/control-plane",
    scopes: ["control-plane:read", "control-plane:write"],
    cookie: {
      name: "__Secure-claxedo.session_token",
      path: "/",
      secure: true,
      httpOnly: true,
      hostOnly: true,
      sameSite: "lax",
    },
  },
}

describe("browser auth descriptor boundary", () => {
  test("loads the Better Auth cookie contract from the exact API origin with credentials", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = []
    const descriptor = await loadBrowserAuthDescriptor({
      selectedAdapter: "better-auth",
      apiOrigin: "https://api.example.test",
      appOrigin: "https://app.example.test",
      request: async (input, init) => {
        requests.push({ input, init })
        return Response.json(betterAuthDescriptor)
      },
    })

    expect(requests).toEqual([
      {
        input: "https://api.example.test/api/claxedo/auth/descriptor",
        init: { credentials: "include", headers: { accept: "application/json" } },
      },
    ])
    expect(descriptor.adapter).toBe("better-auth")
    expect(descriptor.methods).toEqual(["github", "email-password"])
  })

  test.each([
    ["API origin", { apiOrigin: "http://api.example.test" }],
    ["app origin", { appOrigin: "http://app.example.test" }],
  ])("rejects an insecure %s before requesting the descriptor", async (_, overrides) => {
    let requested = false
    await expect(
      loadBrowserAuthDescriptor({
        selectedAdapter: "better-auth",
        apiOrigin: "https://api.example.test",
        appOrigin: "https://app.example.test",
        ...overrides,
        request: async () => {
          requested = true
          return Response.json(betterAuthDescriptor)
        },
      }),
    ).rejects.toThrow("exact HTTPS API and app origins")
    expect(requested).toBe(false)
  })

  test.each([
    ["issuer", { issuer: "http://api.example.test/api/auth" }],
    ["resource", { browser: { ...betterAuthDescriptor.browser, resource: "http://api.example.test/control-plane" } }],
    [
      "trusted app origin",
      { browser: { ...betterAuthDescriptor.browser, trustedOrigins: ["http://app.example.test"] } },
    ],
  ])("rejects an insecure descriptor %s", async (_, overrides) => {
    await expect(
      loadBrowserAuthDescriptor({
        selectedAdapter: "better-auth",
        apiOrigin: "https://api.example.test",
        appOrigin: "https://app.example.test",
        request: async () => Response.json({ ...betterAuthDescriptor, ...overrides }),
      }),
    ).rejects.toBeInstanceOf(Error)
  })

  test.each([
    ["adapter", { adapter: "other-adapter" }],
    ["transport", { browser: { ...betterAuthDescriptor.browser, transport: "bearer" } }],
    ["credential policy", { browser: { ...betterAuthDescriptor.browser, credentialPolicy: "authorization-only" } }],
    ["expiry", { expiresAt: 0 }],
  ])("rejects live descriptor %s drift instead of falling back", async (_, overrides) => {
    await expect(
      loadBrowserAuthDescriptor({
        selectedAdapter: "better-auth",
        apiOrigin: "https://api.example.test",
        appOrigin: "https://app.example.test",
        request: async () => Response.json({ ...betterAuthDescriptor, ...overrides }),
      }),
    ).rejects.toThrow("does not match the better-auth browser build")
  })
})

describe("browser sign-in availability", () => {
  test("a central that issues no sessions has no accounts to offer", () => {
    // The desktop daemon and the unsigned self-host. The composition root
    // reads the server's own declaration and hands it down, so no descriptor
    // is requested and no provider SDK is loaded — even though this HTTPS
    // origin would otherwise pass every check below.
    expect(
      browserAuthUnavailable({
        apiOrigin: "https://api.example.test",
        appOrigin: "https://app.example.test",
        issuesSessions: false,
      }),
    ).toContain("issues no sessions")
  })

  test("a plain-http deployment cannot run the HTTPS-only descriptor contract", () => {
    // A plain-http self-host, and any http app origin: both are deployments
    // without a sign-in flow, reported as a reason rather than thrown, so the
    // shell and `/login` render either way.
    expect(browserAuthUnavailable({ apiOrigin: "http://api.example.test", appOrigin: "https://app.example.test", issuesSessions: true }))
      .toContain("HTTPS")
    expect(browserAuthUnavailable({ apiOrigin: "https://api.example.test", appOrigin: "http://app.example.test", issuesSessions: true }))
      .toContain("HTTPS")
  })

  test("the hosted HTTPS composition has a sign-in flow", () => {
    expect(
      browserAuthUnavailable({
        apiOrigin: "https://api.example.test",
        appOrigin: "https://app.example.test",
        issuesSessions: true,
      }),
    ).toBeNull()
  })
})
