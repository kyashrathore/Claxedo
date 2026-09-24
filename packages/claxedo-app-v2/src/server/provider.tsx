import { onCleanup, type ParentProps } from "solid-js"
import { ServerContext } from "./context"
import type { Server } from "./index"
import type { ServerHandle } from "./server"

export function ServerProvider(props: ParentProps<{ readonly server: Server }>) {
  const handle = props.server as Partial<ServerHandle>
  if (typeof window !== "undefined" && handle.retryConnection) {
    const retry = () => handle.retryConnection?.()
    const visible = () => {
      if (document.visibilityState === "visible") retry()
    }
    window.addEventListener("online", retry)
    document.addEventListener("visibilitychange", visible)
    onCleanup(() => {
      window.removeEventListener("online", retry)
      document.removeEventListener("visibilitychange", visible)
    })
  }
  return <ServerContext.Provider value={props.server}>{props.children}</ServerContext.Provider>
}
