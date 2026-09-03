import { describe, expect, test } from "bun:test"
import { createAuthClient } from "better-auth/client"
import { createBetterAuthBrowserAdapter } from "./better-auth-browser-auth"

const descriptor = {
  adapter: "better-auth",
  deploymentId: "deployment_1",
  configurationVersion: "auth-v1",
  expiresAt: 4_102_444_800_000,
  issuer: "https://api.example.test/api/auth",
  methods: ["github"],
  browser: {
    transport: "cookie",
    credentialPolicy: "reject-cookie-and-authorization",
    trustedOrigins: ["https://app.example.test"],
    clientId: "claxedo-browser",
    resource: "https://api.example.test/control-plane",
    scopes: ["control-plane:read"],
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

/** The hosted composition every success-path case here runs against. */
const HOSTED = {
  apiOrigin: "https://api.example.test",
  appOrigin: "https://app.example.test",
  centralTransport: "signed-web",
} as const

describe("Better Auth browser adapter", () => {
  test("hydrates the cookie session and normalized profile, validated against the live descriptor", async () => {
    const clientOptions: unknown[] = []
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => Response.json(descriptor),
      createClient: (options) => {
        clientOptions.push(options)
        return {
          getSession: async () => ({
            data: {
              session: { id: "session_1" },
              user: { id: "user_1", name: "Ada", email: "ada@example.test", image: "https://img.test/ada" },
            },
            error: null,
          }),
          signIn: {
            social: async () => ({ data: null, error: null }),
            email: async () => ({ data: null, error: null }),
          },
          signUp: { email: async () => ({ data: null, error: null }) },
          signOut: async () => ({ data: null, error: null }),
        }
      },
    })

    await adapter.initialize(HOSTED)
    const auth = adapter.useAuth()

    expect(clientOptions).toEqual([
      {
        baseURL: "https://api.example.test",
        fetchOptions: { credentials: "include" },
      },
    ])
    expect(auth.methods()).toEqual(["github"])
    expect(auth.session()).toEqual({ id: "session_1" })
    expect(auth.user()).toEqual({
      id: "user_1",
      fullName: "Ada",
      imageUrl: "https://img.test/ada",
      primaryEmailAddress: { emailAddress: "ada@example.test" },
    })
    expect(auth.isSignedIn()).toBe(true)
  })

  // Falsifier for the boot request graph's serial descriptor→get-session
  // chain: the descriptor only validates configuration, it supplies nothing
  // the session client needs, so `initialize` fires both requests together.
  // If it reverted to chaining them, one side's gate would never open before
  // the other request is made, and this test would hang instead of resolving.
  test("initialize validates the descriptor and hydrates the session concurrently", async () => {
    const started: string[] = []
    let openDescriptorGate: () => void = () => {}
    let openSessionGate: () => void = () => {}
    const descriptorGate = new Promise<void>((resolve) => { openDescriptorGate = resolve })
    const sessionGate = new Promise<void>((resolve) => { openSessionGate = resolve })
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => {
        started.push("descriptor")
        openDescriptorGate()
        await sessionGate
        return Response.json(descriptor)
      },
      createClient: () => ({
        getSession: async () => {
          started.push("session")
          openSessionGate()
          await descriptorGate
          return {
            data: { session: { id: "session_1" }, user: { id: "user_1" } },
            error: null,
          }
        },
        signIn: {
          social: async () => ({ data: null, error: null }),
          email: async () => ({ data: null, error: null }),
        },
        signUp: { email: async () => ({ data: null, error: null }) },
        signOut: async () => ({ data: null, error: null }),
      }),
    })

    await adapter.initialize(HOSTED)

    expect(started.sort()).toEqual(["descriptor", "session"])
    expect(adapter.useAuth().isSignedIn()).toBe(true)
  })

  test("pins Better Auth 1.7.1 origin baseURL routing and social redirect response semantics", async () => {
    const requests: Array<{ url: string; method?: string }> = []
    const client = createAuthClient({
      baseURL: "https://api.example.test",
      fetchOptions: {
        credentials: "include",
        customFetchImpl: async (input, init) => {
          const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
          requests.push({ url, method: init?.method })
          const path = new URL(url).pathname
          return Response.json(
            path.endsWith("/get-session")
              ? { session: null, user: null }
              : { url: "https://github.example.test/authorize", redirect: false },
          )
        },
      },
    })

    await client.getSession()
    const social = await client.signIn.social({
      provider: "github",
      callbackURL: "https://app.example.test/after-auth",
    })

    expect(requests).toEqual([
      { url: "https://api.example.test/api/auth/get-session", method: "GET" },
      { url: "https://api.example.test/api/auth/sign-in/social", method: "POST" },
    ])
    expect(social.data).toEqual({ url: "https://github.example.test/authorize", redirect: false })
  })

  test("revalidates the immutable live descriptor binding and starts social redirect without requiring a session", async () => {
    const descriptors = [descriptor, descriptor, { ...descriptor, configurationVersion: "auth-v2" }]
    let getSessionCalls = 0
    let socialCalls = 0
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => Response.json(descriptors.shift()),
      createClient: () => ({
        getSession: async () => {
          getSessionCalls += 1
          return { data: { session: null, user: null }, error: null }
        },
        signIn: {
          social: async () => {
            socialCalls += 1
            return { data: { redirect: true }, error: null }
          },
          email: async () => ({ data: null, error: null }),
        },
        signUp: { email: async () => ({ data: null, error: null }) },
        signOut: async () => ({ data: null, error: null }),
      }),
    })
    await adapter.initialize(HOSTED)

    await adapter.useAuth().signIn({ method: "github", redirectUrl: "/after-auth" })
    expect(getSessionCalls).toBe(1)
    expect(socialCalls).toBe(1)

    await expect(adapter.useAuth().signIn({ method: "github" })).rejects.toThrow("configuration binding changed")
    expect(socialCalls).toBe(1)
  })

  test("rejects a cross-origin social callback instead of handing it to the provider", async () => {
    let socialCalls = 0
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => Response.json(descriptor),
      createClient: () => ({
        getSession: async () => ({ data: { session: null, user: null }, error: null }),
        signIn: {
          social: async () => {
            socialCalls += 1
            return { data: null, error: null }
          },
          email: async () => ({ data: null, error: null }),
        },
        signUp: { email: async () => ({ data: null, error: null }) },
        signOut: async () => ({ data: null, error: null }),
      }),
    })
    await adapter.initialize(HOSTED)

    await expect(
      adapter.useAuth().signIn({
        method: "github",
        redirectUrl: "https://attacker.example.test/callback",
      }),
    ).rejects.toThrow("same-origin callback")
    expect(socialCalls).toBe(0)
  })
})

