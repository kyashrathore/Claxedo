import { createContext, useContext, type ParentProps } from "solid-js"
import { useServer } from "@/server"
import type { SessionStores } from "@/session"
import { createSessionStores } from "./stores"

const SessionStoresContext = createContext<SessionStores>()

export function SessionStoresProvider(props: ParentProps) {
  const stores = createSessionStores(useServer())
  return <SessionStoresContext.Provider value={stores}>{props.children}</SessionStoresContext.Provider>
}

export function useSessionStores(): SessionStores {
  const stores = useContext(SessionStoresContext)
  if (!stores) throw new Error("useSessionStores needs a SessionStoresProvider above it")
  return stores
}
