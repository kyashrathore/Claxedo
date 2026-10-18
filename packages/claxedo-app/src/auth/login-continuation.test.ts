import { beforeEach, expect, test } from "bun:test"
import { createOrgInvitationFlow, loginDestination, loginOAuthContinuation } from "./login-continuation"
import type { Auth } from "./store"
import type { AuthState } from "./model"

function setup() {
  let state: AuthState = { kind: "signedOut" }
  const calls: unknown[] = []
  const auth = {
    state: () => state,
    signUp: async (input: unknown) => {
      calls.push(["signUp", input])
      state = { kind: "signedIn", user: { id: "new", fullName: "New" } }
    },
    signIn: async (input: unknown) => {
      calls.push(["signIn", input])
      state = { kind: "signedIn", user: { id: "new", fullName: "New" } }
    },
  } as unknown as Auth
  const operations = {
    run: async (name: string, input: unknown) => {
      calls.push([name, input])
      return { role: "member" }
    },
  }
  return { auth, operations, calls }
}

beforeEach(() => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) },
  })
})

function signedInSetup() {
  const calls: unknown[] = []
  const auth = { state: () => ({ kind: "signedIn", user: { id: "u1" } }), signIn: async () => {}, signUp: async () => {} } as unknown as Auth
  const accept = async (token: string) => {
    calls.push(["org.invitations.accept", { token }])
    return { role: "member" }
  }
  return { auth, accept, calls }
}

test("opening an invitation link while already signed in does not join without the person's click", async () => {
  const { auth, accept, calls } = signedInSetup()
  const flow = createOrgInvitationFlow(auth, accept, "token")

  expect(await flow.resume()).toBeUndefined()
  expect(calls).toEqual([])
  await flow.accept()
  expect(calls).toEqual([["org.invitations.accept", { token: "token" }]])
})

test("returning from a sign-in this tab started for the invitation joins once", async () => {
  const { auth, accept, calls } = signedInSetup()
  await createOrgInvitationFlow({ ...auth, state: () => ({ kind: "signedOut" }) } as unknown as Auth, accept, "token").authenticate({ method: "google" }, "signIn")

  const returned = createOrgInvitationFlow(auth, accept, "token")
  await returned.resume()
  await createOrgInvitationFlow(auth, accept, "token").resume()

  expect(calls).toEqual([["org.invitations.accept", { token: "token" }]])
})

test("a sign-in started for one invitation never joins another", async () => {
  const { auth, accept, calls } = signedInSetup()
  await createOrgInvitationFlow({ ...auth, state: () => ({ kind: "signedOut" }) } as unknown as Auth, accept, "first").authenticate({ method: "google" }, "signIn")

  await createOrgInvitationFlow(auth, accept, "second").resume()

  expect(calls).toEqual([])
})

test("an invitation sign-up preserves its token and ends in the canonical accept operation", async () => {
  const { auth, operations, calls } = setup()
  const flow = createOrgInvitationFlow(auth, (token) => operations.run("org.invitations.accept", { token }), "token")
  await flow.authenticate({ method: "email-password", email: "new@example.com", password: "password" }, "signUp")
  expect(calls).toEqual([
    [
      "signUp",
      { method: "email-password", email: "new@example.com", password: "password", redirectUrl: "/invitations#token" },
    ],
    ["org.invitations.accept", { token: "token" }],
  ])
  await flow.accept()
  expect(calls).toHaveLength(2)
})

test("accepting signed out never sends an API request", async () => {
  const { auth, operations, calls } = setup()
  expect(await createOrgInvitationFlow(auth, (token) => operations.run("org.invitations.accept", { token }), "token").accept()).toBeUndefined()
  expect(calls).toEqual([])
})

test("a sign-in that continues an authorization request loads the authorize route even when the API shares the app's origin", () => {
  const origin = "https://claxedo.example"
  const continuation = loginOAuthContinuation({
    appOrigin: origin,
    apiOrigin: origin,
    pathname: "/login",
    search: "?response_type=code&client_id=claxedo-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&state=s",
  })
  expect(loginDestination(continuation)).toEqual({
    assign: `${origin}/api/auth/oauth2/authorize?response_type=code&client_id=claxedo-desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcb&state=s`,
  })
})

test("a plain sign-in stays in the app at its home", () => {
  expect(loginDestination(loginOAuthContinuation({ appOrigin: "https://claxedo.example", apiOrigin: "https://api.example", pathname: "/login", search: "" }))).toEqual({ navigate: "/" })
})
