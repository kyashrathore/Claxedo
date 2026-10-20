import {
  createDocumentHydration,
  type DocumentHydration,
  type DocumentHydrationOptions,
  type DocumentHydrationScope,
} from "../hydration"

/**
 * One hydration per mounted set of routes, as a runtime mounts it: `current`
 * is the hydration the last `routes` call created, whose documents those
 * routes hydrated.
 */
export function testHydrations() {
  let current: DocumentHydration = createDocumentHydration()
  return {
    routes(options: DocumentHydrationOptions & DocumentHydrationScope = {}) {
      const { workspaceId, authorizeSessionControl, ...hydrationOptions } = options
      current = createDocumentHydration(hydrationOptions)
      return current.routes({
        ...(workspaceId ? { workspaceId } : {}),
        ...(authorizeSessionControl ? { authorizeSessionControl } : {}),
      })
    },
    get current() {
      return current
    },
  }
}
