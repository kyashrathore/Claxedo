import { createContext, useContext, type ParentProps } from "solid-js"
import type { BrowserAuthAdapter } from "./browser-auth"
import { createAuth, type Auth } from "./store"

const AuthContext = createContext<Auth>()

export function AuthProvider(props: ParentProps<{ readonly adapter: BrowserAuthAdapter }>) {
  const auth = createAuth(props.adapter)
  return <AuthContext.Provider value={auth}>{props.children}</AuthContext.Provider>
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error("useAuth needs an AuthProvider above it")
  return auth
}
