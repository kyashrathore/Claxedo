import { createContext, useContext, type ParentProps } from "solid-js"
import type { AccountBinding } from "./binding"
import { createAuth, type Auth } from "./store"

const AuthContext = createContext<Auth>()

export function AuthProvider(props: ParentProps<{ readonly binding: AccountBinding }>) {
  const auth = createAuth(props.binding)
  return <AuthContext.Provider value={auth}>{props.children}</AuthContext.Provider>
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error("useAuth needs an AuthProvider above it")
  return auth
}
