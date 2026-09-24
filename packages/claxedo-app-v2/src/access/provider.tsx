import { createContext, useContext, type ParentProps } from "solid-js"
import { useServer } from "@/server"
import { createAccess, type AccessStore } from "./store"

const AccessContext = createContext<AccessStore>()

export function AccessProvider(props: ParentProps) {
  const store = createAccess(useServer())
  return <AccessContext.Provider value={store}>{props.children}</AccessContext.Provider>
}

export function useAccess(): AccessStore {
  const store = useContext(AccessContext)
  if (!store) throw new Error("useAccess needs an AccessProvider above it")
  return store
}
