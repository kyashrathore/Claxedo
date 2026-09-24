import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import type { ConnectionState } from "@/server"
import { dictionary } from "../i18n"

export function ConnectionBanner(): JSX.Element {
  const server = useServer()
  const t = useTranslator(dictionary)
  const message = (state: ConnectionState): string | undefined => {
    switch (state.kind) {
      case "connected":
        return undefined
      case "connecting":
        return t("shell.connecting")
      case "reconnecting":
        return t("shell.reconnecting", { attempt: state.attempt })
      case "offline":
        return t("shell.offline", { reason: state.reason })
    }
  }
  return (
    <Show when={message(server.connection())}>
      {(text) => (
        <div class="shell-connection" role="status" data-kind={server.connection().kind}>
          {text()}
        </div>
      )}
    </Show>
  )
}
