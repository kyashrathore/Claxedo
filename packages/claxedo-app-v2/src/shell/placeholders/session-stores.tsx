import { createContext, useContext, type JSX } from "solid-js"
import type { Server } from "@/server"
import type { SessionStores, SessionView } from "@/session"

const SessionStoresContext = createContext<SessionStores>()

function placeholderView(ref: SessionView["ref"]): SessionView {
  return {
    ref,
    state: () => ({ kind: "loading" }),
    row: () => undefined,
    status: () => ({ kind: "idle" }),
    messages: () => [],
    parts: () => [],
    requests: () => [],
    todos: () => [],
    diff: () => [],
    hasOlder: () => false,
    loadOlder: async () => undefined,
    send: async () => undefined,
    stop: async () => undefined,
    reply: async () => undefined,
  }
}

export function createPlaceholderSessionStores(_server: Server): SessionStores {
  return {
    list: { state: () => ({ kind: "live" }), rows: () => [], hasMore: () => false, loadMore: async () => undefined },
    open: placeholderView,
  }
}

export function SessionStoresProvider(props: { readonly server: Server; readonly children: JSX.Element }): JSX.Element {
  return <SessionStoresContext.Provider value={createPlaceholderSessionStores(props.server)}>{props.children}</SessionStoresContext.Provider>
}

export function useSessionStores(): SessionStores {
  const stores = useContext(SessionStoresContext)
  if (!stores) throw new Error("useSessionStores needs a SessionStoresProvider above it")
  return stores
}
