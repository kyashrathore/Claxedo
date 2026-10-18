/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test"
import { PUBLISHED_DEPLOYMENT_ELEMENT_ID } from "@/server"
import { createBetterAuthBrowserAdapter } from "./better-auth-adapter"
import { stubGlobal } from "@/lib/stub-global"

const app = "https://app.claxedo.test"
const deployment = { origin: app, issuesSessions: true }

function descriptor(methods: readonly string[]) {
  return {
    adapter: "better-auth",
    deploymentId: "deployment",
    configurationVersion: "1",
    expiresAt: Date.now() + 60_000,
    issuer: `${app}/api/auth`,
    methods,
    browser: {
      transport: "cookie",
      credentialPolicy: "reject-cookie-and-authorization",
      trustedOrigins: [app],
      clientId: "web",
      resource: app,
      scopes: ["openid"],
      cookie: { name: "session", path: "/", secure: true, httpOnly: true, hostOnly: true, sameSite: "lax" },
    },
  }
}

function fakeServer(methods: readonly string[] = ["email-password", "github"], status = 200, signOutRefusal?: string) {
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
    signOut: () => {
      calls.push("sign-out")
      if (signOutRefusal) return Promise.resolve({ data: null, error: { message: signOutRefusal } })
      signedIn = null
      return ok(null)
    },
  }
  const request = () => (calls.push("descriptor"), Promise.resolve(Response.json(descriptor(methods), { status })))
  return { calls, adapter: createBetterAuthBrowserAdapter({ request, createClient: () => client }) }
}

const restores: Array<() => void> = []

function installStorage(name: "localStorage" | "sessionStorage") {
  const items = new Map<string, string>()
  restores.push(stubGlobal(name, new Proxy(
    { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) },
    { ownKeys: () => [...items.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) },
  )))
}

function publish(value: unknown) {
  const element = { textContent: JSON.stringify(value) }
  restores.push(stubGlobal("document", { getElementById: (id: string) => (id === PUBLISHED_DEPLOYMENT_ELEMENT_ID ? element : null) }))
}

beforeEach(() => {
  installStorage("localStorage")
  installStorage("sessionStorage")
  restores.push(stubGlobal("document", undefined))
})

afterEach(() => restores.splice(0).reverse().forEach((restore) => restore()))

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
  expect(localStorage.getItem("claxedo:auth:lastUserId")).toBe("user-1")
  sessionStorage.setItem("claxedo:relay-link:user-1:[\"ws_1\",null]", "{}")
  await auth.signOut()
  expect(auth.user()).toBeNull()
  expect(localStorage.getItem("claxedo:auth:lastUserId"), "sign-out tells the other tabs no one is signed in").toBeNull()
  expect(sessionStorage.getItem("claxedo:relay-link:user-1:[\"ws_1\",null]"), "sign-out drops the tab's relay links").toBeNull()
  expect(calls).toEqual(["descriptor", "descriptor", `email ada@claxedo.test ${app}/`, "sign-out"])
})

test("better auth: a sign-out the server refuses still ends this tab's session and reports the refusal", async () => {
  const { adapter, calls } = fakeServer(["email-password"], 200, "Sign-out is unavailable")
  await adapter.initialize(deployment)
  const auth = adapter.useAuth()
  await auth.signIn({ method: "email-password", email: "ada@claxedo.test", password: "secret" })
  sessionStorage.setItem("claxedo:relay-link:user-1:[\"ws_1\",null]", "{}")
  await expect(auth.signOut()).rejects.toThrow("Sign-out is unavailable")
  expect(auth.user()).toBeNull()
  expect(sessionStorage.getItem("claxedo:relay-link:user-1:[\"ws_1\",null]")).toBeNull()
  expect(calls).toEqual(["descriptor", "descriptor", `email ada@claxedo.test ${app}/`, "sign-out"])
})

test("better auth: a method the descriptor does not offer is refused, and a social sign-up signs in", async () => {
  const { adapter, calls } = fakeServer(["email-password", "github"])
  await adapter.initialize(deployment)
  const auth = adapter.useAuth()
  await expect(auth.signIn({ method: "google" })).rejects.toThrow("not selected by the live auth descriptor")
  await auth.signUp({ method: "github", redirectUrl: "/w/1" })
  await auth.signUp({ method: "email-password", email: "bo@claxedo.test", password: "secret" })
  expect(calls.filter((call) => call !== "descriptor")).toEqual([`social github ${app}/w/1`, "sign-up bo@claxedo.test bo@claxedo.test"])
  expect(auth.user()).toEqual({ id: "user-2", email: "bo@claxedo.test" })
})

test("better auth: a failed descriptor read makes sign-in unavailable with the reason", async () => {
  const { adapter } = fakeServer(["github"], 503)
  await adapter.initialize(deployment)
  expect(adapter.useAuth().unavailable()).toBe("Sign-in is unavailable: auth descriptor request failed with HTTP 503")
})

test("better auth: the descriptor the deployment published into the shell starts sign-in without a request, and sign-in still reads the live one", async () => {
  const { adapter, calls } = fakeServer(["github"])
  publish({ server: api, bootstrap: {}, authDescriptor: descriptor(["email-password"]) })
  await adapter.initialize(deployment)
  const auth = adapter.useAuth()
  expect(auth.methods()).toEqual(["email-password"])
  expect(calls).toEqual([])
  await auth.signIn({ method: "github" })
  expect(calls).toEqual(["descriptor", `social github ${app}/`])
  expect(auth.methods(), "the live descriptor replaces the published one").toEqual(["github"])
})

test("better auth: an expired published descriptor is never used; initialize reads the live one", async () => {
  const { adapter, calls } = fakeServer(["github"])
  publish({ server: api, bootstrap: {}, authDescriptor: { ...descriptor(["email-password"]), expiresAt: Date.now() - 1 } })
  await adapter.initialize(deployment)
  expect(adapter.useAuth().methods()).toEqual(["github"])
  expect(calls).toEqual(["descriptor"])
})
