import type { Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { PlacementId } from "@/server"
import { useShellRoute } from "./router"

export type PlacementState<T extends object> = {
  readonly placementId: Accessor<PlacementId | undefined>
  readonly current: () => T
  readonly write: (update: (previous: T) => T) => void
}

export function createPlacementState<T extends object>(empty: T): PlacementState<T> {
  const placementId = useShellRoute().placementId
  const [state, setState] = createStore<Record<string, T>>({})
  const current = (): T => {
    const id = placementId()
    return id === undefined ? empty : (state[id] ?? empty)
  }
  return {
    placementId,
    current,
    write: (update) => {
      const id = placementId()
      if (id !== undefined) setState(id, update(state[id] ?? empty))
    },
  }
}
