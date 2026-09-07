// Public exports for the Claxedo state layer.

// Types
export type {
  ClaxedoState,
  NavigatorSlice,
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
// Provider + hook.
export { ClaxedoStateProvider, useClaxedoState } from "./provider"
export type { ClaxedoStateApi, ClaxedoStateProviderProps } from "./provider"
export {
  NAVIGATOR_DEFAULT_WIDTH,
  NAVIGATOR_MAX_WIDTH,
  NAVIGATOR_MIN_WIDTH,
} from "./navigator"
export type { NavigatorSliceApi } from "./navigator"
