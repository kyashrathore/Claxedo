export {
  SURFACE_BADGE_TONES,
  SURFACE_CATALOG_ID,
  SURFACE_ICON_NAMES,
  dataBindingSchema,
  surfaceActionSchema,
  surfaceComponentSchema,
} from "./catalog"
export type {
  SurfaceActionDefinition,
  SurfaceChildList,
  SurfaceComponent,
  SurfaceComponentName,
  SurfaceDataBinding,
  SurfaceDynamicValue,
} from "./catalog"
export {
  SURFACE_MAX_COMPONENTS,
  SURFACE_PROTOCOL_VERSION,
  surfaceActionEventSchema,
  surfaceMessageSchema,
  surfaceMessageSurfaceId,
} from "./messages"
export type { SurfaceActionEvent, SurfaceMessage } from "./messages"
export { SURFACE_ROOT_ID, checkSurfaceSpec, componentReferences, surfaceSpecMessages, surfaceSpecSchema } from "./spec"
export type { SurfaceCheck, SurfaceIssue, SurfaceSpec } from "./spec"
export { SURFACE_DESIGN_GUIDE } from "./design-guide"
