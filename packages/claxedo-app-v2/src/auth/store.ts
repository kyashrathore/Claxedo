import { createEffect, type Accessor } from "solid-js"
import type { BrowserAuthAdapter, BrowserAuthMethod, BrowserAuthSignInOptions, BrowserAuthSignUpOptions } from "./browser-auth"
import type { AuthUser } from "./display-user"
import { authMachine, type AuthState } from "./model"
import { apiOrigin, appOrigin, serverIssuesSessions } from "./origins"

export type Auth = {
  readonly state: Accessor<AuthState>
  readonly user: Accessor<AuthUser | null>
  readonly methods: Accessor<readonly BrowserAuthMethod[]>
  readonly unavailable: Accessor<string | null>
  readonly signIn: (options?: BrowserAuthSignInOptions) => Promise<void>
  readonly signUp: (options?: BrowserAuthSignUpOptions) => Promise<void>
  readonly signOut: () => Promise<void>
  readonly refresh: () => Promise<void>
  readonly token: (options?: { skipCache?: boolean }) => Promise<string | null>
}

export function createAuth(adapter: BrowserAuthAdapter): Auth {
  const browser = adapter.useAuth()
  const auth = authMachine()
  const settle = () => {
    const reason = browser.unavailable()
    auth.send({ type: "settled", user: browser.user(), ...(reason ? { reason } : {}) })
  }
  createEffect(() => {
    if (browser.loading()) auth.send({ type: "started" })
    else settle()
  })
  const run = async (task: () => Promise<void>) => {
    auth.send({ type: "started" })
    try {
      await task()
    } finally {
      settle()
    }
  }
  return {
    state: auth.state,
    user: browser.user,
    methods: browser.methods,
    unavailable: browser.unavailable,
    signIn: (options) => run(() => browser.signIn(options)),
    signUp: (options) => run(() => browser.signUp(options)),
    signOut: async () => {
      await browser.signOut()
      auth.send({ type: "signedOut" })
    },
    refresh: async () => {
      try {
        await browser.refreshSession()
      } catch (error) {
        auth.send({ type: "expired" })
        throw error
      }
    },
    token: browser.getToken,
  }
}

export function startBrowserAuth(adapter: BrowserAuthAdapter): Promise<void> {
  return adapter.initialize({ apiOrigin: apiOrigin(), appOrigin: appOrigin(), issuesSessions: serverIssuesSessions() })
}
