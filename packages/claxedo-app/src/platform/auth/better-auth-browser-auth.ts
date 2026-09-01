import { createSignal } from "solid-js"
import { createAuthClient } from "better-auth/client"

import {
  assertBrowserAuthDescriptorBinding,
  loadBrowserAuthDescriptor,
  type BrowserAuthAdapter,
  type BrowserAuthDescriptor,
  type BrowserAuthMethod,
  type BrowserAuthSignInOptions,
  type BrowserAuthSignUpOptions,
} from "./browser-auth"
import { clearPersistedAuthState, recordBrowserAuthIdentity } from "./browser-auth-persistence"
import {
  browserAuthTestSignedOut,
  markBrowserAuthTestSignedOut,
  recordBrowserAuthTestSignIn,
  testBrowserAuth,
} from "./browser-auth-test-bypass"
import type { AuthDisplayUser } from "./auth-display"

type ClientError = { message?: string } | null
type ClientResult<T> = Promise<{ data: T | null; error: ClientError }>
type BetterAuthSessionData = {
  session?: unknown
  user?: { id?: unknown; name?: unknown; email?: unknown; image?: unknown } | null
}

type BetterAuthBrowserClient = {
  getSession(): ClientResult<BetterAuthSessionData>
  signIn: {
    social(input: { provider: "google" | "github"; callbackURL: string }): ClientResult<unknown>
    email(input: { email: string; password: string; callbackURL: string }): ClientResult<unknown>
  }
  signUp: {
    email(input: { email: string; password: string; name: string; callbackURL: string }): ClientResult<unknown>
  }
  signOut(): ClientResult<unknown>
}

type BetterAuthClientFactory = (options: {
  baseURL: string
  fetchOptions: { credentials: "include" }
}) => BetterAuthBrowserClient

const productionClientFactory: BetterAuthClientFactory = (options) => createAuthClient(options)

function clientError(action: string, error: ClientError) {
  return new Error(error?.message || `Better Auth ${action} failed`)
}

function callbackUrl(value: string | undefined, appOrigin: string) {
  const callback = new URL(value ?? "/", appOrigin)
  if (callback.origin !== appOrigin || callback.username || callback.password) {
    throw new Error("Better Auth requires an exact same-origin callback")
  }
  return callback.toString()
}

function normalizedUser(value: BetterAuthSessionData["user"]): AuthDisplayUser | null {
  if (!value || typeof value.id !== "string" || !value.id) return null
  return {
    id: value.id,
    ...(typeof value.name === "string" && value.name ? { fullName: value.name } : {}),
    ...(typeof value.image === "string" && value.image ? { imageUrl: value.image } : {}),
    ...(typeof value.email === "string" && value.email ? { primaryEmailAddress: { emailAddress: value.email } } : {}),
  }
}

