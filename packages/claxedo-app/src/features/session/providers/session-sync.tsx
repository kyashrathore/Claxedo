import { createContext, useContext, type ParentProps } from "solid-js"

export type SessionSync = {
  syncSession?: (sessionID: string) => void | Promise<void>
}

const SessionSyncContext = createContext<SessionSync | null>(null)

export function SessionSyncProvider(props: ParentProps<SessionSync>) {
  return <SessionSyncContext value={{ syncSession: props.syncSession }}>{props.children}</SessionSyncContext>
}

export function useSessionSyncOptional() {
  return useContext(SessionSyncContext) ?? undefined
}
