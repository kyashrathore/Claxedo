import type { AccountBinding, AccountSession } from "./binding"
import type { BrowserAuthAdapter } from "./browser-auth"
import { apiOrigin, appOrigin, serverIssuesSessions } from "./origins"

function start(adapter: BrowserAuthAdapter) {
  adapter
    .initialize({ apiOrigin: apiOrigin(), appOrigin: appOrigin(), issuesSessions: serverIssuesSessions() })
    .catch((error: unknown) => console.error("Browser sign-in could not start", { error }))
}

export function browserAccountBinding(adapter: BrowserAuthAdapter): AccountBinding {
  return {
    open: (): AccountSession => {
      const browser = adapter.useAuth()
      start(adapter)
      return {
        methods: browser.methods,
        user: browser.user,
        loading: browser.loading,
        unavailable: browser.unavailable,
        identityResolving: () => false,
        offered: (serverIssuesSessions) => serverIssuesSessions && browser.unavailable() === null,
        signIn: browser.signIn,
        signUp: browser.signUp,
        signOut: browser.signOut,
        refresh: browser.refreshSession,
        controlPlane: { kind: "bearer", token: browser.getToken },
      }
    },
  }
}
