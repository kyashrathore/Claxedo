import { createSignal } from "solid-js"
import {
  assertBrowserAuthDescriptorBinding,
  browserAuthUnavailable,
  browserAuthUnavailableReason,
  loadBrowserAuthDescriptor,
  type BrowserAuthDeployment,
  type BrowserAuthDescriptor,
  type BrowserAuthMethod,
} from "./browser-auth"
import { clientResult, normalizedUser, type BetterAuthBrowserClient, type BetterAuthClientFactory } from "./better-auth-client"
import type { AuthUser } from "./display-user"
import { clearPersistedAuthState, recordAuthIdentity } from "./persistence"

type Origins = { readonly apiOrigin: string; readonly appOrigin: string }
type Connection = { readonly client: BetterAuthBrowserClient; readonly origins: Origins }
type DescriptorRequest = (input: string, init?: RequestInit) => Promise<Response>

export type BetterAuthSession = ReturnType<typeof createBetterAuthSession>

export function createBetterAuthSession(input: { request?: DescriptorRequest; createClient: BetterAuthClientFactory }) {
  const [descriptor, setDescriptor] = createSignal<BrowserAuthDescriptor | null>(null)
  const [user, setUser] = createSignal<AuthUser | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [unavailable, setUnavailable] = createSignal<string | null>(null)
  let connection: Connection | undefined
  const connected = () => {
    if (!connection) throw new Error("Better Auth browser adapter is not initialized")
    return connection
  }
  const loadDescriptor = (origins: Origins) =>
    loadBrowserAuthDescriptor({ selectedAdapter: "better-auth", ...origins, ...(input.request ? { request: input.request } : {}) })
  const readSession = (client: BetterAuthBrowserClient) => clientResult("session refresh", client.getSession())
  return {
    state: { descriptor, user, loading, unavailable },
    set: { descriptor: setDescriptor, user: setUser, loading: setLoading, unavailable: setUnavailable },
    connected,
    connect: (origins: Origins) => (connection = { client: input.createClient({ baseURL: origins.apiOrigin, fetchOptions: { credentials: "include" } }), origins }),
    disconnect: () => (connection = undefined),
    loadDescriptor,
    readSession,
  }
}

export function adoptSession(session: BetterAuthSession, data: Awaited<ReturnType<BetterAuthSession["readSession"]>>) {
  const next = normalizedUser(data?.user)
  recordAuthIdentity(next?.id)
  session.set.user(next)
}

export async function hydrateSession(session: BetterAuthSession) {
  adoptSession(session, await session.readSession(session.connected().client))
}

export async function reloadDescriptor(session: BetterAuthSession) {
  const expected = session.state.descriptor()
  if (!expected) throw new Error("Better Auth browser adapter is not initialized")
  const live = await session.loadDescriptor(session.connected().origins)
  assertBrowserAuthDescriptorBinding(expected, live)
  session.set.descriptor(live)
  return live
}

export function selectedMethod(session: BetterAuthSession, method: BrowserAuthMethod | undefined) {
  const methods = session.state.descriptor()?.methods ?? []
  const selected = method ?? (methods.length === 1 ? methods[0] : undefined)
  if (!selected || !methods.includes(selected)) throw new Error("sign-in method is not selected by the live auth descriptor")
  return selected
}

export function endSession(session: BetterAuthSession) {
  session.set.user(null)
  clearPersistedAuthState()
}

export async function initializeSession(session: BetterAuthSession, deployment: BrowserAuthDeployment) {
  const origins = { apiOrigin: deployment.apiOrigin, appOrigin: deployment.appOrigin }
  const unsupported = browserAuthUnavailable(deployment)
  if (unsupported) {
    session.set.unavailable(unsupported)
    session.set.user(null)
    session.set.loading(false)
    return
  }
  session.set.loading(true)
  const { client } = session.connect(origins)
  try {
    const [live, initial] = await Promise.all([session.loadDescriptor(origins), session.readSession(client)])
    session.set.descriptor(live)
    adoptSession(session, initial)
    session.set.unavailable(null)
  } catch (error) {
    session.disconnect()
    session.set.unavailable(browserAuthUnavailableReason(error))
    session.set.user(null)
  } finally {
    session.set.loading(false)
  }
}
