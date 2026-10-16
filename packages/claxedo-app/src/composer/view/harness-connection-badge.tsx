import { Show, type Accessor } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import { connectionBadge } from "./harness-trigger"

export function HarnessConnectionBadge(props: { selection: Accessor<HarnessSelectionSnapshot>; polling: Accessor<boolean>; asleep: Accessor<boolean> }) {
  const badge = () => connectionBadge({ polling: props.polling(), asleep: props.asleep(), state: props.selection().connectionState?.state })
  return (
    <>
      <Show when={badge() !== undefined && badge() !== "polling"}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" data-connection-state={badge()}
          title={badge() === "ready" ? "ACP handshake completed. Authentication is checked by the agent when needed." : badge() === "configured" ? "Configured; no active agent connection has completed a handshake." : "Waiting for the agent handshake."}>
          {badge() === "ready" ? "Connected" : badge() === "configured" ? "Configured" : "Connecting"}
        </span>
      </Show>
      <Show when={badge() === "polling"}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Show>
    </>
  )
}
