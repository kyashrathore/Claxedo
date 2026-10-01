import { expect, test } from "bun:test"
import { createOrgInvitationFlow } from "./login-continuation"
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