export function createBetterAuthBrowserAdapter(
  input: {
    request?: (input: string, init?: RequestInit) => Promise<Response>
    createClient?: BetterAuthClientFactory
  } = {},
): BrowserAuthAdapter {
  const [descriptor, setDescriptor] = createSignal<BrowserAuthDescriptor | null>(null)
  const [session, setSession] = createSignal<unknown>(null)
  const [user, setUser] = createSignal<AuthDisplayUser | null>(null)
  const [loading, setLoading] = createSignal(true)
  let appOrigin = ""
  let configuredOrigins: { apiOrigin: string; appOrigin: string } | undefined
  let client: BetterAuthBrowserClient | undefined

  const requireClient = () => {
    if (!client) throw new Error("Better Auth browser adapter is not initialized")
    return client
  }

  const selectedMethod = (method: BrowserAuthMethod | undefined) => {
    const methods = descriptor()?.methods ?? []
    const selected = method ?? (methods.length === 1 ? methods[0] : undefined)
    if (!selected || !methods.includes(selected))
      throw new Error("sign-in method is not selected by the live auth descriptor")
    return selected
  }

  const hydrateSession = async () => {
    const result = await requireClient().getSession()
    if (result.error) throw clientError("session refresh", result.error)
    const nextUser = normalizedUser(result.data?.user)
    recordBrowserAuthIdentity(nextUser?.id)
    setSession(result.data?.session ?? null)
    setUser(nextUser)
  }

  const reloadDescriptor = async () => {
    const expected = descriptor()
    if (!configuredOrigins || !expected) throw new Error("Better Auth browser adapter is not initialized")
    const live = await loadBrowserAuthDescriptor({
      selectedAdapter: "better-auth",
      ...configuredOrigins,
      ...(input.request ? { request: input.request } : {}),
    })
    assertBrowserAuthDescriptorBinding(expected, live)
    setDescriptor(live)
    return live
  }

  const refreshSession = async () => {
    const bypass = testBrowserAuth()
    if (bypass.token || bypass.user || browserAuthTestSignedOut()) return
    await reloadDescriptor()
    await hydrateSession()
  }

  const signIn = async (options?: BrowserAuthSignInOptions) => {
    if (!client && (testBrowserAuth().token || testBrowserAuth().user)) {
      recordBrowserAuthTestSignIn(options?.redirectUrl)
      return
    }
    await reloadDescriptor()
    const method = selectedMethod(options?.method)
    const redirect = callbackUrl(options?.redirectUrl, appOrigin)
    const result =
      method === "email-password"
        ? await requireClient().signIn.email({
            email: options?.method === "email-password" ? options.email : "",
            password: options?.method === "email-password" ? options.password : "",
            callbackURL: redirect,
          })
        : method === "google" || method === "github"
          ? await requireClient().signIn.social({ provider: method, callbackURL: redirect })
          : (() => {
              throw new Error(`Better Auth cannot run ${method}`)
            })()
    if (result.error) throw clientError("sign-in", result.error)
    if (method === "email-password") await hydrateSession()
  }

  const signUp = async (options?: BrowserAuthSignUpOptions) => {
    const method = selectedMethod(options?.method)
    if (method !== "email-password" || options?.method !== "email-password") {
      if (method !== "google" && method !== "github") throw new Error(`Better Auth cannot run ${method}`)
      await signIn({ method, redirectUrl: options?.redirectUrl })
      return
    }
    await reloadDescriptor()
    const result = await requireClient().signUp.email({
      email: options.email,
      password: options.password,
      name: options.name?.trim() || options.email,
      callbackURL: callbackUrl(options.redirectUrl, appOrigin),
    })
    if (result.error) throw clientError("sign-up", result.error)
    await hydrateSession()
  }

  const adapter: BrowserAuthAdapter = {
    adapter: "better-auth",
    transport: "cookie",
    implementationMarker: "claxedo-browser-auth:better-auth",
    async initialize(nextOrigins) {
      const bypass = testBrowserAuth()
      if (bypass.token || bypass.user || browserAuthTestSignedOut()) {
        setSession(null)
        setUser(bypass.user ?? (bypass.token ? { id: "test-user" } : null))
        setLoading(false)
        return
      }
      configuredOrigins = nextOrigins
      appOrigin = nextOrigins.appOrigin
      // The descriptor call validates the live configuration (adapter,
      // deployment, origins) against this build's expectations; it is not
      // where the session client gets its base URL — `createClient` below
      // only needs `nextOrigins.apiOrigin`, known before either request is
      // made. So the descriptor fetch and the session hydration below no
      // longer chain: they are two independent reads of the same origins,
      // and firing them together turns two round trips gating first paint
      // into one. A bad descriptor still fails boot the same way — it
      // rejects this same `Promise.all`, same as before.
      client = (input.createClient ?? productionClientFactory)({
        baseURL: nextOrigins.apiOrigin,
        fetchOptions: { credentials: "include" },
      })
      const [live] = await Promise.all([
        loadBrowserAuthDescriptor({
          selectedAdapter: "better-auth",
          ...nextOrigins,
          ...(input.request ? { request: input.request } : {}),
        }),
        hydrateSession(),
      ])
      setDescriptor(live)
      setLoading(false)
    },
    useAuth() {
      return {
        descriptor,
        methods: () => descriptor()?.methods ?? [],
        session,
        user,
        loading,
        isSignedIn: () => user() !== null,
        signIn,
        async signOut() {
          const bypass = testBrowserAuth()
          if (!client && (bypass.token || bypass.user)) {
            markBrowserAuthTestSignedOut()
            setSession(null)
            setUser(null)
            clearPersistedAuthState()
            return
          }
          const result = await requireClient().signOut()
          if (result.error) throw clientError("sign-out", result.error)
          setSession(null)
          setUser(null)
          clearPersistedAuthState()
        },
        signUp,
        getToken: (options) => adapter.getToken(options),
        refreshSession,
        organization: () => undefined,
      }
    },
    async getToken() {
      return testBrowserAuth().token ?? null
    },
  }
  return adapter
}

export const browserAuthAdapter = createBetterAuthBrowserAdapter()
