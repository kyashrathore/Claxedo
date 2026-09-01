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

    await adapter.initialize({ apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" })
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

    await adapter.initialize({ apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" })

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
    await adapter.initialize({ apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" })

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
    await adapter.initialize({ apiOrigin: "https://api.example.test", appOrigin: "https://app.example.test" })

    await expect(
      adapter.useAuth().signIn({
        method: "github",
        redirectUrl: "https://attacker.example.test/callback",
      }),
    ).rejects.toThrow("same-origin callback")
    expect(socialCalls).toBe(0)
  })
})
