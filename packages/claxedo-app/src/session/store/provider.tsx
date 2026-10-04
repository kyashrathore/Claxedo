import { createContext, useContext, type ParentProps } from "solid-js"
import { useServer } from "@/server"
import { usePreferences } from "@/settings"
import type { SessionStores } from "@/session"
import { createSessionStores } from "./stores"

const SessionStoresContext = createContext<SessionStores>()

export function SessionStoresProvider(props: ParentProps) {
  const preferences = usePreferences()
  const stores = createSessionStores(
    useServer(),
    () => ({
      reasoning: preferences.transcript.showReasoningSummaries,
      shell: preferences.transcript.shellToolPartsExpanded,
      edit: preferences.transcript.editToolPartsExpanded,
    }),
    { showSettled: () => preferences.sidebar.showSettled, activityShown: () => preferences.sidebar.view === "activity" },
  )
  return <SessionStoresContext.Provider value={stores}>{props.children}</SessionStoresContext.Provider>
}

export function useSessionStores(): SessionStores {
  const stores = useContext(SessionStoresContext)
  if (!stores) throw new Error("useSessionStores needs a SessionStoresProvider above it")
  return stores
}
