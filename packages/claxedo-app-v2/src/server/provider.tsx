import { QueryClientProvider } from "@tanstack/solid-query"
import { onCleanup, type ParentProps } from "solid-js"
import { ServerContext } from "./context"
import type { ServerHandle } from "./server"

export function ServerProvider(props: ParentProps<{ readonly server: ServerHandle }>) {
  const server = props.server
  const visible = () => {
    if (document.visibilityState === "visible") server.retryConnection()
  }
  window.addEventListener("online", server.retryConnection)
  document.addEventListener("visibilitychange", visible)
  onCleanup(() => {
    window.removeEventListener("online", server.retryConnection)
    document.removeEventListener("visibilitychange", visible)
    server.dispose()
  })
  return (
    <ServerContext.Provider value={server}>
      <QueryClientProvider client={server.queryClient}>{props.children}</QueryClientProvider>
    </ServerContext.Provider>
  )
}
