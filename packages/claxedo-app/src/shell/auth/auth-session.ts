// target layer: auth — the ONLY module allowed to import utils/auth-client's useAuth
import type { Accessor } from "solid-js"
import { useAuth } from "../../utils/auth-client"

export type AuthSessionStatus = "loading" | "anonymous" | "signed"

type ExternalAuth = ReturnType<typeof useAuth>

export type AuthSession = {
  status: Accessor<AuthSessionStatus>
  session: ExternalAuth["session"]
  user: ExternalAuth["user"]
  signIn: ExternalAuth["signIn"]
  signOut: ExternalAuth["signOut"]
  signUp: ExternalAuth["signUp"]
  getToken: ExternalAuth["getToken"]
  refreshSession: ExternalAuth["refreshSession"]
  organization: Accessor<{ id?: string } | null | undefined>
}

export function useAuthSession(): AuthSession {
  const auth = useAuth()
  return {
    status: () => auth.loading() ? "loading" : auth.isSignedIn() ? "signed" : "anonymous",
    session: auth.session,
    user: auth.user,
    signIn: auth.signIn,
    signOut: auth.signOut,
    signUp: auth.signUp,
    getToken: auth.getToken,
    refreshSession: auth.refreshSession,
    organization: () => auth.clerk.organization as { id?: string } | null | undefined,
  }
}
