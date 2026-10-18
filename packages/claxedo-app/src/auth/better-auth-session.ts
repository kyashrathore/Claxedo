import { createSignal } from "solid-js"
import { publishedDeployment } from "@/server"
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
import { forgetAuthIdentity, recordAuthIdentity } from "./persistence"

type Connection = { readonly client: BetterAuthBrowserClient; readonly origin: string }
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
  const loadDescriptor = (origin: string, published?: unknown) =>
    loadBrowserAuthDescriptor({ selectedAdapter: "better-auth", origin, published, ...(input.request ? { request: input.request } : {}) })
  const readSession = (client: BetterAuthBrowserClient) => clientResult("session refresh", client.getSession())
  return {
    state: { descriptor, user, loading, unavailable },
    set: { descriptor: setDescriptor, user: setUser, loading: setLoading, unavailable: setUnavailable },
    connected,
    connect: (origin: string) => (connection = { client: input.createClient({ baseURL: origin, fetchOptions: { credentials: "include" } }), origin }),
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
  const live = await session.loadDescriptor(session.connected().origin)
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
  forgetAuthIdentity()
}

export async function initializeSession(session: BetterAuthSession, deployment: BrowserAuthDeployment) {
  const unsupported = browserAuthUnavailable(deployment)
  if (unsupported) {
    session.set.unavailable(unsupported)
    session.set.user(null)
    session.set.loading(false)
    return
  }
  session.set.loading(true)
  const { client } = session.connect(deployment.origin)
  try {
    const published = publishedDeployment(deployment.origin)?.authDescriptor
    const [live, initial] = await Promise.all([session.loadDescriptor(deployment.origin, published), session.readSession(client)])
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
