import { Show, type Accessor } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"

export function HarnessConnectionBadge(props: { selection: Accessor<HarnessSelectionSnapshot>; polling: Accessor<boolean> }) {
  return (
    <>
      <Show when={!props.polling() && props.selection().connectionState && ["configured", "connecting", "ready"].includes(props.selection().connectionState!.state)}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" data-connection-state={props.selection().connectionState?.state}
          title={props.selection().connectionState?.state === "ready" ? "ACP handshake completed. Authentication is checked by the agent when needed." : props.selection().connectionState?.state === "configured" ? "Configured; no active agent connection has completed a handshake." : "Waiting for the agent handshake."}>
          {props.selection().connectionState?.state === "ready" ? "Connected" : props.selection().connectionState?.state === "configured" ? "Configured" : "Connecting"}
        </span>
      </Show>
      <Show when={props.polling()}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
    </>
  )
}
