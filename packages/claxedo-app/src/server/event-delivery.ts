import type { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { createAttentionHistory } from "./attention-history"
import type { ServerConfig } from "./config"
import { createEventIntake } from "./event-intake"
import type { ConnectionState } from "./events"
import type { StatusOwner } from "./status"
import { createEventStreams } from "./streams"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

export function createEventDelivery(input: {
  readonly config: ServerConfig
  readonly transport: Transport
  readonly queryClient: QueryClient
  readonly workspaces: Workspaces
  readonly status: StatusOwner
  readonly account?: HostedAccount
  readonly onState: (state: ConnectionState) => void
}) {
  const intake = createEventIntake({ ...input, serverUrl: input.transport.serverUrl, onShareChanged: () => history.recover(true) })
  const history = createAttentionHistory({ ...input, frame: intake.frame })
  const stopRecovering = intake.subscribe((event) => { if (event.type === "streamGap") history.recover() })
  const streams = createEventStreams({ ...input, onFrame: intake.frame, onGap: intake.gap })
  return {
    intake,
    streams: {
      ...streams,
      open: (...args: Parameters<typeof streams.open>) => { streams.open(...args); history.recover() },
      retry: () => { streams.retry(); history.recover() },
    },
    dispose: () => { stopRecovering(); history.dispose(); intake.dispose() },
  }
}
