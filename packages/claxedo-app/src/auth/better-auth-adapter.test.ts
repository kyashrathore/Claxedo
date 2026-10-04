/// <reference types="bun" />
import { beforeEach, expect, test } from "bun:test"
import { createBetterAuthBrowserAdapter } from "./better-auth-adapter"

const api = "https://api.claxedo.test"
const app = "https://app.claxedo.test"
const deployment = { apiOrigin: api, appOrigin: app, issuesSessions: true }

function descriptor(methods: readonly string[]) {
  return {
    adapter: "better-auth",
    deploymentId: "deployment",
    configurationVersion: "1",
    expiresAt: Date.now() + 60_000,
    issuer: `${api}/api/auth`,
    methods,
    browser: {
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      trustedOrigins: [app],
      clientId: "web",
      resource: api,
      scopes: ["openid"],
      cookie: { name: "session", path: "/", secure: true, httpOnly: true, hostOnly: true, sameSite: "lax" },
    },
  }
}

function fakeServer(methods: readonly string[] = ["email-password", "github"], status = 200) {
  const calls: string[] = []
  let signedIn: { id: string; email: string } | null = null
  const ok = <T>(data: T) => Promise.resolve({ data, error: null })
  const client = {
    getSession: () => ok(signedIn ? { user: signedIn } : null),
    signIn: {
      social: (input: { provider: string; callbackURL: string }) => (calls.push(`social ${input.provider} ${input.callbackURL}`), ok({})),
      email: (input: { email: string; callbackURL: string }) => {
        calls.push(`email ${input.email} ${input.callbackURL}`)
        signedIn = { id: "user-1", email: input.email }
        return ok({})
      },
    },
    signUp: { email: (input: { email: string; name: string }) => (calls.push(`sign-up ${input.email} ${input.name}`), (signedIn = { id: "user-2", email: input.email }), ok({})) },
    signOut: () => (calls.push("sign-out"), (signedIn = null), ok(null)),
  }
  const request = () => Promise.resolve(Response.json(descriptor(methods), { status }))
  return { calls, adapter: createBetterAuthBrowserAdapter({ request, createClient: () => client }) }
}

function installStorage(name: "localStorage" | "sessionStorage") {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: new Proxy({ getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) }, { ownKeys: () => [...items.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }),
  })
}

beforeEach(() => {
  installStorage("localStorage")
  installStorage("sessionStorage")
})

test("better auth: a server that issues no sessions leaves sign-in unavailable", async () => {
  const { adapter } = fakeServer()
  await adapter.initialize({ ...deployment, issuesSessions: false })
  const auth = adapter.useAuth()
  expect(auth.unavailable()).toContain("issues no sessions")
  await expect(auth.signIn()).rejects.toThrow("issues no sessions")
})

test("better auth: initialize reads the live descriptor and the session", async () => {
  const { adapter } = fakeServer()
  await adapter.initialize(deployment)
  const auth = adapter.useAuth()
  expect(auth.methods()).toEqual(["email-password", "github"])
  expect(auth.user()).toBeNull()
  expect(auth.loading()).toBe(false)
})

test("better auth: an email sign-in lands on the app and adopts the user; sign-out clears it", async () => {
  const { adapter, calls } = fakeServer()
  await adapter.initialize(deployment)
  const auth = adapter.useAuth()
  await auth.signIn({ method: "email-password", email: "ada@claxedo.test", password: "secret" })
  expect(auth.user()).toEqual({ id: "user-1", email: "ada@claxedo.test" })
  sessionStorage.setItem("claxedo:relay-link:user-1:[\"ws_1\",null]", "{}")
  await auth.signOut()
  expect(auth.user()).toBeNull()
  expect(sessionStorage.getItem("claxedo:relay-link:user-1:[\"ws_1\",null]"), "sign-out drops the tab's relay links").toBeNull()
  expect(calls).toEqual([`email ada@claxedo.test ${app}/`, "sign-out"])
})

test("better auth: a method the descriptor does not offer is refused, and a social sign-up signs in", async () => {
  const { adapter, calls } = fakeServer(["email-password", "github"])
  await adapter.initialize(deployment)
  const auth = adapter.useAuth()
  await expect(auth.signIn({ method: "google" })).rejects.toThrow("not selected by the live auth descriptor")
  await auth.signUp({ method: "github", redirectUrl: "/w/1" })
  await auth.signUp({ method: "email-password", email: "bo@claxedo.test", password: "secret" })
  expect(calls).toEqual([`social github ${app}/w/1`, "sign-up bo@claxedo.test bo@claxedo.test"])
  expect(auth.user()).toEqual({ id: "user-2", email: "bo@claxedo.test" })
})

test("better auth: a failed descriptor read makes sign-in unavailable with the reason", async () => {
  const { adapter } = fakeServer(["github"], 503)
  await adapter.initialize(deployment)
  expect(adapter.useAuth().unavailable()).toBe("Sign-in is unavailable: auth descriptor request failed with HTTP 503")
})
