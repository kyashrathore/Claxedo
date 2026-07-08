import { beforeEach, describe, expect, mock, test } from "bun:test"

let loading = false
let signed = false
let user: unknown
let organization: { id?: string } | null | undefined

mock.module("../../utils/auth-client", () => ({
  useAuth: () => ({
    clerk: {
      get organization() {
        return organization
      },
    },
    session: () => signed ? { id: "sess_1" } : null,
    user: () => user,
    loading: () => loading,
    isSignedIn: () => signed,
    signIn: async () => undefined,
    signOut: async () => undefined,
    signUp: async () => undefined,
    getToken: async () => signed ? "token" : null,
    refreshSession: async () => undefined,
    organization,
  }),
}))

const { useAuthSession } = await import("./auth-session")

beforeEach(() => {
  loading = false
  signed = false
  user = undefined
  organization = undefined
})

describe("useAuthSession", () => {
  test("reports loading before deciding whether a user is signed in", () => {
    loading = true
    signed = true

    expect(useAuthSession().status()).toBe("loading")
  })

  test("reports anonymous when auth is ready and no user is signed in", () => {
    expect(useAuthSession().status()).toBe("anonymous")
  })

  test("reports signed and exposes auth resources when the external auth client is signed in", async () => {
    signed = true
    user = { id: "usr_1" }
    organization = { id: "org_1" }

    const session = useAuthSession()

    expect(session.status()).toBe("signed")
    expect(session.user()).toEqual({ id: "usr_1" })
    expect(session.session()).toEqual({ id: "sess_1" })
    expect(session.organization()).toEqual({ id: "org_1" })
    await expect(session.getToken()).resolves.toBe("token")
  })
})
