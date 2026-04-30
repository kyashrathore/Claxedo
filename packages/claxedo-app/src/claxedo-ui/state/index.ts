// Public exports for the Claxedo state layer.

// Types
export type {
  ClaxedoState,
  ContentMeta,
  ContentType,
  ContentScope,
  ContentPayload,
} from "./types"
export {
  isGlobalContent,
  realDirectory,
  contentScopeDir,
} from "./types"
export {
  sessionRoute,
} from "./surface-route"

// Provider + hook.
export { ClaxedoStateProvider, useClaxedoState } from "./provider"
export type { ClaxedoStateApi, ClaxedoStateProviderProps } from "./provider"
