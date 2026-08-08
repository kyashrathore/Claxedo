import { afterEach, describe, expect, test } from "bun:test"
import { configureAuthSession, useAuthSession, type ExternalAuthSource } from "./auth-session"

/**
 * The identity provider is BOUND here, not mocked.
 *
 * This file used to `mock.module("@/platform/auth/auth-client")`, which only
 * worked because `auth-session.ts` imported that module for real — the same
 * static edge that put Clerk in the local bundle. The seam is now a binder, so
 * the test supplies a provider the same way `app/entry/main.tsx` does, and the
 * UNBOUND case (what `app/entry/local.tsx` produces) is reachable at all.
 */

let loading = false
let signed = false
let user: unknown
let organization: { id?: string } | null | undefined
let signInCalls: ({ redirectUrl?: string } | undefined)[] = []

/**
 * A provider the port accepts with NO cast.
 *
 * `ExternalAuthSource` names the members `auth-session.ts` consumes rather than
 * `ReturnType<typeof useAuth>` wholesale, which is what makes a hand-written
 * provider expressible here. A double-cast fake would have been a test that
 * typechecks against nothing.
 */
const provider = {
  clerk: {
    get organization() {
      return organization
    },
  },
  session: () => null,
  user: () => user,
  loading: () => loading,
  isSignedIn: () => signed,
  signIn: async (options?: { redirectUrl?: string }) => {
    signInCalls.push(options)
  },
  signOut: async () => undefined,
  signUp: async () => undefined,
  getToken: async () => signed ? "token" : null,
  refreshSession: async () => undefined,
}

const fakeAuth: ExternalAuthSource = () => provider

function bindFakeAuth() {
  loading = false
  signed = false
  user = undefined
  organization = undefined
  signInCalls = []
  configureAuthSession(fakeAuth)
}

afterEach(() => {
  // Module-scoped binding: leave it as a local build finds it.
  configureAuthSession(null)
})

describe("useAuthSession with no identity provider bound", () => {
  test("is anonymous rather than loading, so nothing downstream waits forever", () => {
    expect(useAuthSession().status()).toBe("anonymous")
  })

  test("has no account to report", () => {
    const session = useAuthSession()

    expect(session.session()).toBeNull()
    expect(session.user()).toBeNull()
    expect(session.organization()).toBeUndefined()
  })

  test("resolves getToken to null, because 'no token' is this build's normal state", async () => {
    // A read, reached from effects and transports during render. Throwing here
    // would turn the local product's normal state into a crash in call sites
    // that already branch on null.
    await expect(useAuthSession().getToken()).resolves.toBeNull()
  })

  test("treats sign-out and refresh as idempotent no-ops", async () => {
    const session = useAuthSession()

    await expect(session.signOut()).resolves.toBeUndefined()
    await expect(session.refreshSession()).resolves.toBeUndefined()
  })

  test("refuses sign-in and sign-up, which are requests this build cannot honour", async () => {
    // Deliberately different from the reads above: these are explicit,
    // user-initiated operations reachable only from hosted surfaces, never from
    // render. Resolving silently would ship a button that reports success and
    // does nothing.
    const session = useAuthSession()

    await expect(session.signIn()).rejects.toThrow(/configureAuthSession/)
    await expect(session.signUp()).rejects.toThrow(/configureAuthSession/)
  })

  test("does not throw when the shell's provider tree calls it during render", () => {
    // `app/entry/app.tsx` calls this unconditionally and BOTH products render
    // that shell, so construction itself must be safe with nothing bound.
    expect(() => useAuthSession()).not.toThrow()
  })
})

describe("useAuthSession with an identity provider bound", () => {
  test("reports loading before deciding whether a user is signed in", () => {
    bindFakeAuth()
    loading = true
    signed = true

    expect(useAuthSession().status()).toBe("loading")
  })

  test("reports anonymous when auth is ready and no user is signed in", () => {
    bindFakeAuth()

    expect(useAuthSession().status()).toBe("anonymous")
  })

  test("reports signed and exposes auth resources when the external auth client is signed in", async () => {
    bindFakeAuth()
    signed = true
    user = { id: "usr_1" }
    organization = { id: "org_1" }

    const session = useAuthSession()

    expect(session.status()).toBe("signed")
    expect(session.user()).toEqual({ id: "usr_1" })
    expect(session.organization()).toEqual({ id: "org_1" })
    await expect(session.getToken()).resolves.toBe("token")
    // Forwarded by reference, not re-wrapped: the accessor callers read IS the
    // provider's, so a Solid effect over it tracks the provider's own signal.
    expect(session.session).toBe(provider.session)
    expect(session.user).toBe(provider.user)
  })

  test("delegates operations to the bound provider instead of refusing them", async () => {
    bindFakeAuth()

    await useAuthSession().signIn({ redirectUrl: "/after" })

    expect(signInCalls).toEqual([{ redirectUrl: "/after" }])
  })

  test("goes back to the anonymous session when the binding is removed", () => {
    bindFakeAuth()
    signed = true
    expect(useAuthSession().status()).toBe("signed")

    configureAuthSession(null)

    expect(useAuthSession().status()).toBe("anonymous")
  })
})
