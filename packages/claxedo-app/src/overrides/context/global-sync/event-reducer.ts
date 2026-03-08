// Re-export upstream applyGlobalEvent and cleanupDroppedSessionCaches unchanged
export { applyGlobalEvent, cleanupDroppedSessionCaches } from "../../../../../app/src/context/global-sync/event-reducer"

// Re-export upstream applyDirectoryEvent, extended with process event pass-through cases.
// ProcessPaneProvider subscribes to SSE events directly via useGlobalSDK().event.listen(),
// so the reducer just needs to recognize these event types (no store updates needed here).
//
// RECONCILIATION NOTE: This file overrides the upstream event-reducer. When upstream
// adds new event types, they are handled by the `default` case (falls through to
// upstreamApplyDirectoryEvent). Only process.* events need explicit listing here.
// If upstream refactors the applyDirectoryEvent signature, this override must be updated.

import { applyDirectoryEvent as upstreamApplyDirectoryEvent } from "../../../../../app/src/context/global-sync/event-reducer"
import type { SetStoreFunction, Store } from "solid-js/store"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import type { State, VcsCache } from "@/context/global-sync/types"

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  vcsCache?: VcsCache
}) {
  switch (input.event.type) {
    case "process.status":
    case "process.started":
    case "process.stopped":
    case "process.crashed":
    case "process.config.changed":
      // Handled by ProcessPaneProvider via direct SSE subscription
      break
    default:
      upstreamApplyDirectoryEvent(input)
      break
  }
}
