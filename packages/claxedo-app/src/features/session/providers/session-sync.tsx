import { createContext, useContext, type ParentProps } from "solid-js"

export type SessionSync = {
  syncSession?: (sessionID: string) => void | Promise<void>
}

const SessionSyncContext = createContext<SessionSync>()

export function SessionSyncProvider(props: ParentProps<SessionSync>) {
  return (
    <SessionSyncContext.Provider value={{ syncSession: props.syncSession }}>
      {props.children}
    </SessionSyncContext.Provider>
  )
}

export function useSessionSyncOptional() {
  return useContext(SessionSyncContext)
}
