import { machine, unreachable } from "../lib/machine"
import type { CapabilitiesOwner } from "./capabilities"
import { toAppError } from "./errors"
import type { ConnectionState } from "./events"
import type { EventStreams } from "./streams"
import type { AppError } from "./types"
import type { Workspaces } from "./workspaces"

export type StartupState = { readonly kind: "loading" } | { readonly kind: "ready" } | { readonly kind: "failed"; readonly failure: AppError }
type StartupEvent = { readonly type: "started" } | { readonly type: "succeeded" } | { readonly type: "failed"; readonly failure: AppError }

function transition(_state: StartupState, event: StartupEvent): StartupState {
  switch (event.type) {
    case "started": return { kind: "loading" }
    case "succeeded": return { kind: "ready" }
    case "failed": return { kind: "failed", failure: event.failure }
    default: return unreachable(event)
  }
}

export function createStartup(input: {
  readonly workspaces: Pick<Workspaces, "load">
  readonly streams: Pick<EventStreams, "open" | "retry">
  readonly capabilities: CapabilitiesOwner
  readonly setConnection: (state: ConnectionState) => void
}) {
  const status = machine<StartupState, StartupEvent>({ kind: "loading" }, transition)
  let opened = false
  let pending: Promise<void> | undefined
  const start = () => {
    if (pending) return pending
    status.send({ type: "started" })
    if (!opened) input.setConnection({ kind: "connecting" })
    pending = (async () => {
      try {
        const catalog = await input.workspaces.load()
        if (!opened) input.streams.open(catalog.declaration)
        opened = true
        await input.capabilities.load()
        status.send({ type: "succeeded" })
      } catch (error) {
        const failure = toAppError(error)
        status.send({ type: "failed", failure })
        if (!opened) input.setConnection({ kind: "offline", reason: failure.message })
      }
    })().finally(() => { pending = undefined })
    return pending
  }
  const retry = () => {
    if (status.state().kind !== "ready") return start()
    input.streams.retry()
    return Promise.resolve()
  }
  return { state: status.state, ready: start(), retry }
}
