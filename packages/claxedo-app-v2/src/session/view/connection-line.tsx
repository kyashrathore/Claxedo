import { Show } from "solid-js"
import { Spinner } from "@/ui"
import { useServer, type ConnectionState } from "@/server"
import { useSessionScreenText } from "./text"

export const showsConnectionLine = (state: ConnectionState): boolean => state.kind === "reconnecting" && state.afterLive

export function SessionConnectionLine() {
  const server = useServer()
  const t = useSessionScreenText()
  const visible = () => showsConnectionLine(server.connection())
  return (
    <div
      role="status"
      aria-live="polite"
      class="flex items-center justify-center gap-2 px-4 py-1 text-13-regular text-text-weak"
      style={{ display: visible() ? undefined : "none" }}
    >
      <Show when={visible()}>
        <Spinner class="size-4" /> {t("sessionScreen.connection.reconnecting")}
      </Show>
    </div>
  )
}
