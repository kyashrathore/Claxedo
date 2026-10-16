import { Match, Switch, type Accessor } from "solid-js"
import type { HarnessSelectionSnapshot } from "../harness/controller"
import { connectionBadge, type ConnectionBadge } from "./harness-trigger"

type ConnectionStateBadge = Exclude<ConnectionBadge, "polling">

const STATE_WORDS: Readonly<Record<ConnectionStateBadge, { text: string; title: string }>> = {
  ready: { text: "Connected", title: "ACP handshake completed. Authentication is checked by the agent when needed." },
  configured: { text: "Configured", title: "Configured; no active agent connection has completed a handshake." },
  connecting: { text: "Connecting", title: "Waiting for the agent handshake." },
}

export function HarnessConnectionBadge(props: { selection: Accessor<HarnessSelectionSnapshot>; polling: Accessor<boolean>; asleep: Accessor<boolean> }) {
  const badge = () => connectionBadge({ polling: props.polling(), asleep: props.asleep(), state: props.selection().connectionState?.state })
  const stateBadge = (): ConnectionStateBadge | undefined => {
    const current = badge()
    return current === "polling" ? undefined : current
  }
  return (
    <Switch>
      <Match when={badge() === "polling"}>
        <span class="text-11-regular text-text-weak px-1.5 flex items-center" title="Connecting to agent runtime...">
          <span class="inline-block w-2 h-2 rounded-full bg-text-weak animate-pulse mr-1" />
          Connecting
        </span>
      </Match>
      <Match when={stateBadge()}>
        {(state) => (
          <span class="text-11-regular text-text-weak px-1.5 flex items-center" data-connection-state={state()} title={STATE_WORDS[state()].title}>
            {STATE_WORDS[state()].text}
          </span>
        )}
      </Match>
    </Switch>
  )
}
