// Public exports for the new Workbench layout system.
//
// Phase 1: provider/component/hook/reducers/selectors only. No callers wired yet.

export type {
  WorkbenchState,
  Pane,
  SplitTree,
  SplitNode,
  Snapshot,
  Edge,
  KeyMap,
  PaneRect,
} from "./types"
export { WORKBENCH_DRAG_MIME } from "./types"

export { reducers } from "./reducers/index"
export { selectors } from "./selectors"
export { validate } from "./validate"
export { constructWorkbenchState } from "./construct"

export { WorkbenchProvider, useWorkbench } from "./provider"
export type { WorkbenchProviderProps, UseWorkbench } from "./provider"

export { Workbench } from "./workbench"
export type { WorkbenchProps, PaneCtx } from "./workbench"

export { BP_MD, collapsePaneRects, isCollapsedWidth, isNarrowViewport } from "./collapse-projection"

export { workbenchDrag, useDragSource } from "./pointer-drag"
export type { DragSourceKind, DragSourceOptions, DropZone } from "./pointer-drag"
