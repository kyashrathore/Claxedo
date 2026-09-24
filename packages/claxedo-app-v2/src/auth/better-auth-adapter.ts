import { createSignal } from "solid-js"
import { createAuthClient } from "better-auth/client"
import {
  assertBrowserAuthDescriptorBinding,
  browserAuthUnavailable,
  browserAuthUnavailableReason,
  loadBrowserAuthDescriptor,
  type BrowserAuthAdapter,
  type BrowserAuthDescriptor,
  type BrowserAuthMethod,
  type BrowserAuthSignInOptions,
  type BrowserAuthSignUpOptions,
} from "./browser-auth"
import { clearPersistedAuthState, recordAuthIdentity } from "./persistence"
import type { AuthUser } from "./display-user"

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

function normalizedUser(value: BetterAuthSessionData["user"]): AuthUser | null {
  if (!value || typeof value.id !== "string" || !value.id) return null
  return {
    id: value.id,
    ...(typeof value.name === "string" && value.name ? { fullName: value.name } : {}),
    ...(typeof value.image === "string" && value.image ? { imageUrl: value.image } : {}),
    ...(typeof value.email === "string" && value.email ? { email: value.email } : {}),
  }
}

export function createBetterAuthBrowserAdapter(
  input: {
    request?: (input: string, init?: RequestInit) => Promise<Response>
    createClient?: BetterAuthClientFactory
  } = {},
): BrowserAuthAdapter {
  const [descriptor, setDescriptor] = createSignal<BrowserAuthDescriptor | null>(null)
  const [user, setUser] = createSignal<AuthUser | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal<string | null>(null)
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

  const readSession = async () => {
    const result = await requireClient().getSession()
    if (result.error) throw clientError("session refresh", result.error)
    return result.data
  }

  const adoptSession = (data: BetterAuthSessionData | null) => {
    const nextUser = normalizedUser(data?.user)
    recordAuthIdentity(nextUser?.id)
    setUser(nextUser)
  }

  const hydrateSession = async () => adoptSession(await readSession())

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
    if (unavailable()) return
    await reloadDescriptor()
    await hydrateSession()
  }

  const signIn = async (options?: BrowserAuthSignInOptions) => {
    const reason = unavailable()
    if (reason) throw new Error(reason)
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
        : await requireClient().signIn.social({ provider: method, callbackURL: redirect })
    if (result.error) throw clientError("sign-in", result.error)
    if (method === "email-password") await hydrateSession()
  }

  const signUp = async (options?: BrowserAuthSignUpOptions) => {
    const reason = unavailable()
    if (reason) throw new Error(reason)
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

  const signOut = async () => {
    if (unavailable()) {
      setUser(null)
      clearPersistedAuthState()
      return
    }
    const result = await requireClient().signOut()
    if (result.error) throw clientError("sign-out", result.error)
    setUser(null)
    clearPersistedAuthState()
  }

  const initialize = async (deployment: { apiOrigin: string; appOrigin: string; issuesSessions: boolean }) => {
    const nextOrigins = { apiOrigin: deployment.apiOrigin, appOrigin: deployment.appOrigin }
    const unsupported = browserAuthUnavailable(deployment)
    if (unsupported) {
      setUnavailable(unsupported)
      setUser(null)
      setLoading(false)
      return
    }
    configuredOrigins = nextOrigins
    appOrigin = nextOrigins.appOrigin
    setLoading(true)
    client = (input.createClient ?? productionClientFactory)({
      baseURL: nextOrigins.apiOrigin,
      fetchOptions: { credentials: "include" },
    })
    try {
      const [live, initialSession] = await Promise.all([
        loadBrowserAuthDescriptor({
          selectedAdapter: "better-auth",
          ...nextOrigins,
          ...(input.request ? { request: input.request } : {}),
        }),
        readSession(),
      ])
      setDescriptor(live)
      adoptSession(initialSession)
      setUnavailable(null)
    } catch (error) {
      client = undefined
      configuredOrigins = undefined
      setUnavailable(browserAuthUnavailableReason(error))
      setUser(null)
    } finally {
      setLoading(false)
    }
  }

  const adapter: BrowserAuthAdapter = {
    adapter: "better-auth",
    transport: "cookie",
    initialize,
    useAuth: () => ({
      descriptor,
      methods: () => descriptor()?.methods ?? [],
      user,
      loading,
      unavailable,
      signIn,
      signOut,
      signUp,
      getToken: (options) => adapter.getToken(options),
      refreshSession,
    }),
    getToken: async () => null,
  }
  return adapter
}

export const browserAuthAdapter = createBetterAuthBrowserAdapter()
