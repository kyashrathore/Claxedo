import type { BrowserAuthAdapter } from "./browser-auth"
import { signIn, signOut, signUp } from "./better-auth-actions"
import { productionClientFactory, type BetterAuthClientFactory } from "./better-auth-client"
import { createBetterAuthSession, hydrateSession, initializeSession, reloadDescriptor } from "./better-auth-session"

export function createBetterAuthBrowserAdapter(
  input: {
    request?: (input: string, init?: RequestInit) => Promise<Response>
    createClient?: BetterAuthClientFactory
  } = {},
): BrowserAuthAdapter {
  const session = createBetterAuthSession({ request: input.request, createClient: input.createClient ?? productionClientFactory })
  const { descriptor, user, loading, unavailable } = session.state
  const adapter: BrowserAuthAdapter = {
    adapter: "better-auth",
    transport: "cookie",
    initialize: (deployment) => initializeSession(session, deployment),
    useAuth: () => ({
      descriptor,
      methods: () => descriptor()?.methods ?? [],
      user,
      loading,
      unavailable,
      signIn: (options) => signIn(session, options),
      signOut: () => signOut(session),
      signUp: (options) => signUp(session, options),
      getToken: (options) => adapter.getToken(options),
      refreshSession: async () => {
        if (unavailable()) return
        await reloadDescriptor(session)
        await hydrateSession(session)
      },
    }),
    getToken: async () => null,
  }
  return adapter
}

export const browserAuthAdapter = createBetterAuthBrowserAdapter()
