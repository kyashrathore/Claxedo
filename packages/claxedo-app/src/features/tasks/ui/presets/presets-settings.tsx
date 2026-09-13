import { useTasksScope } from "../../data/queries"
import { createTasksStore } from "../../store/tasks-store"
import { PresetsView } from "./presets-view"

/**
 * The preset catalog as a Settings section.
 *
 * Its own store: presets are a personal catalog rather than a view of the task
 * list, and nothing the Tasks surface holds is read here. The store is bound to
 * a const because Solid wraps a call expression in a prop getter, so passing it
 * inline would mint a fresh store on every read and lose the open draft.
 */
export function PresetsSettings() {
  const store = createTasksStore()
  const scope = useTasksScope()
  return <PresetsView store={store} scope={scope} />
}
