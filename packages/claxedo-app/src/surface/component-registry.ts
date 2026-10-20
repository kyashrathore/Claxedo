import { batch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { SurfaceComponent } from "@claxedo/plugin-api/surface"
import type { SurfaceComponents } from "./model"

export function createComponentRegistry(): SurfaceComponents {
  const [byId, setById] = createStore<Record<string, SurfaceComponent>>({})
  return {
    get: (id) => byId[id],
    upsert: (components) =>
      batch(() => {
        for (const component of components) setById(component.id, reconcile(component, { merge: true }))
      }),
    clear: () => setById(reconcile({})),
  }
}
