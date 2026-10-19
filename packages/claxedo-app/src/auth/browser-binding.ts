import { onCleanup, untrack } from "solid-js"
import type { AccountBinding, AccountSession } from "./binding"
import type { BrowserAuthAdapter } from "./browser-auth"
import { watchOtherTabIdentity } from "./persistence"
import { apiOrigin, appOrigin, serverIssuesSessions } from "./origins"

function startBrowserAuth(adapter: BrowserAuthAdapter) {
  adapter
    .initialize({ apiOrigin: apiOrigin(), appOrigin: appOrigin(), issuesSessions: serverIssuesSessions() })
    .catch((error: unknown) => console.error("Browser sign-in could not start", { error }))
}

export function browserAccountBinding(adapter: BrowserAuthAdapter): AccountBinding {
  return {
    open: (): AccountSession => {
      const browser = adapter.useAuth()
      startBrowserAuth(adapter)
      onCleanup(watchOtherTabIdentity((userId) => {
        const current = untrack(browser.user)?.id
        if (current && userId !== current) window.location.reload()
      }))
      return {
        methods: browser.methods,
        user: browser.user,
        loading: browser.loading,
        unavailable: browser.unavailable,
        ended: () => false,
        identityResolving: () => false,
        offered: (serverIssuesSessions) => serverIssuesSessions && browser.unavailable() === null,
        signIn: browser.signIn,
        signUp: browser.signUp,
        signOut: browser.signOut,
        refresh: browser.refreshSession,
        controlPlane: { kind: "cookie" },
      }
    },
  }
}