/**
 * The four compositions `initialize` has to answer for. All four resolve: the
 * shell renders unconditionally and the session status is the answer, which is
 * the invariant a rejecting `initialize` broke — a plain-http origin replaced
 * the whole app, `/login` included, with a startup-failure panel.
 */
describe("Better Auth browser adapter startup outcomes", () => {
  const refusingClient = () => ({
    getSession: async () => {
      throw new Error("the session client must not be reached")
    },
    signIn: {
      social: async () => ({ data: null, error: null }),
      email: async () => ({ data: null, error: null }),
    },
    signUp: { email: async () => ({ data: null, error: null }) },
    signOut: async () => ({ data: null, error: null }),
  })

  test.each([
    ["an http API origin", { apiOrigin: "http://api.example.test", appOrigin: "https://app.example.test" }],
    ["an http app origin", { apiOrigin: "https://api.example.test", appOrigin: "http://app.example.test" }],
  ])("%s is anonymous, not a failed boot, and asks the deployment nothing", async (_, origins) => {
    let requests = 0
    let clients = 0
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => {
        requests += 1
        return Response.json(descriptor)
      },
      createClient: () => {
        clients += 1
        return refusingClient()
      },
    })

    await expect(adapter.initialize(origins)).resolves.toBeUndefined()
    const auth = adapter.useAuth()

    expect(requests).toBe(0)
    expect(clients).toBe(0)
    expect(auth.loading()).toBe(false)
    expect(auth.isSignedIn()).toBe(false)
    await expect(auth.signIn({ method: "github" })).rejects.toThrow(/HTTPS/)
  })

  test("an HTTPS descriptor that cannot be loaded is anonymous, and says why on sign-in", async () => {
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => {
        throw new Error("descriptor request failed: network unreachable")
      },
      createClient: () => ({
        getSession: async () => ({ data: { session: null, user: null }, error: null }),
        signIn: {
          social: async () => ({ data: null, error: null }),
          email: async () => ({ data: null, error: null }),
        },
        signUp: { email: async () => ({ data: null, error: null }) },
        signOut: async () => ({ data: null, error: null }),
      }),
    })

    await expect(
      adapter.initialize(HOSTED),
    ).resolves.toBeUndefined()
    const auth = adapter.useAuth()

    expect(auth.loading()).toBe(false)
    expect(auth.isSignedIn()).toBe(false)
    await expect(auth.signIn({ method: "github" })).rejects.toThrow(/network unreachable/)
    // Idempotent, and still not a startup failure: Log out of nothing is a
    // no-op rather than a button that throws.
    await expect(auth.signOut()).resolves.toBeUndefined()
    await expect(auth.refreshSession()).resolves.toBeUndefined()
  })

  test("an HTTPS deployment loads, and reports loading only while it is in flight", async () => {
    let openDescriptor: () => void = () => {}
    const descriptorGate = new Promise<void>((resolve) => {
      openDescriptor = resolve
    })
    const adapter = createBetterAuthBrowserAdapter({
      request: async () => {
        await descriptorGate
        return Response.json(descriptor)
      },
      createClient: () => ({
        getSession: async () => ({ data: { session: { id: "session_1" }, user: { id: "user_1" } }, error: null }),
        signIn: {
          social: async () => ({ data: null, error: null }),
          email: async () => ({ data: null, error: null }),
        },
        signUp: { email: async () => ({ data: null, error: null }) },
        signOut: async () => ({ data: null, error: null }),
      }),
    })
    const auth = adapter.useAuth()

    // Before anyone starts it, the honest answer is anonymous, not loading:
    // a session that waits for a resolution nobody asked for never resolves.
    expect(auth.loading()).toBe(false)

    const started = adapter.initialize(HOSTED)
    expect(auth.loading()).toBe(true)

    openDescriptor()
    await started

    expect(auth.loading()).toBe(false)
    expect(auth.isSignedIn()).toBe(true)
  })
})
